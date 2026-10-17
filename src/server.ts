import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { classroom_v1 } from "@googleapis/classroom";
import { createClients, driveIdsFromMaterials, dueAt, listAnnouncements, listCourses, listCoursesPage, listCourseWork, listMaterials, listMySubmissions, listTopics, type ClassroomClients } from "./classroom.js";
import { mapAnnouncement, mapCourse, mapCoursework, mapMaterial, mapSubmission, mapTopic, publicError } from "./public/mappers.js";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const publicAuthMeta = { securitySchemes: [{ type: "oauth2", scopes: ["mcp:tools"] }] };
// Google Classroom is an independently operated external service. Mark that
// boundary explicitly even though each user grant remains confined to their account.
const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
type ListHandler = (request: unknown, extra: unknown) => Promise<{ tools: Array<Record<string, unknown>> }> | { tools: Array<Record<string, unknown>> };

/** SDK 1.31 emits tool auth only in _meta; expose the documented top-level field too. */
function exposePublicToolSecuritySchemes(mcp: McpServer) {
  const handlers = (mcp.server as unknown as { _requestHandlers: Map<string, ListHandler> })._requestHandlers;
  const original = handlers.get("tools/list");
  if (!original) throw new Error("MCP tool listing handler unavailable.");
  mcp.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await original(request, extra);
    return {
      ...result,
      tools: result.tools.map((tool) => ({ ...tool, securitySchemes: publicAuthMeta.securitySchemes })),
    } as never;
  });
}
const normalize = (value: string) => value.toLocaleLowerCase().normalize("NFKC");
const contains = (value: unknown, query: string) => normalize(JSON.stringify(value)).includes(normalize(query));

async function courseBundle(clients: ClassroomClients, courseId: string, includeSubmissions = true) {
  const [course, announcements, coursework, materials, topics, submissions] = await Promise.all([
    clients.classroom.courses.get({ id: courseId }).then((r) => r.data),
    listAnnouncements(clients, courseId), listCourseWork(clients, courseId), listMaterials(clients, courseId), listTopics(clients, courseId), includeSubmissions ? listMySubmissions(clients, courseId) : Promise.resolve([]),
  ]);
  return { course, announcements, coursework, materials, topics, submissions };
}

function attachmentIds(bundle: Awaited<ReturnType<typeof courseBundle>>): Set<string> {
  const ids = new Set<string>();
  for (const item of [...bundle.announcements, ...bundle.coursework, ...bundle.materials]) {
    driveIdsFromMaterials(item.materials).forEach((id) => ids.add(id));
  }
  for (const set of bundle.course.courseMaterialSets ?? []) {
    for (const material of set.materials ?? []) {
      const id = material.driveFile?.id;
      if (id) ids.add(id);
    }
  }
  for (const submission of bundle.submissions) {
    for (const attachment of submission.assignmentSubmission?.attachments ?? []) {
      const id = attachment.driveFile?.id;
      if (id) ids.add(id);
    }
  }
  return ids;
}

async function publicResult<T>(action: () => Promise<T>) {
  try { return json(await action()); }
  catch (error) { return publicFailure(error); }
}
const publicFailure = (error: unknown) => ({ isError: true, content: [{ type: "text" as const, text: publicError(error) }] });

export async function createServer(clients: ClassroomClients, options: { publicV1?: boolean; existingServer?: McpServer } = {}): Promise<McpServer> {
  const publicV1 = options.publicV1 === true;
  if (publicV1) clients.publicPageLimit = 1;
  const server = options.existingServer ?? new McpServer({ name: "gpt-google-classroom", version: "1.0.0" }, {
    instructions: publicV1
      ? "Read-only access to the authenticated user's Google Classroom. Public V1 has no Google Drive access; attachment metadata may be available, but attachment contents cannot be read. Never substitute unrelated web information for unavailable teacher content."
      : "Read-only access to the user's Google Classroom and Classroom-linked Drive files. Never claim a mutation is possible; this server exposes no write tools. Prefer specific course IDs returned by list_courses.",
  });

  server.registerTool("list_courses", { description: publicV1 ? "List up to 100 active or archived Google Classroom courses visible to the connected student; pass nextPageToken to continue." : "List the student's active (or archived) Google Classroom courses.", inputSchema: { includeArchived: z.boolean().describe("Include archived courses when true.").default(false), pageToken: z.string().describe("Continuation token from a previous list_courses result.").optional() }, _meta: publicV1 ? publicAuthMeta : undefined, annotations: readOnlyAnnotations },
    async ({ includeArchived, pageToken }) => publicV1
      ? publicResult(async () => { const page = await listCoursesPage(clients, includeArchived, pageToken); return { courses: page.courses.map(mapCourse), nextPageToken: page.nextPageToken }; })
      : json(await listCourses(clients, includeArchived)));

  server.registerTool("get_course", { description: publicV1 ? "Get essential details for one Google Classroom course visible to the connected student." : "Get one course and its full Classroom metadata.", inputSchema: { courseId: z.string().min(1).describe("Google Classroom course ID returned by list_courses.") }, _meta: publicV1 ? publicAuthMeta : undefined, annotations: readOnlyAnnotations },
    async ({ courseId }) => publicV1
      ? publicResult(async () => mapCourse((await clients.classroom.courses.get({ id: courseId })).data))
      : json((await clients.classroom.courses.get({ id: courseId })).data));

  server.registerTool("list_announcements", { description: "List published announcements for one Google Classroom course, newest first.", inputSchema: { courseId: z.string().min(1).describe("Google Classroom course ID returned by list_courses."), limit: z.number().int().min(1).max(100).describe("Maximum announcements to return, from 1 to 100.").default(20) }, _meta: publicV1 ? publicAuthMeta : undefined, annotations: readOnlyAnnotations },
    async ({ courseId, limit }) => publicV1
      ? publicResult(async () => (await listAnnouncements(clients, courseId)).sort((a, b) => String(b.updateTime).localeCompare(String(a.updateTime))).slice(0, limit).map(mapAnnouncement))
      : json((await listAnnouncements(clients, courseId)).sort((a, b) => String(b.updateTime).localeCompare(String(a.updateTime))).slice(0, limit)));

  server.registerTool("list_topics", { description: "List all topics in one Google Classroom course.", inputSchema: { courseId: z.string().min(1).describe("Google Classroom course ID returned by list_courses.") }, _meta: publicV1 ? publicAuthMeta : undefined, annotations: readOnlyAnnotations },
    async ({ courseId }) => publicV1 ? publicResult(async () => (await listTopics(clients, courseId)).map(mapTopic)) : json(await listTopics(clients, courseId)));

  server.registerTool("list_coursework", { description: publicV1 ? "List published assignments and questions for one course with concise descriptions, due dates, and attachment references. Attachment bodies are not read." : "List published assignments and questions with complete descriptions and attached-material metadata.", inputSchema: { courseId: z.string().min(1).describe("Google Classroom course ID returned by list_courses.") }, _meta: publicV1 ? publicAuthMeta : undefined, annotations: readOnlyAnnotations },
    async ({ courseId }) => publicV1 ? publicResult(async () => (await listCourseWork(clients, courseId)).map(mapCoursework)) : json(await listCourseWork(clients, courseId)));

  server.registerTool("get_coursework", { description: publicV1 ? "Retrieve available read-only details for one assignment or question in a course. Attachment bodies are not read." : "Retrieve one assignment/question in full by Classroom coursework ID.", inputSchema: { courseId: z.string().min(1).describe("Google Classroom course ID returned by list_courses."), courseWorkId: z.string().min(1).describe("Coursework ID returned by list_coursework.") }, _meta: publicV1 ? publicAuthMeta : undefined, annotations: readOnlyAnnotations },
    async ({ courseId, courseWorkId }) => publicV1
      ? publicResult(async () => mapCoursework((await clients.classroom.courses.courseWork.get({ courseId, id: courseWorkId })).data))
      : json((await clients.classroom.courses.courseWork.get({ courseId, id: courseWorkId })).data));

  server.registerTool("list_course_materials", { description: publicV1 ? "List published course materials for one course with concise descriptions and attachment references. File bodies are unavailable." : "List published course materials with complete descriptions and attachments.", inputSchema: { courseId: z.string().min(1).describe("Google Classroom course ID returned by list_courses.") }, _meta: publicV1 ? publicAuthMeta : undefined, annotations: readOnlyAnnotations },
    async ({ courseId }) => publicV1 ? publicResult(async () => (await listMaterials(clients, courseId)).map(mapMaterial)) : json(await listMaterials(clients, courseId)));

  server.registerTool("my_submissions", { description: publicV1 ? "Get only the connected student's submission states and grades for one course or coursework item." : "Get only the authenticated student's own submission states, grades, answers, and attachment metadata.", inputSchema: { courseId: z.string().min(1).describe("Google Classroom course ID returned by list_courses."), courseWorkId: z.string().describe("Coursework ID returned by list_coursework, or '-' for all visible coursework in the course.").default("-") }, _meta: publicV1 ? publicAuthMeta : undefined, annotations: readOnlyAnnotations },
    async ({ courseId, courseWorkId }) => publicV1 ? publicResult(async () => (await listMySubmissions(clients, courseId, courseWorkId)).map(mapSubmission)) : json(await listMySubmissions(clients, courseId, courseWorkId)));

  if (!publicV1) {
    server.registerTool("read_drive_attachment", { description: "Extract text from a Classroom-linked Google Doc, Slides, PDF, PPTX, or text file. The file must be attached in the specified course.", inputSchema: { courseId: z.string().min(1).describe("Google Classroom course ID."), fileId: z.string().min(1).describe("Google Drive file ID from a Classroom attachment.") }, _meta: publicV1 ? publicAuthMeta : undefined, annotations: readOnlyAnnotations },
      async ({ courseId, fileId }) => {
        const bundle = await courseBundle(clients, courseId);
        if (!attachmentIds(bundle).has(fileId)) throw new Error("Refusing access: this Drive file was not found among the course's Classroom attachments.");
        const { extractDriveText } = await import("./drive.js");
        return json(await extractDriveText(clients.drive, fileId));
      });
  }

  server.registerTool("search_classroom", { description: "Search visible Classroom course names, topics, assignments, announcements, and material metadata. Public results scan five courses per page and may omit older items; pass nextCoursePageToken to continue.", inputSchema: { query: z.string().min(1).max(200).describe("Search text, 1 to 200 characters."), courseId: z.string().describe("Optional course ID to search within a single course. Do not combine with coursePageToken.").optional(), coursePageToken: z.string().describe("Continuation token for scanning additional courses. Do not combine with courseId.").optional() }, _meta: publicV1 ? publicAuthMeta : undefined, annotations: readOnlyAnnotations },
    async ({ query, courseId, coursePageToken }) => {
      try {
       if (courseId && coursePageToken) throw new Error("Choose a course ID or a course page token, not both.");
       const coursePage = courseId ? { courses: [(await clients.classroom.courses.get({ id: courseId })).data], nextPageToken: undefined }
         : publicV1 ? await listCoursesPage(clients, true, coursePageToken, 5)
         : { courses: await listCourses(clients, true), nextPageToken: undefined };
       const courses = coursePage.courses;
      const matches: unknown[] = [];
      for (const course of courses) {
        if (!course.id) continue;
        const publicCourse = mapCourse(course);
        if (contains(publicV1 ? publicCourse : course, query)) matches.push({ type: "course", course: publicV1 ? publicCourse : course });
         const bundle = await courseBundle(clients, course.id, !publicV1);
        const groups = [
          ["topic", bundle.topics, mapTopic], ["announcement", bundle.announcements, mapAnnouncement],
          ["coursework", bundle.coursework, mapCoursework], ["material", bundle.materials, mapMaterial],
        ] as const;
        for (const [type, items, mapper] of groups) {
          for (const item of items) {
            const output = publicV1 ? mapper(item as never) : item;
            if (contains(output, query)) matches.push({ type, courseId: course.id, courseName: publicV1 ? publicCourse.name : course.name, item: output });
          }
        }
      }
       return publicV1 ? json({ query, count: matches.length, partial: true, scannedCourses: courses.length, nextCoursePageToken: coursePage.nextPageToken, matches: matches.slice(0, 100) }) : json({ query, count: matches.length, matches });
      } catch (error) { if (publicV1) return publicFailure(error); throw error; }
    });

  server.registerTool("upcoming_deadlines", { description: "Show future coursework deadlines across five active courses per page; pass nextCoursePageToken to continue. Older coursework may be omitted.", inputSchema: { days: z.number().int().min(1).max(365).describe("Lookahead window in days, from 1 to 365.").default(30), coursePageToken: z.string().describe("Continuation token for scanning additional active courses.").optional() }, _meta: publicV1 ? publicAuthMeta : undefined, annotations: readOnlyAnnotations },
    async ({ days, coursePageToken }) => {
      try {
      const now = Date.now(); const until = now + days * 86400000; const result: unknown[] = [];
       const coursePage = publicV1 ? await listCoursesPage(clients, false, coursePageToken, 5) : { courses: await listCourses(clients), nextPageToken: undefined };
       for (const course of coursePage.courses) {
        if (!course.id) continue;
        for (const work of await listCourseWork(clients, course.id)) {
          const due = dueAt(work); const time = due ? Date.parse(due) : NaN;
          if (time >= now && time <= until) result.push({ courseId: course.id, courseName: publicV1 ? mapCourse(course).name : course.name, due, coursework: publicV1 ? mapCoursework(work) : work });
        }
      }
      result.sort((a, b) => String((a as { due: string }).due).localeCompare(String((b as { due: string }).due)));
       return publicV1 ? json({ count: result.length, partial: true, nextCoursePageToken: coursePage.nextPageToken, deadlines: result.slice(0, 100) }) : json(result);
      } catch (error) { if (publicV1) return publicFailure(error); throw error; }
    });

  server.registerTool("recent_activity", { description: "Show recent announcements, coursework, and materials across five active courses per page; pass nextCoursePageToken to continue. Older items may be omitted.", inputSchema: { days: z.number().int().min(1).max(365).describe("Lookback window in days, from 1 to 365.").default(14), limit: z.number().int().min(1).max(200).describe("Maximum activity items to return, from 1 to 200.").default(50), coursePageToken: z.string().describe("Continuation token for scanning additional active courses.").optional() }, _meta: publicV1 ? publicAuthMeta : undefined, annotations: readOnlyAnnotations },
    async ({ days, limit, coursePageToken }) => {
      try {
      const since = Date.now() - days * 86400000; const activity: Array<{ updated: string; type: string; courseId: string; courseName?: string | null; item: unknown }> = [];
       const coursePage = publicV1 ? await listCoursesPage(clients, false, coursePageToken, 5) : { courses: await listCourses(clients), nextPageToken: undefined };
       for (const course of coursePage.courses) {
        if (!course.id) continue;
         const bundle = await courseBundle(clients, course.id, !publicV1);
        for (const [type, items] of Object.entries({ announcement: bundle.announcements, coursework: bundle.coursework, material: bundle.materials })) {
          for (const item of items) {
            const updated = item.updateTime ?? item.creationTime;
            if (updated && Date.parse(updated) >= since) activity.push({ updated, type, courseId: course.id, courseName: publicV1 ? mapCourse(course).name : course.name, item: publicV1 ? (type === "announcement" ? mapAnnouncement(item as classroom_v1.Schema$Announcement) : type === "coursework" ? mapCoursework(item as classroom_v1.Schema$CourseWork) : mapMaterial(item as classroom_v1.Schema$CourseWorkMaterial)) : item });
          }
        }
      }
       return publicV1 ? json({ partial: true, nextCoursePageToken: coursePage.nextPageToken, activity: activity.sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, limit) }) : json(activity.sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, limit));
      } catch (error) { if (publicV1) return publicFailure(error); throw error; }
    });
  if (publicV1) exposePublicToolSecuritySchemes(server);
  return server;
}

export async function runServer(): Promise<void> {
  const [{ loadSavedAuth }, { StdioServerTransport }] = await Promise.all([
    import("./auth.js"), import("@modelcontextprotocol/sdk/server/stdio.js"),
  ]);
  const auth = await loadSavedAuth();
  const server = await createServer(createClients(auth));
  await server.connect(new StdioServerTransport());
}

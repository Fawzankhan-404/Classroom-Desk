import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTeacherCourseworkDraft, getTeacherCoursework, getTeacherCourseworkDrafts, getTeacherOverview, getTeacherRoster, getTeacherSubmissions, listVerifiedTeacherCourses, updateTeacherCourseworkDraft } from "./teacher.js";
import { createV2BetaServer } from "./server.js";
import { V2_TEACHER_COURSEWORK_WRITE_SCOPE, V2_TEACHER_REQUIRED_SCOPES } from "./scopes.js";

function fixture(overrides: Record<string, unknown> = {}) {
  const teacherGet = vi.fn(async () => ({ data: { userId: "me" } }));
  const studentsList = vi.fn(async () => ({ data: { students: [{ userId: "student-1", profile: { name: { fullName: "Synthetic Student" }, emailAddress: "private@example.test", photoUrl: "https://images.example.test/private-avatar" } }] } }));
  const submissionsList = vi.fn(async () => ({ data: { studentSubmissions: [{ userId: "student-1", state: "TURNED_IN", assignedGrade: 8, updateTime: "2026-10-18T10:00:00Z" }] } }));
  const courseworkList = vi.fn(async () => ({ data: { courseWork: [{ id: "draft-1", courseId: "course-1", title: "Draft assignment", state: "DRAFT", workType: "ASSIGNMENT", updateTime: "2026-10-18T10:00:00Z" }] } }));
  const courseworkCreate = vi.fn(async ({ courseId, requestBody }: { courseId: string; requestBody: Record<string, unknown> }) => ({ data: { id: "draft-created", courseId, ...requestBody, associatedWithDeveloper: true } }));
  const courseworkGet = vi.fn(async () => ({ data: { id: "draft-1", courseId: "course-1", title: "Draft assignment", state: "DRAFT", workType: "ASSIGNMENT", associatedWithDeveloper: true, maxPoints: 10, updateTime: "2026-10-18T10:00:00Z" } }));
  const courseworkPatch = vi.fn(async () => ({ data: {} }));
  const grantedScopes = [...V2_TEACHER_REQUIRED_SCOPES, "https://www.googleapis.com/auth/classroom.courses.readonly"];
  const coursesList = vi.fn(async () => ({ data: { courses: [{ id: "course-1", name: "Real course response" }] } }));
  const clients = {
    teacherEntitled: true,
    grantedScopes,
    classroom: {
      courses: {
        list: coursesList,
        teachers: { get: teacherGet },
        students: { list: studentsList },
        courseWork: {
          get: courseworkGet,
          list: courseworkList,
          create: courseworkCreate,
          patch: courseworkPatch,
          studentSubmissions: { list: submissionsList },
        },
      },
    },
    ...overrides,
  };
  return { clients: clients as never, teacherGet, coursesList, studentsList, submissionsList, courseworkList, courseworkCreate, courseworkGet, courseworkPatch, grantedScopes };
}

describe("Google-authorized teacher reads", () => {
  it("projects only student names in the MCP roster response", async () => {
    const f = fixture();
    const server = createV2BetaServer(f.clients);
    const client = new Client({ name: "teacher-roster-contract", version: "1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      const result = await client.callTool({ name: "teacher_course_roster", arguments: { courseId: "course-1" } });
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      expect(JSON.parse(text)).toEqual({ students: [{ fullName: "Synthetic Student" }], moreAvailable: false, complete: true });
      expect(text).not.toContain("student-1");
      expect(text).not.toContain("private@example.test");
      expect(text).not.toContain("private-avatar");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("requires explicit teacher scopes before any roster or teacher-membership API call", async () => {
    const f = fixture({ teacherEntitled: true, grantedScopes: ["https://www.googleapis.com/auth/classroom.courses.readonly"] });
    await expect(listVerifiedTeacherCourses(f.clients)).rejects.toMatchObject({ code: "teacher_authorization_required" });
    expect(f.teacherGet).not.toHaveBeenCalled();
  });

  it("lists courses only when Google verifies current teacher membership", async () => {
    const f = fixture();
    const courses = await listVerifiedTeacherCourses(f.clients);
    expect(courses).toEqual({ courses: [{ id: "course-1", name: "Real course response" }], nextPageToken: undefined });
    expect(f.teacherGet).toHaveBeenCalledWith({ courseId: "course-1", userId: "me" });
  });

  it("returns a bounded teacher-course continuation token without claiming the list is complete", async () => {
    const f = fixture();
    f.coursesList.mockResolvedValueOnce({ data: { courses: [{ id: "course-1", name: "First page" }], nextPageToken: "synthetic-next-page" } });
    const page = await listVerifiedTeacherCourses(f.clients);
    expect(page).toMatchObject({ courses: [{ id: "course-1" }], nextPageToken: "synthetic-next-page" });
    expect(f.coursesList).toHaveBeenCalledWith({ courseStates: ["ACTIVE"], pageSize: 25, pageToken: undefined });
    const next = await listVerifiedTeacherCourses(f.clients, "synthetic-next-page");
    expect(f.coursesList).toHaveBeenLastCalledWith({ courseStates: ["ACTIVE"], pageSize: 25, pageToken: "synthetic-next-page" });
    expect(next.nextPageToken).toBeUndefined();
  });

  it("maps a stale Google credential to a reconnect requirement for teacher reads", async () => {
    const roster = fixture();
    roster.studentsList.mockRejectedValueOnce({ response: { status: 401 } });
    await expect(getTeacherRoster(roster.clients, "course-1")).rejects.toMatchObject({ code: "authorization" });

    const coursework = fixture();
    coursework.courseworkList.mockRejectedValueOnce({ response: { status: 401 } });
    await expect(getTeacherCoursework(coursework.clients, "course-1")).rejects.toMatchObject({ code: "authorization" });

    const submissions = fixture();
    submissions.submissionsList.mockRejectedValueOnce({ response: { status: 401 } });
    await expect(getTeacherSubmissions(submissions.clients, "course-1", "work-1")).rejects.toMatchObject({ code: "authorization" });
  });

  it("maps Google's invalid_grant token-refresh response to a reconnect requirement", async () => {
    const f = fixture();
    f.studentsList.mockRejectedValueOnce({ response: { status: 400, data: { error: "invalid_grant" } } });
    await expect(getTeacherRoster(f.clients, "course-1")).rejects.toMatchObject({ code: "authorization" });
  });

  it("does not turn a 401 during teacher overview reads into empty counts", async () => {
    const f = fixture();
    f.studentsList.mockRejectedValueOnce({ response: { status: 401 } });
    await expect(getTeacherOverview(f.clients)).rejects.toMatchObject({ code: "authorization" });
  });

  it("marks a roster as incomplete when Google returns a next-page token at the result limit", async () => {
    const f = fixture();
    f.studentsList.mockResolvedValueOnce({ data: {
      students: Array.from({ length: 100 }, (_, index) => ({ userId: `student-${index}`, profile: { name: { fullName: `Student ${index}` } } })),
      nextPageToken: "next-page",
    } });
    const result = await getTeacherRoster(f.clients, "course-1");
    expect(result.students).toHaveLength(100);
    expect(result.moreAvailable).toBe(true);
    expect(f.studentsList).toHaveBeenCalledTimes(1);
  });

  it("does not treat an omitted roster payload as a complete empty class or a zero count", async () => {
    const f = fixture();
    f.studentsList.mockResolvedValueOnce({ data: {} } as never);
    const roster = await getTeacherRoster(f.clients, "course-1");
    expect(roster).toMatchObject({ students: [], moreAvailable: false, complete: false });

    const overview = fixture();
    overview.studentsList.mockResolvedValueOnce({ data: {} } as never);
    const result = await getTeacherOverview(overview.clients);
    expect(result.courses[0]).toMatchObject({ studentCount: null, studentCountMoreAvailable: false });
  });

  it("marks coursework and submissions as incomplete when another page exists", async () => {
    const coursework = fixture();
    coursework.courseworkList.mockResolvedValueOnce({ data: {
      courseWork: Array.from({ length: 100 }, (_, index) => ({ id: `work-${index}`, state: "PUBLISHED", workType: "ASSIGNMENT" })),
      nextPageToken: "next-page",
    } });
    const courseworkResult = await getTeacherCoursework(coursework.clients, "course-1");
    expect(courseworkResult.coursework).toHaveLength(100);
    expect(courseworkResult.moreAvailable).toBe(true);
    expect(coursework.courseworkList).toHaveBeenCalledTimes(1);

    const submissions = fixture();
    submissions.submissionsList.mockResolvedValueOnce({ data: {
      studentSubmissions: Array.from({ length: 100 }, (_, index) => ({ userId: `student-${index}`, state: "TURNED_IN" })),
      nextPageToken: "next-page",
    } });
    const submissionResult = await getTeacherSubmissions(submissions.clients, "course-1", "work-1");
    expect(submissionResult.submissions).toHaveLength(100);
    expect(submissionResult.moreAvailable).toBe(true);
    expect(submissionResult.submissionPagesComplete).toBe(false);
    expect(submissionResult.studentRosterMoreAvailable).toBe(false);
    expect(submissions.submissionsList).toHaveBeenCalledTimes(1);
  });

  it("represents omitted submission fields as unknown rather than as negative or submitted state", async () => {
    const f = fixture();
    f.submissionsList.mockResolvedValueOnce({ data: { studentSubmissions: [{ userId: "student-1" }] } } as never);
    const result = await getTeacherSubmissions(f.clients, "course-1", "work-1");
    expect(result.submissions[0]).toMatchObject({
      state: "UNKNOWN",
      lateStatus: "UNKNOWN",
      gradeStatus: "UNKNOWN",
      assignedGrade: null,
      hasAttachments: null,
      attachmentMetadata: null,
    });
    expect(result.submissionPagesComplete).toBe(true);
  });

  it("marks an omitted submission page payload incomplete instead of treating it as a complete empty result", async () => {
    const f = fixture();
    f.submissionsList.mockResolvedValueOnce({ data: {} } as never);
    const result = await getTeacherSubmissions(f.clients, "course-1", "work-1");
    expect(result.submissions).toEqual([]);
    expect(result.moreAvailable).toBe(false);
    expect(result.submissionPagesComplete).toBe(false);
  });

  it("does not read roster or submissions when Google denies teacher membership", async () => {
    const f = fixture();
    f.teacherGet.mockRejectedValueOnce({ response: { status: 403 } });
    await expect(getTeacherSubmissions(f.clients, "course-1", "work-1")).rejects.toMatchObject({ code: "teacher_course_forbidden" });
    expect(f.studentsList).not.toHaveBeenCalled();
    expect(f.submissionsList).not.toHaveBeenCalled();
  });

  it("returns authorized real-response fields while keeping gradebook writes disabled", async () => {
    const f = fixture();
    const result = await getTeacherSubmissions(f.clients, "course-1", "work-1");
    expect(result).toMatchObject({ gradebookWritebackEnabled: false, submissions: [{ studentName: "Synthetic Student", state: "TURNED_IN", assignedGrade: 8 }] });
    expect(JSON.stringify(result)).not.toContain("private@example.test");
  });

  it("returns bounded attachment type and title metadata without file identifiers, URLs, or contents", async () => {
    const f = fixture();
    f.submissionsList.mockResolvedValueOnce({ data: { studentSubmissions: [{
      userId: "student-1",
      state: "TURNED_IN",
      assignmentSubmission: { attachments: [
        { driveFile: { id: "synthetic-private-drive-id", title: "Essay.pdf", alternateLink: "https://drive.example.test/private-file" } },
        { link: { title: "Research link", url: "https://example.test/private-submission-url" } },
        { youTubeVideo: { id: "synthetic-video-id", title: "Presentation video", alternateLink: "https://youtube.example.test/private-video" } },
        { form: { title: "Reflection form", responseUrl: "https://forms.example.test/private-response" } },
      ] },
    }] } } as never);

    const result = await getTeacherSubmissions(f.clients, "course-1", "work-1");
    expect(result).toMatchObject({
      gradebookWritebackEnabled: false,
      submissionContentIncluded: false,
      submissions: [{
        hasAttachments: true,
        attachmentMetadata: {
          count: 4,
          truncated: false,
          items: [
            { kind: "drive_file", title: "Essay.pdf" },
            { kind: "link", title: "Research link" },
            { kind: "youtube_video", title: "Presentation video" },
            { kind: "form", title: "Reflection form" },
          ],
        },
      }],
    });
    const serialized = JSON.stringify(result);
    for (const privateValue of ["synthetic-private-drive-id", "synthetic-video-id", "https://drive.example.test", "https://example.test/private", "https://youtube.example.test", "https://forms.example.test"]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("bounds attachment metadata and reports omitted metadata", async () => {
    const f = fixture();
    f.submissionsList.mockResolvedValueOnce({ data: { studentSubmissions: [{
      userId: "student-1",
      assignmentSubmission: { attachments: Array.from({ length: 12 }, (_, index) => ({ driveFile: { id: `id-${index}`, title: `Document ${index}` } })) },
    }] } } as never);
    const result = await getTeacherSubmissions(f.clients, "course-1", "work-1");
    expect(result.submissions[0]?.attachmentMetadata).toMatchObject({ count: 12, truncated: true });
    expect(result.submissions[0]?.attachmentMetadata.items).toHaveLength(10);
    expect(JSON.stringify(result)).not.toContain('"id"');
  });

  it("exposes the bounded submission metadata through the MCP tool contract", async () => {
    const f = fixture();
    f.submissionsList.mockResolvedValueOnce({ data: { studentSubmissions: [{
      userId: "student-1",
      state: "TURNED_IN",
      assignmentSubmission: { attachments: [{ driveFile: { id: "synthetic-hidden-id", title: "Lab report.pdf", alternateLink: "https://drive.example.test/hidden" } }] },
    }] } } as never);
    const server = createV2BetaServer(f.clients);
    const client = new Client({ name: "teacher-submission-metadata-contract", version: "1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      const result = await client.callTool({ name: "teacher_coursework_submissions", arguments: { courseId: "course-1", courseWorkId: "work-1" } });
      const output = (result.content as Array<{ text: string }>)[0]!.text;
      expect(JSON.parse(output)).toMatchObject({
        submissionContentIncluded: false,
        gradebookWritebackEnabled: false,
        submissionPagesComplete: true,
        submissions: [{ lateStatus: "UNKNOWN", gradeStatus: "UNKNOWN", attachmentMetadata: { count: 1, truncated: false, items: [{ kind: "drive_file", title: "Lab report.pdf" }] } }],
      });
      expect(output).not.toContain("synthetic-hidden-id");
      expect(output).not.toContain("https://drive.example.test");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("requires the explicit coursework write scope before listing drafts or calling Google", async () => {
    const f = fixture();
    await expect(getTeacherCourseworkDrafts(f.clients, "course-1")).rejects.toMatchObject({ code: "teacher_coursework_write_authorization_required" });
    expect(f.teacherGet).not.toHaveBeenCalled();
    expect(f.courseworkList).not.toHaveBeenCalled();
  });

  it("returns only Google-confirmed unpublished assignment drafts", async () => {
    const base = fixture();
    const f = fixture({
      grantedScopes: [...base.grantedScopes, V2_TEACHER_COURSEWORK_WRITE_SCOPE],
    });
    f.courseworkList.mockResolvedValueOnce({ data: { courseWork: [
      { id: "draft-1", courseId: "course-1", title: "Draft assignment", state: "DRAFT", workType: "ASSIGNMENT" },
      { id: "published-1", courseId: "course-1", title: "Published assignment", state: "PUBLISHED", workType: "ASSIGNMENT" },
      { id: "draft-question", courseId: "course-1", title: "Draft question", state: "DRAFT", workType: "SHORT_ANSWER_QUESTION" },
      { courseId: "course-1", title: "Missing identity", state: "DRAFT", workType: "ASSIGNMENT" },
    ] } } as never);
    const result = await getTeacherCourseworkDrafts(f.clients, "course-1");
    expect(f.courseworkList).toHaveBeenCalledWith(expect.objectContaining({ courseId: "course-1", courseWorkStates: ["DRAFT"] }));
    expect(result).toEqual({ drafts: [{ id: "draft-1", title: "Draft assignment", description: null, dueDate: null, dueTime: null, maxPoints: null, updateTime: null, state: "DRAFT" }], moreAvailable: false });
  });

  it("returns draft pagination metadata through the MCP tool", async () => {
    const f = fixture({ grantedScopes: [...fixture().grantedScopes, V2_TEACHER_COURSEWORK_WRITE_SCOPE] });
    const server = createV2BetaServer(f.clients, { teacherDraftWritesEnabled: true });
    const client = new Client({ name: "teacher-drafts-contract", version: "1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      const result = await client.callTool({ name: "teacher_coursework_drafts", arguments: { courseId: "course-1" } });
      expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual({
        drafts: [{ id: "draft-1", title: "Draft assignment", description: null, dueDate: null, dueTime: null, maxPoints: null, updateTime: "2026-10-18T10:00:00Z", state: "DRAFT" }],
        moreAvailable: false,
        published: false,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("requires the explicit write scope before confirmed creation", async () => {
    const f = fixture();
    await expect(createTeacherCourseworkDraft(f.clients, "course-1", { title: "Lab" }, "CREATE_UNPUBLISHED_DRAFT"))
      .rejects.toMatchObject({ code: "teacher_coursework_write_authorization_required" });
    expect(f.courseworkCreate).not.toHaveBeenCalled();
    expect(f.teacherGet).not.toHaveBeenCalled();
  });

  it("creates only a confirmed unpublished assignment draft with an allowlisted body", async () => {
    const f = fixture({ grantedScopes: [...fixture().grantedScopes, V2_TEACHER_COURSEWORK_WRITE_SCOPE] });
    await expect(createTeacherCourseworkDraft(f.clients, "course-1", { title: "Lab 1" }, "")).rejects.toMatchObject({ code: "confirmation_required" });
    expect(f.courseworkCreate).not.toHaveBeenCalled();
    const result = await createTeacherCourseworkDraft(f.clients, "course-1", { title: "  Lab 1  ", description: "Draft only", maxPoints: 10 }, "CREATE_UNPUBLISHED_DRAFT");
    expect(f.courseworkCreate).toHaveBeenCalledWith({ courseId: "course-1", requestBody: { title: "Lab 1", description: "Draft only", maxPoints: 10, state: "DRAFT", workType: "ASSIGNMENT" } });
    expect(result).toMatchObject({ status: "draft_created", courseWorkId: "draft-created", state: "DRAFT", gradebookWritebackEnabled: false });
  });

  it("rejects grade, submission, and published-state fields from draft creation", async () => {
    const f = fixture({ grantedScopes: [...fixture().grantedScopes, V2_TEACHER_COURSEWORK_WRITE_SCOPE] });
    await expect(createTeacherCourseworkDraft(f.clients, "course-1", { title: "Lab", assignedGrade: 10 } as never, "CREATE_UNPUBLISHED_DRAFT")).rejects.toMatchObject({ code: "invalid_coursework_draft" });
    await expect(createTeacherCourseworkDraft(f.clients, "course-1", { title: "Lab", state: "PUBLISHED" } as never, "CREATE_UNPUBLISHED_DRAFT")).rejects.toMatchObject({ code: "invalid_coursework_draft" });
    expect(f.courseworkCreate).not.toHaveBeenCalled();
  });

  it("validates date, time, points, and confirmation without reaching Google", async () => {
    const f = fixture({ grantedScopes: [...fixture().grantedScopes, V2_TEACHER_COURSEWORK_WRITE_SCOPE] });
    for (const input of [
      { title: "" },
      { title: "Lab", dueDate: { year: 2026, month: 2, day: 30 } },
      { title: "Lab", dueTime: { hours: 25, minutes: 0 } },
      { title: "Lab", maxPoints: -1 },
    ]) await expect(createTeacherCourseworkDraft(f.clients, "course-1", input, "CREATE_UNPUBLISHED_DRAFT")).rejects.toMatchObject({ code: "invalid_coursework_draft" });
    expect(f.courseworkCreate).not.toHaveBeenCalled();
  });

  it("requires explicit write scope and confirmation before reading or changing a draft", async () => {
    const noScope = fixture();
    await expect(updateTeacherCourseworkDraft(noScope.clients, "course-1", "draft-1", "2026-10-18T10:00:00Z", { title: "Updated" }, "UPDATE_UNPUBLISHED_DRAFT"))
      .rejects.toMatchObject({ code: "teacher_coursework_write_authorization_required" });
    expect(noScope.teacherGet).not.toHaveBeenCalled();
    expect(noScope.courseworkGet).not.toHaveBeenCalled();
    expect(noScope.courseworkPatch).not.toHaveBeenCalled();

    const authorized = fixture({ grantedScopes: [...fixture().grantedScopes, V2_TEACHER_COURSEWORK_WRITE_SCOPE] });
    await expect(updateTeacherCourseworkDraft(authorized.clients, "course-1", "draft-1", "2026-10-18T10:00:00Z", { title: "Updated" }, ""))
      .rejects.toMatchObject({ code: "confirmation_required" });
    expect(authorized.courseworkPatch).not.toHaveBeenCalled();
    expect(authorized.teacherGet).not.toHaveBeenCalled();
  });

  it("describes the missing draft permission without claiming the connector can edit drafts", async () => {
    const f = fixture();
    await expect(createTeacherCourseworkDraft(f.clients, "course-1", { title: "Lab" }, "CREATE_UNPUBLISHED_DRAFT"))
      .rejects.toMatchObject({
        code: "teacher_coursework_write_authorization_required",
        message: "This draft action needs separate Google coursework-management permission. Classroom Desk does not publish coursework or write grades.",
      });
    expect(f.courseworkCreate).not.toHaveBeenCalled();
    expect(f.courseworkPatch).not.toHaveBeenCalled();
  });

  it("updates only allowlisted fields on a current unpublished assignment draft and verifies the result", async () => {
    const f = fixture({ grantedScopes: [...fixture().grantedScopes, V2_TEACHER_COURSEWORK_WRITE_SCOPE] });
    let current = { id: "draft-1", courseId: "course-1", title: "Draft assignment", state: "DRAFT", workType: "ASSIGNMENT", associatedWithDeveloper: true, maxPoints: 10, updateTime: "2026-10-18T10:00:00Z" };
    f.courseworkGet.mockImplementation(async () => ({ data: current }));
    f.courseworkPatch.mockImplementation(async ({ requestBody }: { requestBody?: Record<string, unknown> }) => {
      current = { ...current, ...requestBody, updateTime: "2026-10-18T11:00:00Z" } as typeof current;
      return { data: current } as never;
    });

    const result = await updateTeacherCourseworkDraft(
      f.clients,
      "course-1",
      "draft-1",
      "2026-10-18T10:00:00Z",
      { title: "  Updated draft  ", maxPoints: 12 },
      "UPDATE_UNPUBLISHED_DRAFT",
    );

    expect(f.teacherGet).toHaveBeenCalledWith({ courseId: "course-1", userId: "me" });
    expect(f.courseworkPatch).toHaveBeenCalledWith({
      courseId: "course-1",
      id: "draft-1",
      updateMask: "title,maxPoints",
      requestBody: { title: "Updated draft", maxPoints: 12 },
    });
    expect(f.courseworkGet).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "draft_updated", courseId: "course-1", courseWorkId: "draft-1", title: "Updated draft", updateTime: "2026-10-18T11:00:00Z", updatedFields: ["title", "maxPoints"], state: "DRAFT", gradebookWritebackEnabled: false });
  });

  it("rejects stale, published, cross-course, and non-assignment records without patching", async () => {
    const makeAuthorized = () => fixture({ grantedScopes: [...fixture().grantedScopes, V2_TEACHER_COURSEWORK_WRITE_SCOPE] });
    const stale = makeAuthorized();
    stale.courseworkGet.mockResolvedValueOnce({ data: { id: "draft-1", courseId: "course-1", state: "DRAFT", workType: "ASSIGNMENT", associatedWithDeveloper: true, updateTime: "2026-10-18T10:01:00Z" } } as never);
    await expect(updateTeacherCourseworkDraft(stale.clients, "course-1", "draft-1", "2026-10-18T10:00:00Z", { title: "Updated" }, "UPDATE_UNPUBLISHED_DRAFT"))
      .rejects.toMatchObject({ code: "teacher_coursework_changed" });
    expect(stale.courseworkPatch).not.toHaveBeenCalled();

    const published = makeAuthorized();
    published.courseworkGet.mockResolvedValueOnce({ data: { id: "draft-1", courseId: "course-1", state: "PUBLISHED", workType: "ASSIGNMENT", updateTime: "2026-10-18T10:00:00Z" } } as never);
    await expect(updateTeacherCourseworkDraft(published.clients, "course-1", "draft-1", "2026-10-18T10:00:00Z", { title: "Updated" }, "UPDATE_UNPUBLISHED_DRAFT"))
      .rejects.toMatchObject({ code: "teacher_coursework_not_draft" });
    expect(published.courseworkPatch).not.toHaveBeenCalled();

    const wrongCourse = makeAuthorized();
    wrongCourse.courseworkGet.mockResolvedValueOnce({ data: { id: "draft-1", courseId: "course-other", state: "DRAFT", workType: "ASSIGNMENT", updateTime: "2026-10-18T10:00:00Z" } } as never);
    await expect(updateTeacherCourseworkDraft(wrongCourse.clients, "course-1", "draft-1", "2026-10-18T10:00:00Z", { title: "Updated" }, "UPDATE_UNPUBLISHED_DRAFT"))
      .rejects.toMatchObject({ code: "invalid_coursework" });
    expect(wrongCourse.courseworkPatch).not.toHaveBeenCalled();

    const question = makeAuthorized();
    question.courseworkGet.mockResolvedValueOnce({ data: { id: "draft-1", courseId: "course-1", state: "DRAFT", workType: "SHORT_ANSWER_QUESTION", updateTime: "2026-10-18T10:00:00Z" } } as never);
    await expect(updateTeacherCourseworkDraft(question.clients, "course-1", "draft-1", "2026-10-18T10:00:00Z", { title: "Updated" }, "UPDATE_UNPUBLISHED_DRAFT"))
      .rejects.toMatchObject({ code: "invalid_coursework" });
    expect(question.courseworkPatch).not.toHaveBeenCalled();
  });

  it("rejects drafts not associated with this Google developer project before patching", async () => {
    const makeAuthorized = () => fixture({ grantedScopes: [...fixture().grantedScopes, V2_TEACHER_COURSEWORK_WRITE_SCOPE] });
    for (const associatedWithDeveloper of [false, undefined]) {
      const f = makeAuthorized();
      f.courseworkGet.mockResolvedValueOnce({ data: {
        id: "draft-1",
        courseId: "course-1",
        state: "DRAFT",
        workType: "ASSIGNMENT",
        ...(associatedWithDeveloper === undefined ? {} : { associatedWithDeveloper }),
        updateTime: "2026-10-18T10:00:00Z",
      } } as never);

      await expect(updateTeacherCourseworkDraft(f.clients, "course-1", "draft-1", "2026-10-18T10:00:00Z", { title: "Updated" }, "UPDATE_UNPUBLISHED_DRAFT"))
        .rejects.toMatchObject({ code: "teacher_coursework_not_associated" });
      expect(f.courseworkPatch).not.toHaveBeenCalled();
    }
  });

  it("confirms developer association with a read when create omits the association field", async () => {
    const f = fixture({ grantedScopes: [...fixture().grantedScopes, V2_TEACHER_COURSEWORK_WRITE_SCOPE] });
    f.courseworkCreate.mockResolvedValueOnce({ data: { id: "draft-created", courseId: "course-1", state: "DRAFT", workType: "ASSIGNMENT" } } as never);
    f.courseworkGet.mockResolvedValueOnce({ data: { id: "draft-created", courseId: "course-1", state: "DRAFT", workType: "ASSIGNMENT", associatedWithDeveloper: true } } as never);

    await expect(createTeacherCourseworkDraft(f.clients, "course-1", { title: "Lab" }, "CREATE_UNPUBLISHED_DRAFT"))
      .resolves.toMatchObject({ status: "draft_created", courseWorkId: "draft-created", state: "DRAFT" });
    expect(f.courseworkGet).toHaveBeenCalledWith({ courseId: "course-1", id: "draft-created" });
  });

  it("does not report a created draft as verified when Google denies developer association", async () => {
    const f = fixture({ grantedScopes: [...fixture().grantedScopes, V2_TEACHER_COURSEWORK_WRITE_SCOPE] });
    f.courseworkCreate.mockResolvedValueOnce({ data: { id: "draft-created", courseId: "course-1", state: "DRAFT", workType: "ASSIGNMENT" } } as never);
    f.courseworkGet.mockResolvedValueOnce({ data: { id: "draft-created", courseId: "course-1", state: "DRAFT", workType: "ASSIGNMENT", associatedWithDeveloper: false } } as never);

    await expect(createTeacherCourseworkDraft(f.clients, "course-1", { title: "Lab" }, "CREATE_UNPUBLISHED_DRAFT"))
      .rejects.toMatchObject({ code: "teacher_coursework_write_unverified" });
  });

  it("rejects grade and publication fields and maps a stale Google grant to reconnect guidance", async () => {
    const f = fixture({ grantedScopes: [...fixture().grantedScopes, V2_TEACHER_COURSEWORK_WRITE_SCOPE] });
    await expect(updateTeacherCourseworkDraft(f.clients, "course-1", "draft-1", "2026-10-18T10:00:00Z", { assignedGrade: 10 } as never, "UPDATE_UNPUBLISHED_DRAFT"))
      .rejects.toMatchObject({ code: "invalid_coursework_draft" });
    await expect(updateTeacherCourseworkDraft(f.clients, "course-1", "draft-1", "2026-10-18T10:00:00Z", { state: "PUBLISHED" } as never, "UPDATE_UNPUBLISHED_DRAFT"))
      .rejects.toMatchObject({ code: "invalid_coursework_draft" });
    expect(f.courseworkPatch).not.toHaveBeenCalled();

    f.courseworkGet.mockRejectedValueOnce({ response: { status: 401 } });
    await expect(updateTeacherCourseworkDraft(f.clients, "course-1", "draft-1", "2026-10-18T10:00:00Z", { title: "Updated" }, "UPDATE_UNPUBLISHED_DRAFT"))
      .rejects.toMatchObject({ code: "authorization" });
    expect(f.courseworkPatch).not.toHaveBeenCalled();
  });
});

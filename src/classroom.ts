import { classroom, type classroom_v1 } from "@googleapis/classroom";
import { drive, type drive_v3 } from "@googleapis/drive";
import type { OAuth2Client } from "googleapis-common";

export type ClassroomClients = {
  classroom: classroom_v1.Classroom;
  drive: drive_v3.Drive;
  publicPageLimit?: number;
};

export class TeacherCourseAccessError extends Error {
  readonly code = "teacher_course_access_required";
  constructor() { super("teacher_course_access_required"); }
}

export function createClients(auth: OAuth2Client): ClassroomClients {
  return {
    classroom: classroom({ version: "v1", auth }),
    drive: drive({ version: "v3", auth }),
  };
}

export async function allPages<T>(fetchPage: (pageToken?: string) => Promise<{ items: T[]; nextPageToken?: string | null }>, maxPages = Infinity): Promise<T[]> {
  const result: T[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const page = await fetchPage(pageToken);
    result.push(...page.items);
    pageToken = page.nextPageToken ?? undefined;
    pages++;
  } while (pageToken && pages < maxPages);
  return result;
}

export async function listCourses(clients: ClassroomClients, includeArchived = false): Promise<classroom_v1.Schema$Course[]> {
  const states: classroom_v1.Params$Resource$Courses$List["courseStates"] = includeArchived
    ? ["ACTIVE", "ARCHIVED"]
    : ["ACTIVE"];
  return allPages(async (pageToken) => {
    const { data } = await clients.classroom.courses.list({ courseStates: states, pageSize: 100, pageToken });
    return { items: data.courses ?? [], nextPageToken: data.nextPageToken };
  }, clients.publicPageLimit);
}

export async function listCoursesPage(clients: ClassroomClients, includeArchived = false, pageToken?: string, pageSize = 100) {
  const courseStates: classroom_v1.Params$Resource$Courses$List["courseStates"] = includeArchived
    ? ["ACTIVE", "ARCHIVED"] : ["ACTIVE"];
  const { data } = await clients.classroom.courses.list({ courseStates, pageSize, pageToken });
  return { courses: data.courses ?? [], nextPageToken: data.nextPageToken ?? undefined };
}

export async function listAnnouncements(clients: ClassroomClients, courseId: string): Promise<classroom_v1.Schema$Announcement[]> {
  return allPages(async (pageToken) => {
    const { data } = await clients.classroom.courses.announcements.list({ courseId, pageSize: 100, pageToken, announcementStates: ["PUBLISHED"] });
    return { items: data.announcements ?? [], nextPageToken: data.nextPageToken };
  }, clients.publicPageLimit);
}

export async function listCourseWork(clients: ClassroomClients, courseId: string): Promise<classroom_v1.Schema$CourseWork[]> {
  return allPages(async (pageToken) => {
    const { data } = await clients.classroom.courses.courseWork.list({ courseId, pageSize: 100, pageToken, courseWorkStates: ["PUBLISHED"], orderBy: "updateTime desc" });
    return { items: data.courseWork ?? [], nextPageToken: data.nextPageToken };
  }, clients.publicPageLimit);
}

export async function listMaterials(clients: ClassroomClients, courseId: string): Promise<classroom_v1.Schema$CourseWorkMaterial[]> {
  return allPages(async (pageToken) => {
    const { data } = await clients.classroom.courses.courseWorkMaterials.list({ courseId, pageSize: 100, pageToken, courseWorkMaterialStates: ["PUBLISHED"], orderBy: "updateTime desc" });
    return { items: data.courseWorkMaterial ?? [], nextPageToken: data.nextPageToken };
  }, clients.publicPageLimit);
}

export async function listTopics(clients: ClassroomClients, courseId: string): Promise<classroom_v1.Schema$Topic[]> {
  return allPages(async (pageToken) => {
    const { data } = await clients.classroom.courses.topics.list({ courseId, pageSize: 100, pageToken });
    return { items: data.topic ?? [], nextPageToken: data.nextPageToken };
  }, clients.publicPageLimit);
}

export async function listMySubmissions(clients: ClassroomClients, courseId: string, courseWorkId = "-"): Promise<classroom_v1.Schema$StudentSubmission[]> {
  return allPages(async (pageToken) => {
    const { data } = await clients.classroom.courses.courseWork.studentSubmissions.list({ courseId, courseWorkId, userId: "me", pageSize: 100, pageToken });
    return { items: data.studentSubmissions ?? [], nextPageToken: data.nextPageToken };
  }, clients.publicPageLimit);
}

/** List only courses for which Google confirms the current identity is a teacher. */
export async function listMyTeacherCourses(clients: ClassroomClients): Promise<classroom_v1.Schema$Course[]> {
  const listed = await allPages(async (pageToken) => {
    const { data } = await clients.classroom.courses.list({ teacherId: "me", courseStates: ["ACTIVE"], pageSize: 100, pageToken });
    return { items: data.courses ?? [], nextPageToken: data.nextPageToken };
  }, clients.publicPageLimit);
  const verified: classroom_v1.Schema$Course[] = [];
  for (const course of listed) {
    if (!course.id) continue;
    try {
      await clients.classroom.courses.teachers.get({ courseId: course.id, userId: "me" });
      verified.push(course);
    } catch (error) {
      if (!isPermissionOrNotFound(error)) throw error;
    }
  }
  return verified;
}

/** Roster access is checked against Google's teacher membership endpoint on every request. */
export async function listTeacherCourseStudents(clients: ClassroomClients, courseId: string): Promise<classroom_v1.Schema$Student[]> {
  await assertTeacherForCourse(clients, courseId);
  return allPages(async (pageToken) => {
    const { data } = await clients.classroom.courses.students.list({ courseId, pageSize: 100, pageToken });
    return { items: data.students ?? [], nextPageToken: data.nextPageToken };
  }, clients.publicPageLimit);
}

export async function listTeacherCourseWork(clients: ClassroomClients, courseId: string): Promise<classroom_v1.Schema$CourseWork[]> {
  await assertTeacherForCourse(clients, courseId);
  return allPages(async (pageToken) => {
    const { data } = await clients.classroom.courses.courseWork.list({ courseId, pageSize: 100, pageToken, orderBy: "updateTime desc" });
    return { items: data.courseWork ?? [], nextPageToken: data.nextPageToken };
  }, clients.publicPageLimit);
}

/** Submission reads re-check teacher membership and confirm the coursework belongs to the requested course. */
export async function listTeacherCourseSubmissions(clients: ClassroomClients, courseId: string, courseWorkId: string): Promise<classroom_v1.Schema$StudentSubmission[]> {
  await assertTeacherForCourse(clients, courseId);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(courseWorkId)) throw new TeacherCourseAccessError();
  const work = await clients.classroom.courses.courseWork.get({ courseId, id: courseWorkId });
  if (work.data.courseId !== courseId) throw new TeacherCourseAccessError();
  return allPages(async (pageToken) => {
    const { data } = await clients.classroom.courses.courseWork.studentSubmissions.list({ courseId, courseWorkId, pageSize: 100, pageToken });
    return { items: data.studentSubmissions ?? [], nextPageToken: data.nextPageToken };
  }, clients.publicPageLimit);
}

async function assertTeacherForCourse(clients: ClassroomClients, courseId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(courseId)) throw new TeacherCourseAccessError();
  try { await clients.classroom.courses.teachers.get({ courseId, userId: "me" }); }
  catch (error) { if (isPermissionOrNotFound(error)) throw new TeacherCourseAccessError(); throw error; }
}

function isPermissionOrNotFound(error: unknown): boolean {
  const value = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const status = value?.response?.status ?? value?.status ?? value?.code;
  return status === 403 || status === 404 || status === "403" || status === "404";
}

export function dueAt(item: classroom_v1.Schema$CourseWork): string | null {
  const d = item.dueDate;
  if (!d?.year || !d.month || !d.day) return null;
  const t = item.dueTime;
  return new Date(Date.UTC(
    d.year,
    d.month - 1,
    d.day,
    t?.hours ?? 23,
    t?.minutes ?? 59,
    t ? (t.seconds ?? 0) : 59,
  )).toISOString();
}

export function driveIdsFromMaterials(materials: classroom_v1.Schema$Material[] | null | undefined): string[] {
  return (materials ?? []).flatMap((material) => {
    const id = material.driveFile?.driveFile?.id;
    return id ? [id] : [];
  });
}

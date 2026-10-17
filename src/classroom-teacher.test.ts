import { describe, expect, it, vi } from "vitest";
import type { ClassroomClients } from "./classroom.js";
import { listMyTeacherCourses, listTeacherCourseStudents, listTeacherCourseSubmissions, listTeacherCourseWork } from "./classroom.js";

function clients(overrides: { listCourses?: ReturnType<typeof vi.fn>; getTeacher?: ReturnType<typeof vi.fn>; listStudents?: ReturnType<typeof vi.fn>; getCourseWork?: ReturnType<typeof vi.fn>; listSubmissions?: ReturnType<typeof vi.fn> } = {}) {
  const listCourses = overrides.listCourses ?? vi.fn().mockResolvedValue({ data: { courses: [{ id: "course-1", name: "Authorized" }, { id: "course-2", name: "Denied" }] } });
  const getTeacher = overrides.getTeacher ?? vi.fn().mockImplementation(({ courseId }: { courseId: string }) => courseId === "course-1" ? Promise.resolve({ data: { userId: "teacher-1" } }) : Promise.reject({ response: { status: 403 } }));
  const listStudents = overrides.listStudents ?? vi.fn().mockResolvedValue({ data: { students: [{ userId: "student-1" }] } });
  const getCourseWork = overrides.getCourseWork ?? vi.fn().mockResolvedValue({ data: { id: "work-1", courseId: "course-1" } });
  const listSubmissions = overrides.listSubmissions ?? vi.fn().mockResolvedValue({ data: { studentSubmissions: [{ id: "submission-1", state: "TURNED_IN" }] } });
  const value = {
    classroom: {
      courses: {
        list: listCourses,
        teachers: { get: getTeacher },
        students: { list: listStudents },
        courseWork: { get: getCourseWork, list: vi.fn().mockResolvedValue({ data: { courseWork: [] } }), studentSubmissions: { list: listSubmissions } },
      },
    },
    drive: {},
  };
  return { clients: value as unknown as ClassroomClients, listCourses, getTeacher, listStudents, getCourseWork, listSubmissions };
}

describe("least-privilege teacher Classroom reads", () => {
  it("lists only courses Google confirms the current account teaches", async () => {
    const api = clients();
    await expect(listMyTeacherCourses(api.clients)).resolves.toEqual([{ id: "course-1", name: "Authorized" }]);
    expect(api.listCourses).toHaveBeenCalledWith(expect.objectContaining({ teacherId: "me", courseStates: ["ACTIVE"] }));
    expect(api.getTeacher).toHaveBeenCalledTimes(2);
  });

  it("checks teacher membership before retrieving a roster", async () => {
    const api = clients({ getTeacher: vi.fn().mockRejectedValue({ response: { status: 403 } }) });
    await expect(listTeacherCourseStudents(api.clients, "course-2")).rejects.toMatchObject({ code: "teacher_course_access_required" });
    expect(api.listStudents).not.toHaveBeenCalled();
  });

  it("returns a roster only after Google verifies teacher membership", async () => {
    const api = clients({ getTeacher: vi.fn().mockResolvedValue({ data: { userId: "teacher-1" } }) });
    await expect(listTeacherCourseStudents(api.clients, "course-1")).resolves.toEqual([{ userId: "student-1" }]);
    expect(api.getTeacher).toHaveBeenCalledWith({ courseId: "course-1", userId: "me" });
    expect(api.listStudents).toHaveBeenCalledWith(expect.objectContaining({ courseId: "course-1", pageSize: 100 }));
  });

  it("does not restrict a verified teacher's coursework to student-visible published items", async () => {
    const listCourseWork = vi.fn().mockResolvedValue({ data: { courseWork: [{ id: "draft-work", state: "DRAFT" }] } });
    const api = clients({ getTeacher: vi.fn().mockResolvedValue({ data: {} }) });
    api.clients.classroom.courses.courseWork.list = listCourseWork as never;
    const items = await listTeacherCourseWork(api.clients, "course-1");
    expect(items).toEqual([{ id: "draft-work", state: "DRAFT" }]);
    expect(listCourseWork).toHaveBeenCalledWith(expect.objectContaining({ courseId: "course-1" }));
    expect(listCourseWork.mock.calls[0]?.[0]).not.toHaveProperty("courseWorkStates");
  });

  it("checks teacher membership and course ownership before reading submissions", async () => {
    const api = clients({ getTeacher: vi.fn().mockResolvedValue({ data: {} }), getCourseWork: vi.fn().mockResolvedValue({ data: { id: "work-1", courseId: "other-course" } }) });
    await expect(listTeacherCourseSubmissions(api.clients, "course-1", "work-1")).rejects.toMatchObject({ code: "teacher_course_access_required" });
    expect(api.listSubmissions).not.toHaveBeenCalled();
  });

  it("reads submission states only after the per-course teacher check", async () => {
    const api = clients({ getTeacher: vi.fn().mockResolvedValue({ data: {} }) });
    await expect(listTeacherCourseSubmissions(api.clients, "course-1", "work-1")).resolves.toEqual([{ id: "submission-1", state: "TURNED_IN" }]);
    expect(api.getTeacher).toHaveBeenCalledWith({ courseId: "course-1", userId: "me" });
    expect(api.getCourseWork).toHaveBeenCalledWith({ courseId: "course-1", id: "work-1" });
  });
});

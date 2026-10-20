import { describe, expect, it } from "vitest";
import { renderExperienceSelector, renderStudentDashboard, renderTeacherCourse, renderTeacherDashboard, renderTeacherSubmissions } from "./dashboard-pages.js";
import type { SaaSUser } from "./types.js";

const user: SaaSUser = { id: "user-1", googleSubject: "subject-1", email: "student@example.test", displayName: "Student", role: "STUDENT", status: "active", createdAt: new Date("2026-01-01T00:00:00Z"), lastLoginAt: null };

describe("account dashboard pages", () => {
  it("offers Student and Teacher as presentation choices and disclaims permission changes", () => {
    const html = renderExperienceSelector(user, null);
    expect(html).toContain('action="/api/account/experience"');
    expect(html).toContain('value="student"');
    expect(html).toContain('value="teacher"');
    expect(html).toContain("does not make your Google account a teacher");
    expect(html).toContain("dashboard only");
  });

  it("shows unavailable totals and explains partial Google data in plain language", () => {
    const html = renderStudentDashboard(user, { state: "connected", overview: {
      generatedAt: "2026-10-18T10:00:00Z",
      summary: { courses: 1, assignments: null, missing: null, turnedIn: null, returned: null },
      availability: { courseworkComplete: false, submissionsComplete: false, announcementsComplete: true, materialsComplete: true, topicsComplete: true },
      courses: [{ id: "course-1", name: "Biology" }], assignments: [{ title: "Lab", courseName: "Biology", submissionState: "UNKNOWN", missing: null, late: null, dueAt: null, assignmentUrl: null }], announcements: [], courseMaterials: [],
    } });
    expect(html).toContain("Not available");
    expect(html).toContain("assignment count is not available");
    expect(html).toContain("missing and turned-in counts are not available");
    expect(html).toContain("Status not available");
    expect(html).not.toContain("UNKNOWN");
    expect(html).not.toContain("Currently missing</span></article><article><strong>0");
  });

  it("does not call an incomplete coursework read an empty assignment list", () => {
    const html = renderStudentDashboard(user, { state: "connected", overview: {
      generatedAt: "2026-10-18T10:00:00Z",
      summary: { courses: 1, assignments: null, missing: null, turnedIn: null, returned: null },
      availability: { courseworkComplete: false, submissionsComplete: true, announcementsComplete: true, materialsComplete: true, topicsComplete: true },
      courses: [{ id: "course-1", name: "Biology" }], assignments: [], announcements: [], courseMaterials: [],
    } });
    expect(html).toContain("We could not retrieve all assignment results from Google");
    expect(html).not.toContain("Google returned no matching published assignments");
  });

  it("renders date-only deadlines without a fabricated midnight time and marks missing status unknown", () => {
    const html = renderStudentDashboard(user, { state: "connected", overview: {
      generatedAt: "2026-01-02T12:00:00Z",
      summary: { courses: 1, assignments: 1, missing: null, turnedIn: 0, returned: 0 },
      availability: { courseworkComplete: true, submissionsComplete: true, announcementsComplete: true, materialsComplete: true, topicsComplete: true },
      courses: [{ id: "course-1", name: "Biology" }],
      assignments: [{ title: "Lab", courseName: "Biology", submissionState: "ASSIGNED", missing: null, late: false, dueAt: "2026-01-03", assignmentUrl: null }],
      announcements: [], courseMaterials: [],
    } });
    expect(html).toContain("Due: 3 Jan 2026</p>");
    expect(html).toContain("Missing status not available");
    expect(html).toContain("Not marked late");
    expect(html).not.toContain("Due: 3 Jan 2026, 00:00");
  });

  it("does not label capped Student results as complete or empty", () => {
    const html = renderStudentDashboard(user, { state: "connected", overview: {
      generatedAt: "2026-10-18T10:00:00Z",
      summary: { courses: 0, assignments: null, missing: null, turnedIn: null, returned: null },
      availability: { coursesComplete: false, courseworkComplete: false, submissionsComplete: false, announcementsComplete: true, materialsComplete: true, topicsComplete: true, assignmentResultsComplete: false, announcementResultsComplete: false, materialResultsComplete: false },
      courses: [], assignments: [], announcements: [], courseMaterials: [],
    } });
    expect(html).toContain("We could not retrieve every course from Google");
    expect(html).toContain("We could not retrieve every matching assignment from Google");
    expect(html).toContain("We could not retrieve every announcement from Google");
    expect(html).not.toContain("Google returned no active courses");
    expect(html).not.toContain("Google returned no matching published assignments");
  });

  it("translates Google submission states without showing raw API enums", () => {
    const html = renderTeacherSubmissions(user, {
      courseId: "course-1", courseWorkId: "work-1", title: "Lab", maxPoints: 10,
      gradebookWritebackEnabled: false, moreAvailable: false, studentRosterMoreAvailable: false,
      submissions: [
        { studentName: "A", state: "NEW", late: false, assignedGrade: null, updateTime: null },
        { studentName: "B", state: "CREATED", late: false, assignedGrade: null, updateTime: null },
        { studentName: "C", state: "TURNED_IN", late: false, assignedGrade: null, updateTime: null },
        { studentName: "D", state: "RETURNED", late: false, assignedGrade: null, updateTime: null },
        { studentName: "E", state: "RECLAIMED_BY_STUDENT", late: false, assignedGrade: null, updateTime: null },
        { studentName: "F", state: "FUTURE_GOOGLE_STATE", late: false, assignedGrade: null, updateTime: null },
      ],
    });
    for (const status of ["Not submitted", "In progress", "Turned in", "Returned", "Unsubmitted by student", "Status not available"]) expect(html).toContain(status);
    expect(html).not.toContain("RECLAIMED_BY_STUDENT");
    expect(html).not.toContain("FUTURE_GOOGLE_STATE");
  });

  it("keeps teacher data behind explicit authorization and never claims dashboard selection grants roles", () => {
    const html = renderTeacherDashboard(user, { state: "authorization_required" });
    expect(html).toContain("separate read-only permission");
    expect(html).toContain('action="/api/teacher/authorization"');
    expect(html).toContain("does not grant these permissions");
    expect(html).not.toContain("synthetic");
  });

  it("renders explicit, unpublished draft controls and discloses the broader Google permission", () => {
    const html = renderTeacherCourse(user, {
      course: { id: "course-1", name: "Biology", section: "Period 2" },
      students: [],
      studentsMoreAvailable: false,
      coursework: [{ id: "published-1", title: "Lab report", dueDate: null, maxPoints: 10 }],
      courseworkMoreAvailable: false,
      drafts: [{ id: "draft-1", title: "<script>alert(1)</script>", description: "Instructions", dueDate: { year: 2026, month: 11, day: 30 }, dueTime: { hours: 9, minutes: 5 }, maxPoints: 20, state: "DRAFT" }],
      draftsMoreAvailable: false,
      courseworkDraftsEnabled: true,
      writeAuthorizationAvailable: true,
    });
    expect(html).toContain("Unpublished assignment drafts");
    expect(html).toContain('action="/api/teacher/courses/course-1/coursework/drafts"');
    expect(html).toContain('name="confirm" value="yes" required');
    expect(html).toMatch(/gradebook writeback is disabled/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("2026-11-30");
    expect(html).not.toContain("Save draft changes");
    expect(html).toContain("09:05");
  });

  it("offers only separate draft consent when the teacher has read access but no draft grant", () => {
    const html = renderTeacherCourse(user, {
      course: { id: "course-1", name: "Biology", section: null }, students: [], coursework: [],
      studentsMoreAvailable: false, courseworkMoreAvailable: false,
      courseworkDraftsEnabled: false, writeAuthorizationAvailable: true,
    });
    expect(html).toContain('action="/api/teacher/authorization/write"');
    expect(html).toContain("Creating or updating an unpublished draft needs a separate Google permission");
    expect(html).toContain("This permission can also manage grades");
    expect(html).not.toContain("uses it only to create unpublished assignment drafts");
    expect(html).toContain("Review Google permission for draft management");
    expect(html).not.toContain('action="/api/teacher/courses/course-1/coursework/drafts"');
  });

  it("labels teacher assignment creation Coming Soon when the write feature is disabled", () => {
    const html = renderTeacherCourse(user, {
      course: { id: "course-1", name: "Biology", section: null }, students: [], coursework: [],
      studentsMoreAvailable: false, courseworkMoreAvailable: false,
      courseworkDraftsEnabled: false, writeAuthorizationAvailable: false,
    });
    expect(html).toContain("Coming soon");
    expect(html).toContain("Draft management is disabled in this release");
    expect(html).toContain("Teacher data access is read-only");
    expect(html).not.toContain('action="/api/teacher/authorization/write"');
    expect(html).not.toContain('action="/api/teacher/courses/course-1/coursework/drafts"');
  });

  it("labels bounded teacher results as incomplete instead of reporting exact totals", () => {
    const dashboard = renderTeacherDashboard(user, { state: "connected", courses: [{
      id: "course-1", name: "Biology", section: null,
      studentCount: 100, studentCountMoreAvailable: true,
      courseworkCount: 100, courseworkCountMoreAvailable: true,
    }] });
    expect(dashboard).toContain("100+ students");
    expect(dashboard).toContain("100+ published items");

    const course = renderTeacherCourse(user, {
      course: { id: "course-1", name: "Biology", section: null },
      students: [], studentsMoreAvailable: true,
      coursework: [], courseworkMoreAvailable: true,
    });
    expect(course).toContain("Roster results are incomplete");
    expect(course).toContain("Coursework results are incomplete");

    const submissions = renderTeacherSubmissions(user, {
      courseId: "course-1", courseWorkId: "work-1", title: "Lab", maxPoints: 10,
      gradebookWritebackEnabled: false, submissions: [], moreAvailable: true, studentRosterMoreAvailable: true,
    });
    expect(submissions).toContain("No submissions were found on this page; more results are available");
    expect(submissions).toContain("The roster results are incomplete");
    expect(submissions).not.toContain("No submissions were returned by Google");
  });

  it("shows unknown teacher fields and incomplete empty submission pages truthfully", () => {
    const rows = renderTeacherSubmissions(user, {
      courseId: "course-1", courseWorkId: "work-1", title: "Lab", maxPoints: 10,
      gradebookWritebackEnabled: false,
      submissions: [{ studentName: null, state: "UNKNOWN", late: false, lateStatus: "UNKNOWN", assignedGrade: null, gradeStatus: "UNKNOWN", updateTime: null }],
      moreAvailable: false, submissionPagesComplete: true, studentRosterMoreAvailable: false, studentRosterPagesComplete: true,
    });
    expect(rows).toContain("<td>Status not available</td><td>Not available</td>");
    expect(rows).not.toContain("<td>No</td><td>Unscored</td>");

    const empty = renderTeacherSubmissions(user, {
      courseId: "course-1", courseWorkId: "work-1", title: "Lab", maxPoints: 10,
      gradebookWritebackEnabled: false, submissions: [], moreAvailable: false, submissionPagesComplete: false,
      studentRosterMoreAvailable: false, studentRosterPagesComplete: true,
    });
    expect(empty).toContain("We could not retrieve all submissions from Google");
    expect(empty).not.toContain("No submissions were returned by Google");
  });

  it("offers safe continuation when a teacher course page is incomplete", () => {
    const html = renderTeacherDashboard(user, { state: "connected", courses: [], previousPageAvailable: true, nextCoursePageToken: "<next&token>" });
    expect(html).toContain("No teacher-managed courses were verified on this page");
    expect(html).toContain('href="/app/teacher">First course page</a>');
    expect(html).toContain('href="/app/teacher?coursePageToken=%3Cnext%26token%3E">Next course page</a>');
    expect(html).not.toContain("<next&token>");
  });
});

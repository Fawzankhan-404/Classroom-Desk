import type { SaaSUser, DashboardExperience } from "./types.js";
import { html, portalPage } from "./account-portal.js";

type StudentOverview = {
  generatedAt: string;
  summary: { courses: number; assignments: number | null; missing: number | null; turnedIn: number | null; returned: number | null };
  availability: { coursesComplete?: boolean; courseworkComplete: boolean; submissionsComplete: boolean; announcementsComplete: boolean; materialsComplete: boolean; topicsComplete: boolean; assignmentResultsComplete?: boolean; announcementResultsComplete?: boolean; materialResultsComplete?: boolean; topicResultsComplete?: boolean };
  courses: Array<{ id?: string | null; name?: string | null; section?: string | null; state?: string | null }>;
  assignments: Array<{ courseName?: string; title?: string; dueAt?: string | null; submissionState?: string; missing?: boolean | null; late?: boolean | null; assignmentUrl?: string | null }>;
  announcements: Array<{ courseName?: string; text?: string | null; updatedAt?: string | null }>;
  courseMaterials: Array<{ courseName?: string; title?: string | null; description?: string | null }>;
};
export type StudentDashboardState =
  | { state: "connected"; overview: StudentOverview }
  | { state: "not_connected" | "reauthorization_required" | "permission_denied" | "access_required" | "unavailable" };
export type TeacherDashboardState =
  | { state: "connected"; courses: Array<{ id: string; name: string | null; section: string | null; studentCount: number | null; studentCountMoreAvailable: boolean; courseworkCount: number | null; courseworkCountMoreAvailable: boolean }>; nextCoursePageToken?: string; previousPageAvailable?: boolean }
  | { state: "authorization_required" | "not_connected" | "account_mismatch" | "reauthorization_required" | "permission_denied" | "access_required" | "teacher_entitlement_required" | "unavailable" };

const dateText = (value: string | null | undefined) => {
  if (!value) return "No due date set";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const day = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(day.getTime()) ? day.toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "UTC" }) : "Due date unavailable";
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) : "Due date unavailable";
};
const submissionStateText = (value: string | null | undefined) => {
  switch (value?.toUpperCase()) {
    case "NEW": return "Not submitted";
    case "CREATED": return "In progress";
    case "TURNED_IN": return "Turned in";
    case "RETURNED": return "Returned";
    case "RECLAIMED_BY_STUDENT": return "Unsubmitted by student";
    default: return "Status not available";
  }
};
const emptyState = (title: string, detail: string, action?: string, actionLabel = "Reconnect Google Classroom") => `<section><h2>${html(title)}</h2><p>${html(detail)}</p>${action ? `<a class="button" href="${html(action)}">${html(actionLabel)}</a>` : ""}</section>`;

export function renderExperienceSelector(user: SaaSUser, preference: DashboardExperience | null): string {
  const first = preference === null;
  return portalPage("Choose experience", user, `<section><p class="eyebrow">${first ? "Welcome to Classroom Desk" : "Dashboard preference"}</p><h2>${first ? "How would you like to use Classroom Desk?" : "Choose your dashboard"}</h2><p>This choice changes the dashboard only. Google Classroom permissions are checked separately for every request.</p><div class="actions experience-cards"><form method="post" action="/api/account/experience" data-account-action><input type="hidden" name="experience" value="student"><button type="submit" class="experience-choice" aria-pressed="${preference === "student"}"><strong>Student</strong><span>Courses, assignments, due dates, and your submission status.</span></button></form><form method="post" action="/api/account/experience" data-account-action><input type="hidden" name="experience" value="teacher"><button type="submit" class="experience-choice secondary" aria-pressed="${preference === "teacher"}"><strong>Teacher</strong><span>Teacher-managed courses and authorized roster or submission reads.</span></button></form></div><p class="small">Choosing Teacher does not make your Google account a teacher and does not grant access to student data.</p></section>`);
}

export function renderStudentDashboard(user: SaaSUser, result: StudentDashboardState, account?: { allowed: boolean; plan: string | null; expiresAt: Date | null }): string {
  if (result.state !== "connected") {
    const copy = {
      not_connected: ["Connect Google Classroom", "Connect the Google account that contains your classes. Classroom Desk will show data only after Google authorization.", "/app/connection"],
      reauthorization_required: ["Reconnect Google Classroom", "The current Google authorization is missing or expired. Reconnect from ChatGPT, then refresh this page.", "/app/connection"],
      permission_denied: ["Google denied access", "Google did not authorize this Classroom data. Review the requested scopes or choose an account enrolled in a course.", "/app/connection"],
      access_required: ["Account access is inactive", "Your account does not currently have access to Classroom Desk features. Check your account status for details.", "/app/subscription"],
      unavailable: ["Classroom is temporarily unavailable", "Google Classroom could not be reached. No course or assignment counts are being shown as current.", undefined],
    }[result.state];
    const actionLabel = result.state === "access_required" ? "View subscription status" : "Reconnect Google Classroom";
    return portalPage("Dashboard", user, `<p class="eyebrow">Student</p>${emptyState(copy[0] ?? "Classroom unavailable", copy[1] ?? "Classroom data is unavailable.", copy[2], actionLabel)}<p><a href="/app/experience">Switch experience</a> · <a href="/app/settings">Account settings</a></p>`);
  }
  const overview = result.overview;
  const courses = overview.courses.length ? `<div class="dashboard-grid">${overview.courses.map(course => `<article class="dashboard-card"><h3>${html(course.name || "Unnamed course")}</h3><p>${html(course.section || "Google Classroom course")}</p><span class="badge">${html(course.state || "State unavailable")}</span></article>`).join("")}</div>` : `<p>${overview.availability.coursesComplete === false ? "Course results are incomplete; Google returned only part of the course list." : "Google returned no active courses for this account."}</p>`;
  const dueTime = (item: StudentOverview["assignments"][number]) => item.dueAt ? Date.parse(item.dueAt) : Number.POSITIVE_INFINITY;
  const assignmentsToShow = [...overview.assignments].sort((a, b) => Number(Boolean(b.missing || b.late)) - Number(Boolean(a.missing || a.late)) || dueTime(a) - dueTime(b)).slice(0, 3);
  const assignments = assignmentsToShow.length ? `<div class="dashboard-grid">${assignmentsToShow.map(item => `<article class="dashboard-card"><p class="eyebrow">${html(item.courseName || "Course")}</p><h3>${html(item.title || "Untitled assignment")}</h3><p>Due: ${html(dateText(item.dueAt))}</p><p>Status: ${html(submissionStateText(item.submissionState))}${item.missing ? " · Needs attention" : item.late ? " · Late" : ""}</p>${item.assignmentUrl ? `<a href="${html(item.assignmentUrl)}" rel="noopener noreferrer">Open in Google Classroom</a>` : ""}</article>`).join("")}</div><p class="small">Showing up to three assignments that need attention soonest.</p>` : `<p>${overview.availability.assignmentResultsComplete === false || !overview.availability.courseworkComplete ? "Assignment details are temporarily incomplete. Open Google Classroom to review current work." : "No upcoming assignments need attention."}</p>`;
  const connection = "Connected";
  const access = account?.allowed ? `${html(account.plan === "student" ? "Student access" : "Account access")} · active${account.expiresAt ? ` until ${html(dateText(account.expiresAt.toISOString()))}` : ""}` : "No active Student entitlement";
  const assignmentCount = overview.summary.assignments === null ? "Not available" : overview.summary.assignments;
  const missingCount = overview.summary.missing === null ? "Not available" : overview.summary.missing;
  const turnedInCount = overview.summary.turnedIn === null ? "Not available" : overview.summary.turnedIn;
  return portalPage("Dashboard", user, `<div class="dashboard-title"><div><p class="eyebrow">Student account</p><h2>Welcome, ${html(user.displayName)}</h2><p>Your focused Classroom overview · updated ${html(dateText(overview.generatedAt))}</p></div><a href="/app/experience">Switch experience</a></div><section class="account-status-grid"><article><span class="eyebrow">Experience</span><strong>Student</strong><span>Courses and assignments</span></article><article><span class="eyebrow">Google connection</span><strong>${connection}</strong><span>${connection === "Connected" ? "Classroom data is available" : "Review your connection"}</span></article><article><span class="eyebrow">Access</span><strong>${access}</strong><a href="/app/subscription">View subscription</a></article></section><section class="dashboard-grid summary"><article><strong>${overview.summary.courses}</strong><span>Active courses</span></article><article><strong>${html(assignmentCount)}</strong><span>Published assignments</span></article><article><strong>${html(missingCount)}</strong><span>Reported missing</span></article><article><strong>${html(turnedInCount)}</strong><span>Turned in</span></article></section><section><div class="section-heading"><div><p class="eyebrow">Next actions</p><h2>Work that needs attention</h2></div><a href="/app/connection">Google connection</a></div>${assignments}</section><section><h2>Course snapshot</h2>${courses}</section><p><a href="/app/settings">Account settings</a> · <a href="/app/experience">Switch Student / Teacher</a></p>`);
}

export function renderTeacherDashboard(user: SaaSUser, result: TeacherDashboardState): string {
  const switchLink = `<p><a href="/app/experience">Switch experience</a></p>`;
  if (result.state === "authorization_required") return portalPage("Teacher dashboard", user, `<p class="eyebrow">Teacher dashboard</p><section><h2>Teacher read access needs your consent</h2><p>Google Classroom requires separate read-only permission for course rosters and student submissions. Your dashboard choice does not grant these permissions or change your platform role.</p><form method="post" action="/api/teacher/authorization"><button type="submit">Authorize teacher read access with Google</button></form><p>Classroom Desk will verify your Google account and each course teacher role before displaying any roster or submission.</p></section>${switchLink}`);
  if (result.state !== "connected") {
    const copy = {
      not_connected: ["Connect Google Classroom", "Sign in to ChatGPT with the same Google account that manages your Classroom courses."],
      reauthorization_required: ["Reconnect Google Classroom", "Your Google authorization is missing or expired. Reconnect, then try this dashboard again."],
      permission_denied: ["Google denied teacher access", "Google did not confirm teacher access. Classroom Desk will not show rosters or student work."],
      access_required: ["Account access is inactive", "Your account does not currently have access to Classroom Desk features. Check your account status for details."],
      teacher_entitlement_required: ["Teacher access required", "Choosing Teacher changes your dashboard only. Teacher features also require an eligible account and Google confirmation that you teach the course."],
      account_mismatch: ["Reconnect the same Google account", "Teacher reads require the signed-in website account and Classroom authorization to resolve to the same verified Google subject."],
      unavailable: ["Teacher data unavailable", "Google Classroom could not verify teacher access. No teacher course counts are inferred."],
    }[result.state];
    const action = result.state === "not_connected" || result.state === "reauthorization_required" ? "/app/connection" : result.state === "access_required" || result.state === "teacher_entitlement_required" ? "/app/subscription" : undefined;
    const actionLabel = result.state === "access_required" || result.state === "teacher_entitlement_required" ? "View subscription status" : "Reconnect Google Classroom";
    return portalPage("Teacher dashboard", user, `<p class="eyebrow">Teacher dashboard</p>${emptyState(copy[0] ?? "Teacher data unavailable", copy[1] ?? "Teacher data is unavailable.", action, actionLabel)}${switchLink}`);
  }
  const countText = (count: number | null, moreAvailable: boolean, noun: string) => count === null ? `${noun} count not available` : `${count}${moreAvailable ? "+" : ""} ${noun}`;
  const courses = result.courses.length ? `<div class="dashboard-grid">${result.courses.map(course => `<article class="dashboard-card"><h3>${html(course.name || "Unnamed course")}</h3><p>${html(course.section || "Teacher-managed course")}</p><p>${html(countText(course.studentCount, course.studentCountMoreAvailable, "students"))} · ${html(countText(course.courseworkCount, course.courseworkCountMoreAvailable, "published items"))}</p><a href="/app/teacher/courses/${encodeURIComponent(course.id)}">Open course</a></article>`).join("")}</div>` : `<p>${result.nextCoursePageToken ? "No teacher-managed courses were verified on this page. More Google Classroom courses are available to check." : "Google verified access but returned no teacher-managed active courses."}</p>`;
  const pageLinks = `${result.previousPageAvailable ? `<a href="/app/teacher">First course page</a>` : ""}${result.nextCoursePageToken ? ` <a href="/app/teacher?coursePageToken=${html(encodeURIComponent(result.nextCoursePageToken))}">Next course page</a>` : ""}`;
  return portalPage("Teacher dashboard", user, `<p class="eyebrow">Teacher dashboard · Live Google Classroom data</p><h2>Teacher-managed courses</h2><section><p>Every course is verified with Google before its roster or coursework is read. Gradebook writeback is disabled.</p>${courses}${pageLinks ? `<nav aria-label="Teacher course pages">${pageLinks}</nav>` : ""}</section>${switchLink}`);
}

export function renderTeacherCourse(user: SaaSUser, detail: {
  course: { id: string; name: string | null; section: string | null };
  students: Array<{ userId: string | null; fullName: string | null }>;
  studentsMoreAvailable: boolean;
  studentsComplete?: boolean;
  coursework: Array<{ id: string | null; title: string | null; dueDate: unknown; maxPoints: number | null }>;
  courseworkMoreAvailable: boolean;
  drafts?: Array<{ id: string; title: string | null; description: string | null; dueDate: unknown; dueTime: unknown; maxPoints: number | null; state: "DRAFT" }>;
  draftsMoreAvailable?: boolean;
  courseworkDraftsEnabled?: boolean;
  writeAuthorizationAvailable?: boolean;
}): string {
  const roster = detail.students.length ? `<ul>${detail.students.map(student => `<li>${html(student.fullName || "Student name unavailable")}</li>`).join("")}</ul>${detail.studentsMoreAvailable || detail.studentsComplete === false ? `<p role="status">Showing an incomplete roster${detail.studentsMoreAvailable ? "; additional Google Classroom results are available" : " because Google omitted part of the response"}.</p>` : ""}` : `<p>${detail.studentsMoreAvailable || detail.studentsComplete === false ? "Roster results are incomplete; an empty response is not treated as an empty class." : "Google returned no students for this course."}</p>`;
  const work = detail.coursework.length ? `<div class="dashboard-grid">${detail.coursework.map(item => `<article class="dashboard-card"><h3>${html(item.title || "Untitled coursework")}</h3><p>${item.maxPoints === null ? "Points unavailable" : `${item.maxPoints} points`}</p>${item.id ? `<a href="/app/teacher/courses/${encodeURIComponent(detail.course.id)}/coursework/${encodeURIComponent(item.id)}">View submissions</a>` : ""}</article>`).join("")}</div>${detail.courseworkMoreAvailable ? `<p role="status">Showing the first ${detail.coursework.length} published items. More coursework is available.</p>` : ""}` : `<p>${detail.courseworkMoreAvailable ? "Coursework results are incomplete; additional Google Classroom results are available." : "Google returned no published coursework."}</p>`;
  const dateValue = (value: unknown) => {
    if (!value || typeof value !== "object") return "";
    const item = value as { year?: unknown; month?: unknown; day?: unknown };
    if (![item.year, item.month, item.day].every(Number.isInteger)) return "";
    return `${String(item.year).padStart(4, "0")}-${String(item.month).padStart(2, "0")}-${String(item.day).padStart(2, "0")}`;
  };
  const timeValue = (value: unknown) => {
    if (!value || typeof value !== "object") return "";
    const item = value as { hours?: unknown; minutes?: unknown };
    if (![item.hours, item.minutes].every(Number.isInteger)) return "";
    return `${String(item.hours).padStart(2, "0")}:${String(item.minutes).padStart(2, "0")}`;
  };
  const draftFields = (draft?: { title: string | null; description: string | null; dueDate: unknown; dueTime: unknown; maxPoints: number | null }) => `<label>Title<input name="title" maxlength="300" value="${html(draft?.title ?? "")}" ${draft ? "" : "required"}></label><label>Description<textarea name="description" maxlength="5000">${html(draft?.description ?? "")}</textarea></label><label>Due date<input type="date" name="dueDate" value="${dateValue(draft?.dueDate)}"></label><label>Due time<input type="time" name="dueTime" value="${timeValue(draft?.dueTime)}"></label><label>Maximum points<input type="number" name="maxPoints" min="0" max="10000" step="1" value="${draft?.maxPoints ?? ""}"></label>`;
  const createDraft = detail.courseworkDraftsEnabled
    ? `<form method="post" action="/api/teacher/courses/${encodeURIComponent(detail.course.id)}/coursework/drafts"><h3>New unpublished assignment draft</h3>${draftFields()}<label><input type="checkbox" name="confirm" value="yes" required> I confirm Classroom Desk may create this unpublished draft in Google Classroom.</label><button type="submit">Create draft</button></form>`
    : detail.writeAuthorizationAvailable
      ? `<p>Creating or updating an unpublished draft needs a separate Google permission. This permission can also manage grades. Classroom Desk requires your confirmation for draft changes and does not change grades.</p><form method="post" action="/api/teacher/authorization/write"><button type="submit">Review Google permission for draft management</button></form>`
      : `<p><strong>Coming soon:</strong> Draft management is disabled in this release. Teacher data access remains read-only.</p>`;
  const drafts = detail.courseworkDraftsEnabled
    ? `<section><h2>Unpublished assignment drafts</h2>${detail.drafts?.length ? `<div class="dashboard-grid">${detail.drafts.map(draft => `<article class="dashboard-card"><p class="badge">DRAFT · not visible to students</p><h3>${html(draft.title || "Untitled draft")}</h3><p>${html(draft.description || "No description")}</p><p>${dateValue(draft.dueDate) || "No due date"}${timeValue(draft.dueTime) ? ` · ${timeValue(draft.dueTime)}` : ""}</p><p>${draft.maxPoints === null ? "Points not set" : `${draft.maxPoints} points`}</p></article>`).join("")}</div>${detail.draftsMoreAvailable ? `<p role="status">Showing the first ${detail.drafts!.length} drafts. More drafts are available.</p>` : ""}` : `<p>${detail.draftsMoreAvailable ? "Draft results are incomplete; additional Google Classroom results are available." : "No unpublished assignment drafts were returned by Google."}</p>`}${createDraft}</section>`
    : `<section><h2>Unpublished assignment drafts</h2>${createDraft}</section>`;
  const writeNotice = detail.courseworkDraftsEnabled
    ? "Creating or updating a draft requires explicit confirmation. Gradebook writeback is disabled."
    : detail.writeAuthorizationAvailable
      ? "Creating a draft requires separate Google consent and explicit confirmation. Gradebook writeback is disabled."
      : "Teacher assignment creation is coming soon. Gradebook writeback is disabled. Teacher data access is read-only.";
  return portalPage("Teacher course", user, `<p class="eyebrow">Teacher course · Live Google Classroom data</p><h2>${html(detail.course.name || "Course")}</h2><p>${html(detail.course.section || "")}</p><section><h2>Student roster</h2>${roster}</section><section><h2>Published coursework</h2>${work}</section>${drafts}<p>${writeNotice}</p><a href="/app/teacher">Back to teacher courses</a>`);
}

export function renderTeacherSubmissions(user: SaaSUser, result: { courseId: string; courseWorkId: string; title: string | null; maxPoints: number | null; gradebookWritebackEnabled: false; submissions: Array<{ studentName: string | null; state: string; late: boolean; lateStatus?: "LATE" | "NOT_LATE" | "UNKNOWN"; assignedGrade: number | null; gradeStatus?: "GRADED" | "UNKNOWN"; updateTime: string | null }>; moreAvailable: boolean; submissionPagesComplete?: boolean; studentRosterMoreAvailable: boolean; studentRosterPagesComplete?: boolean }): string {
  const rows = result.submissions.length ? `<div class="table-scroll"><table><thead><tr><th>Student</th><th>Status</th><th>Late</th><th>Existing grade</th><th>Last updated</th></tr></thead><tbody>${result.submissions.map(item => `<tr><td>${html(item.studentName || "Student name unavailable")}</td><td>${html(submissionStateText(item.state))}</td><td>${item.lateStatus === "LATE" ? "Yes" : item.lateStatus === "NOT_LATE" ? "No" : "Not available"}</td><td>${item.gradeStatus === "GRADED" && item.assignedGrade !== null ? html(item.assignedGrade) : "Not available"}</td><td>${html(dateText(item.updateTime))}</td></tr>`).join("")}</tbody></table></div>` : `<p>${result.submissionPagesComplete === false ? "We could not retrieve all submissions from Google, so this list may be incomplete." : result.moreAvailable ? "No submissions were found on this page; more results are available." : "Google returned no submissions for this coursework item."}</p>`;
  const completeness = [result.moreAvailable || result.submissionPagesComplete === false ? `Submission results are incomplete${result.moreAvailable ? `; more results are available after the first ${result.submissions.length}` : " because Google returned an incomplete response"}.` : "", result.studentRosterMoreAvailable || result.studentRosterPagesComplete === false ? "The roster results are incomplete, so some student names may be unavailable." : ""].filter(Boolean).map(html).join(" ");
  return portalPage("Teacher submissions", user, `<p class="eyebrow">Teacher submissions · Live Google Classroom data</p><h2>${html(result.title || "Coursework")}</h2><p>Maximum points: ${result.maxPoints === null ? "Not set" : html(result.maxPoints)}</p>${completeness ? `<p role="status">${completeness}</p>` : ""}<section>${rows}</section><p>Google Classroom remains the record of your grades. This page does not change them.</p><a href="/app/teacher/courses/${encodeURIComponent(result.courseId)}">Back to course</a>`);
}

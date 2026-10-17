import type { classroom_v1 } from "@googleapis/classroom";

const text = (value: unknown, max = 8000): string | undefined => typeof value === "string" && value.length ? value.slice(0, max) : undefined;
const safeLink = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > 1500) return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.toString() : undefined;
  } catch { return undefined; }
};
const dateFields = (item: { creationTime?: string | null; updateTime?: string | null }) => ({
  ...(item.creationTime ? { createdAt: item.creationTime } : {}),
  ...(item.updateTime ? { updatedAt: item.updateTime } : {}),
});

function materialSummary(materials: classroom_v1.Schema$Material[] | null | undefined) {
  return (materials ?? []).map((material) => {
    const drive = material.driveFile?.driveFile;
    if (drive) return { title: text(drive.title, 300) ?? "Classroom attachment", type: "Drive attachment", url: safeLink(drive.alternateLink), attachment_content_available: false, reason: "Public V1 does not request Google Drive access." };
    if (material.link) return { title: text(material.link.title, 300), type: "link", url: safeLink(material.link.url), attachment_content_available: false };
    if (material.youtubeVideo) return { title: text(material.youtubeVideo.title, 300), type: "YouTube video", url: safeLink(material.youtubeVideo.alternateLink), attachment_content_available: false };
    if (material.form) return { title: text(material.form.title, 300), type: "Google Form", url: safeLink(material.form.formUrl), attachment_content_available: false };
    return { title: "Classroom material", type: "other", attachment_content_available: false };
  });
}

export function mapCourse(course: classroom_v1.Schema$Course) {
  return {
    ...(course.id ? { id: course.id } : {}),
    ...(text(course.name, 300) ? { name: text(course.name, 300) } : {}),
    ...(text(course.section, 300) ? { section: text(course.section, 300) } : {}),
    ...(text(course.description, 4000) ? { description: text(course.description, 4000) } : {}),
    ...(text(course.room, 200) ? { room: text(course.room, 200) } : {}),
    ...(course.courseState ? { state: course.courseState } : {}),
    ...dateFields(course),
  };
}
export function mapAnnouncement(item: classroom_v1.Schema$Announcement) {
  return { ...(item.id ? { id: item.id } : {}), ...(item.courseId ? { courseId: item.courseId } : {}), ...(text(item.text) ? { text: text(item.text) } : {}), ...dateFields(item), materials: materialSummary(item.materials) };
}
export function mapCoursework(item: classroom_v1.Schema$CourseWork) {
  const dueDate = item.dueDate;
  const due = dueDate?.year && dueDate.month && dueDate.day
    ? { year: dueDate.year, month: dueDate.month, day: dueDate.day, ...(item.dueTime ? { time: { hours: item.dueTime.hours, minutes: item.dueTime.minutes, seconds: item.dueTime.seconds } } : {}) }
    : undefined;
  return {
    ...(item.id ? { id: item.id } : {}), ...(item.courseId ? { courseId: item.courseId } : {}),
    ...(text(item.title, 500) ? { title: text(item.title, 500) } : {}), ...(text(item.description) ? { description: text(item.description) } : {}),
    ...(due ? { due } : {}), ...(typeof item.maxPoints === "number" ? { maxPoints: item.maxPoints } : {}),
    ...(item.workType ? { workType: item.workType } : {}), ...(item.state ? { state: item.state } : {}),
    ...dateFields(item), materials: materialSummary(item.materials),
  };
}
export function mapMaterial(item: classroom_v1.Schema$CourseWorkMaterial) {
  return { ...(item.id ? { id: item.id } : {}), ...(item.courseId ? { courseId: item.courseId } : {}), ...(text(item.title, 500) ? { title: text(item.title, 500) } : {}), ...(text(item.description) ? { description: text(item.description) } : {}), ...(item.topicId ? { topicId: item.topicId } : {}), ...dateFields(item), materials: materialSummary(item.materials) };
}
export function mapTopic(item: classroom_v1.Schema$Topic) {
  return { ...(item.topicId ? { id: item.topicId } : {}), ...(item.courseId ? { courseId: item.courseId } : {}), ...(text(item.name, 300) ? { name: text(item.name, 300) } : {}) };
}
export function mapSubmission(item: classroom_v1.Schema$StudentSubmission) {
  return { ...(item.courseId ? { courseId: item.courseId } : {}), ...(item.courseWorkId ? { courseWorkId: item.courseWorkId } : {}), ...(item.id ? { id: item.id } : {}), ...(item.state ? { state: item.state } : {}), ...(typeof item.assignedGrade === "number" ? { assignedGrade: item.assignedGrade } : {}), ...(typeof item.late === "boolean" ? { late: item.late } : {}), ...(item.updateTime ? { updatedAt: item.updateTime } : {}) };
}
export function publicError(error: unknown): string {
  const status = (error as { response?: { status?: number }; status?: number })?.response?.status ?? (error as { status?: number })?.status;
  if (status === 401) return "Google Classroom authorization expired. Reconnect your account.";
  if (status === 403) return "Permission not granted or this resource is not accessible.";
  if (status === 404) return "Course or resource not found.";
  if (status === 429 || (typeof status === "number" && status >= 500)) return "Google Classroom is temporarily unavailable. Try again later.";
  return "Google Classroom request failed. Check access and try again.";
}

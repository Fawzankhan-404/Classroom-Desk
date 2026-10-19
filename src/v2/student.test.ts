import { describe, expect, it, vi } from "vitest";
import { getStudentOverview } from "./student.js";
import type { V2Clients } from "./workflow.js";

type Options = {
  coursePage?: (pageToken?: string) => Promise<{ data: { courses?: unknown[]; nextPageToken?: string } }>;
  courseworkPage?: (pageToken?: string) => Promise<{ data: { courseWork?: unknown[]; nextPageToken?: string } }>;
};

function studentClients(options: Options = {}) {
  const courseRequests: Array<string | undefined> = [];
  const courseworkRequests: Array<string | undefined> = [];
  const submissionRequests: Array<{ userId?: string; pageToken?: string }> = [];
  const classroom = {
    courses: {
      list: vi.fn(async ({ pageToken }: { pageToken?: string }) => {
        courseRequests.push(pageToken);
        return options.coursePage
          ? options.coursePage(pageToken)
          : { data: { courses: [{ id: "course-1", name: "Biology", courseState: "ACTIVE" }] } };
      }),
      courseWork: {
        list: vi.fn(async ({ pageToken }: { pageToken?: string }) => {
          courseworkRequests.push(pageToken);
          return options.courseworkPage
            ? options.courseworkPage(pageToken)
            : { data: { courseWork: [] } };
        }),
        studentSubmissions: {
          list: vi.fn(async (params: { userId?: string; pageToken?: string }) => {
            submissionRequests.push(params);
            return { data: { studentSubmissions: [] } };
          }),
        },
      },
      announcements: { list: vi.fn(async () => ({ data: { announcements: [] } })) },
      courseWorkMaterials: { list: vi.fn(async () => ({ data: { courseWorkMaterial: [] } })) },
      topics: { list: vi.fn(async () => ({ data: { topic: [] } })) },
    },
  };
  // The V1 composer may limit its own reads to one page. Student aggregation
  // must follow Google continuation tokens using its explicit bounded reader.
  const clients = { classroom, drive: {}, subject: "synthetic-subject", publicPageLimit: 1 } as unknown as V2Clients;
  return { clients, courseRequests, courseworkRequests, submissionRequests };
}

describe("V2 Student bounded aggregate pagination", () => {
  it("includes later course pages and keeps submission reads scoped to the authenticated user", async () => {
    const fixture = studentClients({
      coursePage: async (pageToken) => pageToken === "courses-2"
        ? { data: { courses: [{ id: "course-2", name: "Chemistry", courseState: "ACTIVE" }] } }
        : { data: { courses: [{ id: "course-1", name: "Biology", courseState: "ACTIVE" }], nextPageToken: "courses-2" } },
    });

    const result = await getStudentOverview(fixture.clients, { limit: 10 });

    expect(fixture.courseRequests).toEqual([undefined, "courses-2"]);
    expect(result.courses.map((course) => course.id)).toEqual(["course-1", "course-2"]);
    expect(result.availability.coursesComplete).toBe(true);
    expect(result.pagination.courses).toMatchObject({ returned: 2, observed: 2, complete: true });
    expect(fixture.submissionRequests.every((request) => request.userId === "me")).toBe(true);
  });

  it("stops at the bounded page cap and marks the course results incomplete", async () => {
    const fixture = studentClients({
      coursePage: async (pageToken) => ({
        data: {
          courses: [],
          nextPageToken: pageToken === "courses-3" ? "courses-4" : `courses-${Number(pageToken?.split("-")[1] ?? 1) + 1}`,
        },
      }),
    });

    const result = await getStudentOverview(fixture.clients, {});

    expect(fixture.courseRequests).toEqual([undefined, "courses-2", "courses-3"]);
    expect(result.availability.coursesComplete).toBe(false);
    expect(result.pagination.maxPagesPerCollection).toBe(3);
    expect(result.pagination.pageCapReached).toBe(true);
    expect(result.pagination.courses).toMatchObject({ returned: 0, observed: 0, complete: false });
  });

  it("returns records from later coursework pages but marks the capped aggregate incomplete", async () => {
    const fixture = studentClients({
      courseworkPage: async (pageToken) => {
        const page = pageToken === "work-2" ? 2 : pageToken === "work-3" ? 3 : 1;
        return {
          data: {
            courseWork: [{ id: `work-${page}`, title: `Assignment ${page}`, workType: "ASSIGNMENT" }],
            nextPageToken: page < 3 ? `work-${page + 1}` : "work-4",
          },
        };
      },
    });

    const result = await getStudentOverview(fixture.clients, { courseQuery: "Biology", limit: 10 });

    expect(fixture.courseworkRequests).toEqual([undefined, "work-2", "work-3"]);
    expect(result.assignments.map((assignment) => assignment.courseWorkId)).toEqual(["work-1", "work-2", "work-3"]);
    expect(result.availability.courseworkComplete).toBe(false);
    expect(result.availability.assignmentResultsComplete).toBe(false);
    expect(result.summary.assignments).toBeNull();
    expect(result.pagination.assignments).toMatchObject({ returned: 3, observed: 3, complete: false });
    expect(result.pagination.pageCapReached).toBe(true);
  });
});

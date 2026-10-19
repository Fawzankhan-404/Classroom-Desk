import { describe, expect, it } from "vitest";
import { allPages, deadlineInWindow, driveIdsFromMaterials, dueAt } from "./classroom.js";

describe("Classroom helpers", () => {
  it("stops fetching at a public page budget", async () => {
    let calls = 0;
    const items = await allPages(async () => ({ items: [++calls], nextPageToken: "more" }), 1);
    expect(items).toEqual([1]);
    expect(calls).toBe(1);
  });
  it("builds an exact UTC deadline", () => {
    expect(dueAt({ dueDate: { year: 2026, month: 9, day: 30 }, dueTime: { hours: 12, minutes: 5 } })).toBe("2026-09-30T12:05:00.000Z");
  });

  it("preserves a date-only deadline without inventing a time", () => {
    expect(dueAt({ dueDate: { year: 2026, month: 9, day: 30 } })).toBe("2026-09-30");
  });

  it("includes date-only deadlines by UTC calendar day and timestamp deadlines by exact time", () => {
    const now = new Date("2026-09-30T18:00:00.000Z");
    expect(deadlineInWindow("2026-09-30", now, 1)).toBe(true);
    expect(deadlineInWindow("2026-10-01", now, 1)).toBe(true);
    expect(deadlineInWindow("2026-10-02", now, 1)).toBe(false);
    expect(deadlineInWindow("2026-09-30T17:59:00.000Z", now, 1)).toBe(false);
    expect(deadlineInWindow("2026-09-30T18:01:00.000Z", now, 1)).toBe(true);
  });

  it("returns only valid Drive attachment IDs", () => {
    expect(driveIdsFromMaterials([
      { driveFile: { driveFile: { id: "file-1" } } },
      { link: { url: "https://example.com" } },
      { driveFile: { driveFile: {} } },
    ])).toEqual(["file-1"]);
  });
});

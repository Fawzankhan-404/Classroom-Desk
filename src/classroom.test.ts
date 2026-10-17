import { describe, expect, it } from "vitest";
import { allPages, driveIdsFromMaterials, dueAt } from "./classroom.js";

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

  it("defaults date-only deadlines to the end of the UTC day", () => {
    expect(dueAt({ dueDate: { year: 2026, month: 9, day: 30 } })).toBe("2026-09-30T23:59:59.000Z");
  });

  it("returns only valid Drive attachment IDs", () => {
    expect(driveIdsFromMaterials([
      { driveFile: { driveFile: { id: "file-1" } } },
      { link: { url: "https://example.com" } },
      { driveFile: { driveFile: {} } },
    ])).toEqual(["file-1"]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer } from "node:http";
import { registerWebsiteRoutes } from "./website-routes.js";
import { sessionCookie } from "./sessions.js";
import type { SaaSUser } from "./types.js";
import type { WebsiteRouteOptions } from "./website-routes.js";

afterEach(() => vi.restoreAllMocks());

const token = "s".repeat(43);
const user = (id: string): SaaSUser => ({
  id, googleSubject: `google-subject-${id}`, email: `${id}@example.test`, displayName: "Synthetic test account",
  role: "STUDENT", status: "active", createdAt: new Date("2026-01-01T00:00:00Z"), lastLoginAt: null,
});

type HarnessControls = { setMcpBinding: (id: string, mcpId: string) => void; setTeacherEntitled: (value: boolean) => void; setPreferenceFailure: (value: boolean) => void; seedTeacherWriteFlow: (state: string) => void };

async function withServer(run: (origin: string, cookie: string, userId: () => string, setUserId: (id: string) => void, controls: HarnessControls) => Promise<void>, teacherEntitled = true, routeOverrides: Partial<WebsiteRouteOptions> = {}) {
  let currentUserId = "user-1";
  let activeTeacherEntitlement = teacherEntitled;
  let preferenceFailure = false;
  const preferences = new Map<string, "student" | "teacher">();
  const users = new Map([["user-1", user("user-1")], ["user-2", user("user-2")]]);
  const mcpBindings = new Map([["user-1", "user-1"], ["user-2", "user-2"]]);
  const ephemeral = new Map<string, unknown>();
  const completed = vi.fn(async () => undefined);
  const completedWrite = vi.fn(async () => undefined);
  const createDraft = vi.fn(async () => ({ status: "draft_created" }));
  const store = {
    sessions: { find: vi.fn(async (value: string) => value === token ? { id: "session-1", userId: currentUserId, expiresAt: new Date(Date.now() + 60_000) } : null) },
    getUser: vi.fn(async (id: string) => users.get(id) ?? null),
    getClassroomMcpUserId: vi.fn(async (id: string) => mcpBindings.get(id)),
    entitlement: vi.fn(async () => ({ allowed: activeTeacherEntitlement, plan: activeTeacherEntitlement ? "teacher" : null })),
    getDashboardExperience: vi.fn(async (id: string) => preferences.get(id) ?? null),
    setDashboardExperience: vi.fn(async (id: string, value: "student" | "teacher") => { if (preferenceFailure) throw new Error("preference_unavailable"); preferences.set(id, value); }),
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  registerWebsiteRoutes(app, {
    store: store as never,
    secureCookies: false,
    teacherFeaturesEnabled: true,
    oauthStateStore: {
      putEphemeral: vi.fn(async (kind: string, key: string, value: unknown) => { ephemeral.set(`${kind}:${key}`, value); }),
      takeEphemeral: vi.fn(async <T>(kind: string, key: string) => {
        const mapKey = `${kind}:${key}`;
        const value = ephemeral.get(mapKey) as T | undefined;
        ephemeral.delete(mapKey);
        return value;
      }),
    },
    beginTeacherAuthorization: vi.fn(async ({ state }: { state: string }) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`),
    completeTeacherAuthorization: completed,
    beginTeacherWriteAuthorization: vi.fn(async ({ state }: { state: string }) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`),
    completeTeacherWriteAuthorization: completedWrite,
    createTeacherCourseworkDraft: createDraft,
    loadClassroomDashboard: vi.fn(async () => ({ state: "not_connected" as const })),
    loadTeacherDashboard: vi.fn(async () => ({ state: "teacher_entitlement_required" as const })),
    ...routeOverrides,
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const controls: HarnessControls = {
    setMcpBinding: (id, mcpId) => { mcpBindings.set(id, mcpId); },
    setTeacherEntitled: value => { activeTeacherEntitlement = value; },
    setPreferenceFailure: value => { preferenceFailure = value; },
    seedTeacherWriteFlow: state => { ephemeral.set(`teacher_authorization:${state}`, { authorizationType: "write", userId: "user-1", mcpUserId: "user-1", verifier: "v".repeat(43), nonce: "n".repeat(32) }); },
  };
  try { await run(`http://127.0.0.1:${address.port}`, sessionCookie(token, false), () => currentUserId, id => { currentUserId = id; }, controls); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  return {
    store, completed, completedWrite, createDraft,
    setCurrentUserId: (id: string) => { currentUserId = id; },
  };
}

describe("authenticated dashboard routes", () => {
  it("passes a bounded teacher course cursor through the authenticated dashboard route", async () => {
    const loadTeacherDashboard = vi.fn(async (_userId: string, _pageToken?: string) => ({ state: "connected" as const, courses: [], nextCoursePageToken: "next-cursor", previousPageAvailable: true }));
    await withServer(async (origin, cookie) => {
      const response = await fetch(`${origin}/app/teacher?coursePageToken=synthetic-cursor`, { headers: { cookie } });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("First course page");
      expect(body).toContain("Next course page");
      expect(body).toContain("No teacher-managed courses were verified on this page");
    }, true, { loadTeacherDashboard });
    expect(loadTeacherDashboard).toHaveBeenCalledWith("user-1", "synthetic-cursor");
  });

  it("rejects malformed or oversized teacher course cursors", async () => {
    await withServer(async (origin, cookie) => {
      const response = await fetch(`${origin}/app/teacher?coursePageToken=${"x".repeat(4097)}`, { headers: { cookie } });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Invalid course page");
    });
  });

  it("persists dashboard preference per website account without changing the account role", async () => {
    const saved = await withServer(async (origin, cookie) => {
      const headers = { cookie, origin, "content-type": "application/x-www-form-urlencoded" };
      const first = await fetch(`${origin}/app`, { headers: { cookie }, redirect: "manual" });
      expect(first.status).toBe(303);
      expect(first.headers.get("location")).toBe("/app/experience");
      const selector = await fetch(`${origin}/app/experience`, { headers: { cookie }, redirect: "manual" });
      expect(selector.status).toBe(200);
      expect(await selector.text()).toContain('value="student"');
      const choose = await fetch(`${origin}/api/account/experience`, { method: "POST", headers, body: "experience=teacher", redirect: "manual" });
      expect(choose.status).toBe(303);
      const teacher = await fetch(`${origin}/app`, { headers: { cookie }, redirect: "manual" });
      expect(await teacher.text()).toContain("Teacher access required");
    });
    expect(saved.store.setDashboardExperience).toHaveBeenCalledWith("user-1", "teacher");
  });

  it("returns a JSON success response for the browser experience form", async () => {
    await withServer(async (origin, cookie) => {
      const response = await fetch(`${origin}/api/account/experience`, { method: "POST", headers: { cookie, origin, accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: "experience=student" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "saved", experience: "student", redirect: "/app" });
    });
  });

  it("explains expired sessions and preserves same-origin CSRF rejection", async () => {
    await withServer(async (origin) => {
      const expired = await fetch(`${origin}/api/account/experience`, { method: "POST", headers: { origin, accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: "experience=student" });
      expect(expired.status).toBe(401);
      expect(await expired.json()).toMatchObject({ error: "login_required", action: "/login?next=/app/experience" });
      const forged = await fetch(`${origin}/api/account/experience`, { method: "POST", headers: { cookie: "cd_session=" + token, origin: "https://attacker.invalid", accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: "experience=student" });
      expect(forged.status).toBe(403);
      expect(await forged.json()).toEqual({ error: "same_origin_required" });
    });
  });

  it("returns a friendly retryable error when preference persistence fails", async () => {
    await withServer(async (origin, cookie, _userId, _setUserId, controls) => {
      controls.setPreferenceFailure(true);
      const response = await fetch(`${origin}/api/account/experience`, { method: "POST", headers: { cookie, origin, accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: "experience=teacher" });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "preference_unavailable", message: "We could not save your dashboard choice. Try again in a moment." });
    });
  });

  it.each([
    ["authorization", 401, "Reconnect Google Classroom"],
    ["teacher_course_forbidden", 403, "Teacher access not confirmed"],
    ["google_unavailable", 503, "Teacher data temporarily unavailable"],
  ] as const)("maps normalized Google %s failures to a truthful dashboard response", async (code, status, title) => {
    await withServer(async (origin, cookie) => {
      const headers = { cookie };
      const course = await fetch(`${origin}/app/teacher/courses/course-1`, { headers, redirect: "manual" });
      expect(course.status).toBe(status);
      const courseBody = await course.text();
      expect(courseBody).toContain(title);
      expect(courseBody).toContain('<meta name="robots" content="noindex, nofollow">');
      const submissions = await fetch(`${origin}/app/teacher/courses/course-1/coursework/work-1`, { headers, redirect: "manual" });
      expect(submissions.status).toBe(status);
      expect(await submissions.text()).toContain(title);
    }, true, {
      loadTeacherCourse: async () => { throw Object.assign(new Error("synthetic Google failure"), { code }); },
      loadTeacherSubmissions: async () => { throw Object.assign(new Error("synthetic Google failure"), { code }); },
    });
  });

  it("binds teacher consent callback to the initiating website session and consumes state once", async () => {
    const harness = await withServer(async (origin, cookie) => {
      const start = await fetch(`${origin}/api/teacher/authorization`, { method: "POST", headers: { cookie, origin }, redirect: "manual" });
      expect(start.status).toBe(302);
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const stateCookie = start.headers.get("set-cookie")!.split(";", 1)[0]!;
      const callbackCookie = `${cookie}; ${stateCookie}`;
      const callback = await fetch(`${origin}/auth/google/callback?state=${encodeURIComponent(state)}&code=synthetic-code`, { headers: { cookie: callbackCookie }, redirect: "manual" });
      expect(callback.status).toBe(303);
      expect(callback.headers.get("location")).toBe("/app/teacher?authorization=complete");
      const replay = await fetch(`${origin}/auth/google/callback?state=${encodeURIComponent(state)}&code=synthetic-code`, { headers: { cookie: callbackCookie }, redirect: "manual" });
      expect(replay.status).toBe(400);
    });
    expect(harness.completed).toHaveBeenCalledTimes(1);
    expect(harness.completed).toHaveBeenCalledWith(expect.objectContaining({ mcpUserId: "user-1", expectedGoogleSubject: "google-subject-user-1", code: "synthetic-code" }));
  });

  it("uses an explicit legacy MCP link for teacher consent and rejects a link change during consent", async () => {
    const linked = await withServer(async (origin, cookie, _userId, _setUserId, controls) => {
      controls.setMcpBinding("user-1", "legacy-mcp-subject");
      const start = await fetch(`${origin}/api/teacher/authorization`, { method: "POST", headers: { cookie, origin }, redirect: "manual" });
      expect(start.status).toBe(302);
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const callbackCookie = `${cookie}; ${start.headers.get("set-cookie")!.split(";", 1)[0]}`;
      const callback = await fetch(`${origin}/auth/google/callback?state=${encodeURIComponent(state)}&code=synthetic-code`, { headers: { cookie: callbackCookie }, redirect: "manual" });
      expect(callback.status).toBe(303);
    });
    expect(linked.completed).toHaveBeenCalledWith(expect.objectContaining({ mcpUserId: "legacy-mcp-subject", expectedGoogleSubject: "google-subject-user-1" }));

    const changed = await withServer(async (origin, cookie, _userId, _setUserId, controls) => {
      controls.setMcpBinding("user-1", "legacy-mcp-subject");
      const start = await fetch(`${origin}/api/teacher/authorization`, { method: "POST", headers: { cookie, origin }, redirect: "manual" });
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const callbackCookie = `${cookie}; ${start.headers.get("set-cookie")!.split(";", 1)[0]}`;
      controls.setMcpBinding("user-1", "replacement-mcp-subject");
      const callback = await fetch(`${origin}/auth/google/callback?state=${encodeURIComponent(state)}&code=synthetic-code`, { headers: { cookie: callbackCookie }, redirect: "manual" });
      expect(callback.status).toBe(409);
    });
    expect(changed.completed).not.toHaveBeenCalled();
  });

  it("does not request extra Google permissions for an unentitled account", async () => {
    const harness = await withServer(async (origin, cookie) => {
      const start = await fetch(`${origin}/api/teacher/authorization`, { method: "POST", headers: { cookie, origin }, redirect: "manual" });
      expect(start.status).toBe(403);
      expect(await start.text()).toContain("Your Google access was not changed");
    }, false);
    expect(harness.store.entitlement).toHaveBeenCalledWith("user-1");
    expect(harness.store.sessions.find).toHaveBeenCalledTimes(1);
  });

  it("rejects callback use from a different account session", async () => {
    const harness = await withServer(async (origin, cookie, userId, setUserId) => {
      const start = await fetch(`${origin}/api/teacher/authorization`, { method: "POST", headers: { cookie, origin }, redirect: "manual" });
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const stateCookie = start.headers.get("set-cookie")!.split(";", 1)[0]!;
      const callbackCookie = `${cookie}; ${stateCookie}`;
      // Switch the active session after starting consent, as if another account replaced it.
      expect(userId()).toBe("user-1");
      setUserId("user-2");
      const callback = await fetch(`${origin}/auth/google/callback?state=${encodeURIComponent(state)}&code=synthetic-code`, { headers: { cookie: callbackCookie }, redirect: "manual" });
      expect(callback.status).toBe(403);
    });
    expect(harness.completed).not.toHaveBeenCalled();
  });

  it("requires same-origin confirmation for creating only a website-requested draft", async () => {
    const harness = await withServer(async (origin, cookie) => {
      const noOrigin = await fetch(`${origin}/api/teacher/courses/course-1/coursework/drafts`, {
        method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "title=Lab&confirm=yes", redirect: "manual",
      });
      expect(noOrigin.status).toBe(403);
      const unconfirmed = await fetch(`${origin}/api/teacher/courses/course-1/coursework/drafts`, {
        method: "POST", headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: "title=Lab", redirect: "manual",
      });
      expect(unconfirmed.status).toBe(400);
      expect(await unconfirmed.text()).toContain("No Classroom changes were made");
      const created = await fetch(`${origin}/api/teacher/courses/course-1/coursework/drafts`, {
        method: "POST", headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: "title=Lab&description=Read+chapter+4&dueDate=2026-11-30&dueTime=09%3A30&maxPoints=20&confirm=yes", redirect: "manual",
      });
      expect(created.status).toBe(303);
    }, true, { teacherDraftWritesEnabled: true });
    expect(harness.createDraft).toHaveBeenCalledTimes(1);
    expect(harness.createDraft).toHaveBeenCalledWith("user-1", "course-1", {
      title: "Lab", description: "Read chapter 4", dueDate: { year: 2026, month: 11, day: 30 }, dueTime: { hours: 9, minutes: 30 }, maxPoints: 20,
    });
  });

  it("rejects draft mutations without an active teacher entitlement or a linked Classroom identity", async () => {
    const deniedEntitlement = await withServer(async (origin, cookie) => {
      const response = await fetch(`${origin}/api/teacher/courses/course-1/coursework/drafts`, {
        method: "POST", headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: "title=Lab&confirm=yes", redirect: "manual",
      });
      expect(response.status).toBe(403);
    }, false, { teacherDraftWritesEnabled: true });
    expect(deniedEntitlement.createDraft).not.toHaveBeenCalled();

    const deniedBinding = await withServer(async (origin, cookie, _userId, _setUserId, controls) => {
      controls.setMcpBinding("user-1", "");
      const response = await fetch(`${origin}/api/teacher/courses/course-1/coursework/drafts`, {
        method: "POST", headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: "title=Lab&confirm=yes", redirect: "manual",
      });
      expect(response.status).toBe(409);
    }, true, { teacherDraftWritesEnabled: true });
    expect(deniedBinding.createDraft).not.toHaveBeenCalled();
  });

  it("keeps draft authorization and mutations on the website account when it has a legacy MCP identity", async () => {
    const harness = await withServer(async (origin, cookie, _userId, _setUserId, controls) => {
      controls.setMcpBinding("user-1", "legacy-mcp-subject");
      const start = await fetch(`${origin}/api/teacher/authorization/write`, { method: "POST", headers: { cookie, origin }, redirect: "manual" });
      expect(start.status).toBe(302);
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const callbackCookie = `${cookie}; ${start.headers.get("set-cookie")!.split(";", 1)[0]}`;
      const callback = await fetch(`${origin}/auth/google/callback?state=${encodeURIComponent(state)}&code=synthetic-code`, { headers: { cookie: callbackCookie }, redirect: "manual" });
      expect(callback.status).toBe(303);

      const created = await fetch(`${origin}/api/teacher/courses/course-1/coursework/drafts`, {
        method: "POST", headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: "title=Lab&confirm=yes", redirect: "manual",
      });
      expect(created.status).toBe(303);
    }, true, { teacherDraftWritesEnabled: true });
    expect(harness.completedWrite).toHaveBeenCalledWith(expect.objectContaining({ mcpUserId: "legacy-mcp-subject", expectedGoogleSubject: "google-subject-user-1" }));
    expect(harness.store.entitlement).toHaveBeenCalledWith("user-1");
    expect(harness.createDraft).toHaveBeenCalledWith("user-1", "course-1", expect.objectContaining({ title: "Lab" }));
  });

  it("reports draft-creation failures without implying existing coursework can be edited", async () => {
    await withServer(async (origin, cookie) => {
      const response = await fetch(`${origin}/api/teacher/courses/course-1/coursework/drafts`, {
        method: "POST", headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: "title=Lab&confirm=yes", redirect: "manual",
      });
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("Google did not authorize draft creation in that course");
      expect(html).not.toMatch(/coursework (?:can be )?edited/i);
    }, true, {
      teacherDraftWritesEnabled: true,
      createTeacherCourseworkDraft: async () => { throw Object.assign(new Error("synthetic failure"), { code: "teacher_course_forbidden" }); },
    });
  });

  it("binds expanded coursework consent to the account, link, entitlement and one-use state", async () => {
    const harness = await withServer(async (origin, cookie, _userId, setUserId) => {
      const start = await fetch(`${origin}/api/teacher/authorization/write`, { method: "POST", headers: { cookie, origin }, redirect: "manual" });
      expect(start.status).toBe(302);
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const stateCookie = start.headers.get("set-cookie")!.split(";", 1)[0]!;
      const callbackCookie = `${cookie}; ${stateCookie}`;
      setUserId("user-2");
      const mismatch = await fetch(`${origin}/auth/google/callback?state=${encodeURIComponent(state)}&code=synthetic-code`, { headers: { cookie: callbackCookie }, redirect: "manual" });
      expect(mismatch.status).toBe(403);
      setUserId("user-1");
      const replay = await fetch(`${origin}/auth/google/callback?state=${encodeURIComponent(state)}&code=synthetic-code`, { headers: { cookie: callbackCookie }, redirect: "manual" });
      expect(replay.status).toBe(400);
    }, true, { teacherDraftWritesEnabled: true });
    expect(harness.completedWrite).not.toHaveBeenCalled();
  });

  it("does not store expanded scopes when the Classroom account link changes before callback", async () => {
    const harness = await withServer(async (origin, cookie, _userId, _setUserId, controls) => {
      const start = await fetch(`${origin}/api/teacher/authorization/write`, { method: "POST", headers: { cookie, origin }, redirect: "manual" });
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const callbackCookie = `${cookie}; ${start.headers.get("set-cookie")!.split(";", 1)[0]}`;
      controls.setMcpBinding("user-1", "user-2");
      const callback = await fetch(`${origin}/auth/google/callback?state=${encodeURIComponent(state)}&code=synthetic-code`, { headers: { cookie: callbackCookie }, redirect: "manual" });
      expect(callback.status).toBe(409);
      expect(await callback.text()).toContain("No expanded permission was stored");
    }, true, { teacherDraftWritesEnabled: true });
    expect(harness.completedWrite).not.toHaveBeenCalled();
  });

  it("rechecks teacher entitlement before saving an expanded Google grant", async () => {
    const harness = await withServer(async (origin, cookie, _userId, _setUserId, controls) => {
      const start = await fetch(`${origin}/api/teacher/authorization/write`, { method: "POST", headers: { cookie, origin }, redirect: "manual" });
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const callbackCookie = `${cookie}; ${start.headers.get("set-cookie")!.split(";", 1)[0]}`;
      controls.setTeacherEntitled(false);
      const callback = await fetch(`${origin}/auth/google/callback?state=${encodeURIComponent(state)}&code=synthetic-code`, { headers: { cookie: callbackCookie }, redirect: "manual" });
      expect(callback.status).toBe(403);
      expect(await callback.text()).toContain("No additional Google permission was saved");
    }, true, { teacherDraftWritesEnabled: true });
    expect(harness.completedWrite).not.toHaveBeenCalled();
  });

  it("keeps draft authorization and mutation routes disabled by default", async () => {
    const harness = await withServer(async (origin, cookie, _userId, _setUserId, controls) => {
      const consent = await fetch(`${origin}/api/teacher/authorization/write`, { method: "POST", headers: { cookie, origin }, redirect: "manual" });
      expect(consent.status).toBe(503);
      const mutation = await fetch(`${origin}/api/teacher/courses/course-1/coursework/drafts`, {
        method: "POST", headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: "title=Lab&confirm=yes", redirect: "manual",
      });
      expect(mutation.status).toBe(503);
      const state = "s".repeat(32);
      controls.seedTeacherWriteFlow(state);
      const callback = await fetch(`${origin}/auth/google/callback?state=${state}&code=synthetic-code`, { headers: { cookie: `${cookie}; cd_login_state=${state}` }, redirect: "manual" });
      expect(callback.status).toBe(303);
      expect(callback.headers.get("location")).toContain("coursework_authorization=disabled");
    });
    expect(harness.createDraft).not.toHaveBeenCalled();
    expect(harness.completedWrite).not.toHaveBeenCalled();
  });
});

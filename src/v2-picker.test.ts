import { describe, expect, it } from "vitest";
import { AttachmentAuthorizationStore } from "./v2/attachments.js";
import { buildOnePickAuthorizationUrl, completePickerAuthorization, DRIVE_FILE_SCOPE, parseOnePickCallback, pickerConfigFromEnv, pickerSecurityHeaders, renderPickerPage } from "./v2/picker.js";

describe("V2 Google Picker boundary", () => {
  it("requires a numeric project number and a safe origin", () => {
    expect(() => pickerConfigFromEnv({ V2_GOOGLE_PICKER_API_KEY: "key", V2_GOOGLE_CLOUD_PROJECT_NUMBER: "project-name", V2_PICKER_BASE_URL: "https://beta.example" })).toThrow(/numeric/);
    expect(() => pickerConfigFromEnv({ V2_GOOGLE_PICKER_API_KEY: "key", V2_GOOGLE_CLOUD_PROJECT_NUMBER: "123", V2_PICKER_BASE_URL: "http://example.com" })).toThrow(/HTTPS/);
    expect(pickerConfigFromEnv({ V2_GOOGLE_PICKER_API_KEY: "key", V2_GOOGLE_CLOUD_PROJECT_NUMBER: "123", V2_PICKER_BASE_URL: "http://127.0.0.1:8792/path" })).toEqual({ apiKey: "key", appId: "123", baseUrl: "http://127.0.0.1:8792" });
  });

  it("builds and validates an exact-file drive.file one-pick flow", () => {
    const redirectUri = "http://127.0.0.1:8792/oauth/google/callback";
    const url = new URL(buildOnePickAuthorizationUrl({ clientId: "client", redirectUri, state: "opaque-state", codeChallenge: "challenge", fileId: "classroom-file" }));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")).toBe(DRIVE_FILE_SCOPE);
    expect(url.searchParams.get("trigger_onepick")).toBe("true");
    expect(url.searchParams.get("file_ids")).toBe("classroom-file");
    expect(url.searchParams.get("include_granted_scopes")).toBe("false");
    expect(parseOnePickCallback({ callbackUrl: `${redirectUri}?state=opaque-state&picked_file_ids=classroom-file&code=code-value&scope=${encodeURIComponent(DRIVE_FILE_SCOPE)}`, redirectUri, expectedState: "opaque-state", expectedFileId: "classroom-file" })).toEqual({ code: "code-value" });
    expect(() => parseOnePickCallback({ callbackUrl: `${redirectUri}?state=opaque-state&picked_file_ids=other&code=code-value&scope=${encodeURIComponent(DRIVE_FILE_SCOPE)}`, redirectUri, expectedState: "opaque-state", expectedFileId: "classroom-file" })).toThrow(/wrong_file/);
  });

  it("keeps the OAuth token out of URLs and escapes attachment text", () => {
    const page = renderPickerPage({ authorizationId: "opaque", expectedTitle: "</script><b>unsafe</b>", expectedFileId: "classroom-file", accessToken: "token-secret", config: { apiKey: "key", appId: "123", baseUrl: "http://127.0.0.1:8792" }, nonce: "nonce" });
    expect(page).toContain("ACCESS_TOKEN=\"token-secret\"");
    expect(page).not.toMatch(/https?:[^\"']*token-secret/);
    expect(page).not.toContain("<b>unsafe</b>");
    expect(page).toContain('EXPECTED_FILE_ID="classroom-file"');
    expect(page).toContain("<p>Classroom Desk</p>");
    expect(page).not.toContain("private beta");
    expect(page).toContain("setFileIds(EXPECTED_FILE_ID)");
    expect(page).toContain('.setOrigin("http://127.0.0.1:8792")');
    expect(page).toContain("/picker/status");
    expect(pickerSecurityHeaders("nonce")).toMatchObject({ "cache-control": expect.stringContaining("no-store"), "referrer-policy": "origin", "content-security-policy": expect.stringContaining("frame-ancestors 'none'") });
    expect(page).not.toContain("onload=");
    expect(page).toContain('nonce="nonce" src="https://apis.google.com/js/api.js"');
  });

  it("accepts only the Classroom-bound selected file and handles cancellation", () => {
    const store = new AttachmentAuthorizationStore();
    const attachment = { kind: "drive_file" as const, title: "Lesson.pdf", driveFileId: "classroom-file" };
    const first = store.create({ subject: "student-a", courseId: "c1", courseWorkId: "w1", attachment });
    expect(store.requirePending(first.id, "student-a").attachment.driveFileId).toBe("classroom-file");
    expect(() => store.requirePending(first.id, "student-b")).toThrow(/unavailable/);
    expect(() => completePickerAuthorization({ body: { authorizationId: first.id, action: "picked", fileId: "other-file" }, subject: "student-a", store })).toThrow(/Select the attachment/);
    completePickerAuthorization({ body: { authorizationId: first.id, action: "picked", fileId: "classroom-file" }, subject: "student-a", store });
    expect(() => store.requirePending(first.id, "student-a")).toThrow(/no longer awaiting/);
    expect(store.requireAuthorized(first.id, "student-a").status).toBe("authorized");
    const second = store.create({ subject: "student-a", courseId: "c1", courseWorkId: "w1", attachment });
    completePickerAuthorization({ body: { authorizationId: second.id, action: "cancelled" }, subject: "student-a", store });
    expect(() => store.requireAuthorized(second.id, "student-a")).toThrow(/declined/);
  });
});

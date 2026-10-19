import { afterEach, describe, expect, it, vi } from "vitest";
import { logOAuthCallbackRedirect, logOAuthCallbackRejected } from "./log.js";

describe("OAuth callback handoff diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("records only a fixed callback category and OAuth parameter presence", () => {
    const write = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = "synthetic-authorization-code-value";
    const state = "synthetic-client-state-value";
    logOAuthCallbackRedirect(`https://chatgpt.com/connector/oauth/test?code=${code}&state=${state}`, 303);

    const log = JSON.stringify(write.mock.calls[0]?.[0]);
    expect(write.mock.calls[0]?.[0]).toEqual({
      event: "oauth_callback_handoff",
      status: 303,
      destination: "chatgpt_connector",
      hasCode: true,
      hasState: true,
      hasError: false,
      source: "success",
    });
    expect(log).not.toContain(code);
    expect(log).not.toContain(state);
    expect(log).not.toContain("/connector/oauth/test");
  });

  it("never logs identifying text embedded in registered callback hosts or paths", () => {
    const write = vi.spyOn(console, "log").mockImplementation(() => {});
    logOAuthCallbackRedirect("https://synthetic-person.example.invalid/private-callback-identifier?code=opaque&state=opaque", 303);
    const log = JSON.stringify(write.mock.calls[0]?.[0]);
    expect(write.mock.calls[0]?.[0]).toMatchObject({ destination: "registered_callback", hasCode: true });
    expect(log).not.toContain("synthetic-person");
    expect(log).not.toContain("private-callback-identifier");
    expect(log).not.toContain("opaque");
  });

  it("distinguishes an OAuth error redirect without recording its value", () => {
    const write = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = "synthetic_access_denied_value";
    logOAuthCallbackRedirect(`https://chatgpt.com/connector/oauth/test?error=${error}&state=synthetic`, 303, error);

    const log = JSON.stringify(write.mock.calls[0]?.[0]);
    expect(write.mock.calls[0]?.[0]).toMatchObject({ status: 303, hasCode: false, hasState: true, hasError: true, source: "google", providerErrorCategory: "other", handoffErrorCategory: "other" });
    expect(log).not.toContain(error);
    expect(log).not.toContain("synthetic");
  });

  it("logs rejected callback requests without echoing request data", () => {
    const write = vi.spyOn(console, "log").mockImplementation(() => {});
    logOAuthCallbackRejected();
    expect(write.mock.calls[0]?.[0]).toEqual({
      event: "oauth_callback_handoff",
      status: 400,
      result: "rejected",
    });
  });

  it("classifies standard upstream and worker OAuth errors without logging raw values", () => {
    const write = vi.spyOn(console, "log").mockImplementation(() => {});
    logOAuthCallbackRedirect("https://chatgpt.com/connector/oauth/test?error=access_denied&state=opaque", 303, "access_denied");
    expect(write.mock.calls[0]?.[0]).toMatchObject({ source: "google", providerErrorCategory: "access_denied", handoffErrorCategory: "access_denied" });
    write.mockClear();
    logOAuthCallbackRedirect("https://chatgpt.com/connector/oauth/test?error=access_denied&state=opaque", 303);
    expect(write.mock.calls[0]?.[0]).toMatchObject({ source: "worker", handoffErrorCategory: "access_denied" });
  });
});

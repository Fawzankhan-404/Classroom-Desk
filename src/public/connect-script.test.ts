import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { Script } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicApp } from "./http.js";
import { MemoryPublicAuthStore } from "./store.js";

const source = ts.createSourceFile("http.ts", readFileSync(new URL("./http.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "connectScript");
if (!declaration) throw new Error("connectScript declaration missing");
const script = new Script(`${declaration.getText(source)}\nconnectScript();`).runInNewContext() as string;

function copyButton(label: string, options: { prompt?: boolean; span?: boolean; mcp?: boolean } = {}) {
  const attributes = new Map<string, string>();
  if (options.prompt) attributes.set("data-prompt-tab", "0");
  const spanAttributes = new Map<string, string>();
  const span = options.span ? { textContent: "Copy", setAttribute: (key: string, value: string) => spanAttributes.set(key, value) } : null;
  const question = { textContent: label };
  const childNodes = span ? [question, span] : [question];
  const replaceText = vi.fn((value: string) => { childNodes.splice(0, childNodes.length, { textContent: value }); });
  const handlers = new Map<string, Array<() => void | Promise<void>>>();
  const button = {
    dataset: options.mcp ? { copyMcp: "https://classroom.jarvis404.com/mcp" } : { copyPrompt: "What assignments do I have?" },
    childNodes,
    get textContent() { return childNodes.map(node => node.textContent).join(""); },
    set textContent(value: string) { replaceText(value); },
    querySelector: (selector: string) => selector === "span" ? span : null,
    hasAttribute: (name: string) => attributes.has(name),
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    addEventListener: (name: string, handler: () => void | Promise<void>) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    focus: vi.fn(),
  };
  return { button, span, question, attributes, spanAttributes, replaceText, click: () => Promise.all((handlers.get("click") ?? []).map(handler => handler())) };
}

function mount(buttons: ReturnType<typeof copyButton>[], writeText: ((value: string) => Promise<void>) | null = vi.fn().mockResolvedValue(undefined), fallback: () => boolean = () => true) {
  const area = { value: "", setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn() };
  const document = {
    querySelectorAll: (selector: string) => buttons.filter(({ button }) => selector === "[data-copy-mcp]" ? "copyMcp" in button.dataset : selector === "[data-copy-prompt]" ? "copyPrompt" in button.dataset : selector === "[data-prompt-tab]" && button.hasAttribute("data-prompt-tab")).map(({ button }) => button),
    querySelector: () => null,
    createElement: vi.fn(() => area),
    execCommand: vi.fn(fallback),
    body: { append: vi.fn() },
  };
  new Script(script).runInNewContext({ document, navigator: { clipboard: writeText ? { writeText } : undefined }, setTimeout, clearTimeout });
  return { document, area, writeText };
}

describe("connectScript copy feedback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps the question and child nodes while announcing feedback in the existing span", async () => {
    const tab = copyButton("What assignments do I have?", { prompt: true, span: true });
    const nodes = [...tab.button.childNodes];
    const { writeText } = mount([tab]);
    expect(tab.spanAttributes.get("aria-live")).toBe("polite");
    expect(tab.spanAttributes.get("aria-atomic")).toBe("true");
    expect(tab.attributes.has("aria-live")).toBe(false);
    await tab.click();
    expect(writeText).toHaveBeenCalledWith("What assignments do I have?");
    expect(tab.span?.textContent).toBe("Copied");
    expect(tab.button.childNodes).toEqual(nodes);
    expect(tab.question.textContent).toBe("What assignments do I have?");
    expect(tab.attributes.get("aria-selected")).toBe("true");
    vi.advanceTimersByTime(2000);
    expect(tab.span?.textContent).toBe("Copy");
    expect(tab.replaceText).not.toHaveBeenCalled();
  });

  it("restarts feedback on repeated clicks and restores the original label", async () => {
    const tab = copyButton("Question", { prompt: true, span: true });
    mount([tab]);
    await tab.click();
    vi.advanceTimersByTime(1500);
    await tab.click();
    vi.advanceTimersByTime(500);
    expect(tab.span?.textContent).toBe("Copied");
    vi.advanceTimersByTime(1500);
    expect(tab.span?.textContent).toBe("Copy");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores an older completion after a later click has finished", async () => {
    const tab = copyButton("Question", { prompt: true, span: true });
    let finishFirst!: () => void;
    const writeText = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finishFirst = resolve; })).mockResolvedValue(undefined);
    mount([tab], writeText);
    const first = tab.click();
    await tab.click();
    vi.advanceTimersByTime(2000);
    finishFirst();
    await first;
    expect(tab.span?.textContent).toBe("Copy");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports success only when the clipboard fallback succeeds and removes its textarea", async () => {
    const tab = copyButton("Question", { prompt: true, span: true });
    const ctx = mount([tab], vi.fn().mockRejectedValue(new Error("clipboard unavailable")));
    await tab.click();
    expect(ctx.document.execCommand).toHaveBeenCalledWith("copy");
    expect(ctx.area.value).toBe("What assignments do I have?");
    expect(ctx.area.remove).toHaveBeenCalledOnce();
    expect(tab.span?.textContent).toBe("Copied");
  });

  it.each(["false", "throw"])("reports failure honestly when both clipboard and fallback fail (%s)", async mode => {
    const tab = copyButton("Question", { prompt: true, span: true });
    const ctx = mount([tab], vi.fn().mockRejectedValue(new Error("clipboard unavailable")), () => {
      if (mode === "throw") throw new Error("copy blocked");
      return false;
    });
    await tab.click();
    expect(tab.span?.textContent).toBe("Copy failed");
    expect(ctx.area.remove).toHaveBeenCalledOnce();
    expect(tab.replaceText).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(tab.span?.textContent).toBe("Copy");
  });

  it("supports a missing Clipboard API", async () => {
    const button = copyButton("Copy", { mcp: true });
    const ctx = mount([button], null);
    await button.click();
    expect(ctx.document.execCommand).toHaveBeenCalledWith("copy");
    expect(button.button.textContent).toBe("Copied");
  });

  it.each([true, false])("keeps plain modal Copy buttons working (MCP: %s)", async mcp => {
    const button = copyButton("Copy", { mcp });
    const { writeText } = mount([button]);
    expect(button.attributes.get("aria-live")).toBe("polite");
    await button.click();
    expect(writeText).toHaveBeenCalledWith(mcp ? "https://classroom.jarvis404.com/mcp" : "What assignments do I have?");
    expect(button.button.textContent).toBe("Copied");
    vi.advanceTimersByTime(1000);
    await button.click();
    vi.advanceTimersByTime(2000);
    expect(button.button.textContent).toBe("Copy");
  });

  it("preserves a prompt tab even if its feedback span is absent", async () => {
    const tab = copyButton("Question", { prompt: true });
    const { writeText } = mount([tab]);
    await tab.click();
    expect(writeText).toHaveBeenCalledOnce();
    expect(tab.button.textContent).toBe("Question");
    expect(tab.replaceText).not.toHaveBeenCalled();
  });
});

it("serves the updated script over local HTTP with the existing tab and modal markup", async () => {
  const origin = new URL("http://127.0.0.1");
  const { app } = createPublicApp({ origin, mcpResource: new URL("/mcp", origin), googleCallbackUrl: new URL("/oauth/google/callback", origin).href, googleClientId: "test", googleClientSecret: "test", port: 0, production: false }, new MemoryPublicAuthStore());
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const asset = await fetch(`${base}/assets/connect.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    const delivered = await asset.text();
    expect(delivered.startsWith(script)).toBe(true);
    expect(() => new Script(delivered)).not.toThrow();
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('data-copy-prompt="What assignments do I have?">What assignments do I have?<span>Copy</span>');
    expect(html).toContain('data-copy-mcp="https://classroom.jarvis404.com/mcp">Copy</button>');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

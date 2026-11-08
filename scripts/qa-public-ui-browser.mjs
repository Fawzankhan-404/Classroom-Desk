import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicApp } from "../dist/public/http.js";
import { MemoryPublicAuthStore } from "../dist/public/store.js";

const root = path.resolve(import.meta.dirname, "..");
const outputDirectory = path.resolve(process.env.UI_QA_OUTPUT_DIR || path.join(os.tmpdir(), "classroom-desk-ui-stabilization-evidence"));
const phase = process.env.UI_QA_PHASE || "after";
const captureOnly = process.env.UI_QA_CAPTURE_ONLY === "1";
const chromePath = process.env.CHROME_PATH || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].find(candidate => existsSync(candidate));
assert.ok(chromePath, "Chrome/Chromium not found; set CHROME_PATH to its executable.");

const origin = new URL("http://127.0.0.1");
const { app } = createPublicApp({
  origin,
  mcpResource: new URL("/mcp", origin),
  googleCallbackUrl: `${origin.href}oauth/google/callback`,
  googleClientId: "ui-regression-client",
  googleClientSecret: "ui-regression-secret",
  port: 0,
  production: false,
}, new MemoryPublicAuthStore());
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const address = server.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const profile = await mkdtemp(path.join(os.tmpdir(), "classroom-desk-ui-chrome-"));
const browser = spawn(chromePath, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-component-update", "--remote-debugging-port=0",
  `--user-data-dir=${profile}`, "--window-size=1440,900", "about:blank",
], { stdio: "ignore", windowsHide: true });

let socket;
let sequence = 0;
const pending = new Map();
let passed = 0;
const results = [];
let lastClick = null;

function check(name, condition, detail = "") {
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ""}`);
  passed += 1;
  results.push({ name, result: "PASS", ...(detail ? { detail } : {}) });
}

async function waitForDebuggerPort() {
  const file = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(file)) return Number((await readFile(file, "utf8")).split(/\r?\n/)[0]);
    if (browser.exitCode !== null) throw new Error(`Browser exited with ${browser.exitCode}.`);
    await delay(100);
  }
  throw new Error("Chrome DevTools did not start within 10 seconds.");
}

function cdp(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 8000);
    pending.set(id, {
      resolve: value => { clearTimeout(timeout); resolve(value); },
      reject: error => { clearTimeout(timeout); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression, awaitPromise = false) {
  const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser evaluation failed.");
  return result.result?.value;
}

async function navigate(url) {
  await cdp("Page.navigate", { url });
  for (let i = 0; i < 100; i += 1) {
    const state = await evaluate("document.readyState");
    if (state === "complete" && await evaluate("!!document.querySelector('main')")) break;
    await delay(50);
  }
  await delay(200);
}

async function setViewport(width, height, mobile = width <= 767) {
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
}

async function screenshot(name) {
  const response = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  const file = path.join(outputDirectory, `${phase}-${name}.png`);
  await writeFile(file, Buffer.from(response.data, "base64"));
  return file;
}

async function click(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:"center",inline:"nearest",behavior:"instant"})`);
  await delay(60);
  const box = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r=e.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; return {x,y,disabled:e.disabled===true,hit:document.elementFromPoint(x,y)?.outerHTML?.slice(0,160)}; })()`);
  assert.ok(box, `Missing browser control: ${selector}`);
  assert.equal(box.disabled, false, `Control disabled: ${selector}`);
  lastClick = { selector, ...box };
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await delay(80);
}

try {
  await mkdir(outputDirectory, { recursive: true });
  const debugPort = await waitForDebuggerPort();
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const target = targets.find(item => item.type === "page");
  assert.ok(target?.webSocketDebuggerUrl, "Chrome page target is unavailable.");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    if (message.error) task.reject(new Error(message.error.message));
    else task.resolve(message.result || {});
  });

  await Promise.all([cdp("Page.enable"), cdp("Runtime.enable"), cdp("Emulation.setScriptExecutionDisabled", { value: false })]);
  await cdp("Browser.grantPermissions", { origin: base, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }).catch(() => undefined);

  const viewportResults = [];
  for (const width of [320, 375, 390, 768, 1440]) {
    await setViewport(width, width <= 767 ? 844 : width === 768 ? 1024 : 900);
    await navigate(`${base}/`);
    const geometry = await evaluate(`(() => {
      const selectors = ['.home-stage-inner','.home-copy','.home-copy h1','.home-intro','.home-copy .actions','[data-connection-card]','.home-console','.home-example-panel','.site-header'];
      const elements = selectors.map(selector => { const e=document.querySelector(selector); if(!e)return {selector,missing:true}; const r=e.getBoundingClientRect(); return {selector,left:Math.round(r.left),right:Math.round(r.right),width:Math.round(r.width),scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}; });
      return {width:innerWidth,layoutWidth:document.documentElement.clientWidth,documentWidth:document.documentElement.scrollWidth,elements};
    })()`);
    viewportResults.push(geometry);
    if (!captureOnly) {
      const broken = geometry.documentWidth > geometry.layoutWidth + 1 || geometry.elements.some(item => item.missing || item.left < -1 || item.right > geometry.layoutWidth + 1 || item.scrollWidth > item.clientWidth + 1);
      check(`No overflow or clipped content at ${width}px`, !broken, JSON.stringify(geometry));
    }
    if (width === 390 || width === 1440) await screenshot(`${width}x${width === 390 ? 844 : 900}`);
  }

  if (!captureOnly) {
    await setViewport(390, 844, true);
    await navigate(`${base}/`);
    const initial = await evaluate(`(() => { const c=document.querySelector('[data-connection-card]'); return {count:document.querySelectorAll('[data-connection-card]').length,progress:c?.querySelector('[data-connection-progress]')?.textContent.trim()}; })()`);
    check("Homepage guide is present at initial step", initial.count === 1 && initial.progress === "01 / 03", JSON.stringify(initial));
    await click("[data-connection-card] [data-connection-next]");
    check("Mouse Next advances and updates progress", await evaluate("document.querySelector('[data-connection-card] [data-connection-progress]').textContent.trim()") === "02 / 03");
    await click("[data-connection-card] [data-connection-next]");
    const afterSecondNext = await evaluate("(() => { const c=document.querySelector('[data-connection-card]'); return {progress:c.querySelector('[data-connection-progress]').textContent.trim(),step:c.querySelector('[data-connection-step]:not([hidden]) h3')?.textContent,disabled:c.querySelector('[data-connection-next]').disabled}; })()");
    check("Mouse Next reaches final step", afterSecondNext.progress === "03 / 03", JSON.stringify({ afterSecondNext, lastClick }));
    check("Next disables at final step", await evaluate("document.querySelector('[data-connection-card] [data-connection-next]').disabled") === true);
    await click("[data-connection-card] [data-connection-back]");
    check("Back reverses the same guide", await evaluate("document.querySelector('[data-connection-card] [data-connection-progress]').textContent.trim()") === "02 / 03");
    await evaluate("document.querySelector('[data-connection-card]').focus()");
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
    check("Keyboard navigation advances the focused guide", await evaluate("document.querySelector('[data-connection-card] [data-connection-progress]').textContent.trim()") === "03 / 03");
    await click("[data-connection-card] [data-connection-back]");
    check("Keyboard and mouse state stay synchronized", await evaluate("document.querySelector('[data-connection-card] [data-connection-progress]').textContent.trim()") === "02 / 03");
    await evaluate(`(() => { const c=document.querySelector('[data-connection-card]'); const start=new Touch({identifier:1,target:c,clientX:240,clientY:200}); const end=new Touch({identifier:1,target:c,clientX:160,clientY:200}); c.dispatchEvent(new TouchEvent('touchstart',{changedTouches:[start],bubbles:true})); c.dispatchEvent(new TouchEvent('touchend',{changedTouches:[end],bubbles:true})); })()`);
    check("Touch swipe advances the focused guide", await evaluate("document.querySelector('[data-connection-card] [data-connection-progress]').textContent.trim()") === "03 / 03");
    await click("[data-connection-card] [data-connection-back]");
    check("Touch and Back remain synchronized", await evaluate("document.querySelector('[data-connection-card] [data-connection-progress]').textContent.trim()") === "02 / 03");

    await evaluate(`(() => { const first=document.querySelector('[data-connection-card]'); const second=first.cloneNode(true); second.dataset.qaDuplicate='true'; document.body.append(second); })()`);
    const asset = await (await fetch(`${base}/assets/connect.js`)).text();
    await evaluate(`(new Function(${JSON.stringify(asset)}))()`);
    await click('[data-qa-duplicate="true"] [data-connection-next]');
    const multiple = await evaluate(`(() => [...document.querySelectorAll('[data-connection-card]')].map(c=>c.querySelector('[data-connection-progress]').textContent.trim()))()`);
    check("Multiple guide instances keep independent progress", multiple.length === 2 && multiple[0] === "01 / 03" && multiple[1] === "02 / 03", JSON.stringify(multiple));

    await setViewport(390, 844, true);
    await navigate(`${base}/connect`);
    const connectLayout = await evaluate("({viewport:document.documentElement.clientWidth,document:document.documentElement.scrollWidth,guide:document.querySelector('[data-connect-guide]')?.getBoundingClientRect().right})");
    check("Connection guide fits the 390px mobile viewport", connectLayout.document <= connectLayout.viewport + 1 && connectLayout.guide <= connectLayout.viewport + 1, JSON.stringify(connectLayout));
    await click('[data-connect-guide] [data-guide-next]');
    check("Connection guide Next reaches step 2", await evaluate("document.querySelector('[data-connect-guide] [data-guide-number]').textContent") === "2");
    await click('[data-connect-guide] [data-guide-next]');
    check("Connection guide Next reaches step 3", await evaluate("document.querySelector('[data-connect-guide] [data-guide-number]').textContent") === "3");
    await click('[data-connect-guide] [data-guide-next]');
    const completion = await evaluate(`(() => ({text:document.querySelector('[data-guide-completion]')?.textContent.trim(),visible:!!document.querySelector('[data-guide-completion]:not([hidden])'),button:document.querySelector('[data-connect-guide] [data-guide-next]')?.textContent.trim(),disabled:document.querySelector('[data-connect-guide] [data-guide-next]')?.disabled}))()`);
    check("Done shows truthful guide-completion state", completion.visible && /guide complete/i.test(completion.text) && /does not confirm/i.test(completion.text) && completion.disabled, JSON.stringify(completion));
    await click('[data-connect-guide] [data-guide-back]');
    check("Back reopens the guide without claiming connection", await evaluate("document.querySelector('[data-connect-guide] [data-guide-number]').textContent === '2' && document.querySelector('[data-guide-completion]').hidden"));
    await click('[data-connect-guide] [data-guide-next]');
    await click('[data-connect-guide] [data-guide-next]');

    await navigate(`${base}/`);
    await click('[data-connection-card] [data-connection-next]');
    await click('[data-connection-card] [data-copy-mcp-card]');
    const copyResult = await evaluate(`(async()=>({label:document.querySelector('[data-connection-card] [data-copy-mcp-card]').textContent.trim(),value:await navigator.clipboard.readText().catch(()=>null)}))()`, true);
    check("Homepage Copy copies the MCP URL and confirms it", copyResult.label === "Copied" && copyResult.value === "https://classroom.jarvis404.com/mcp", JSON.stringify(copyResult));
    check("Get Started points to the connection guide", await evaluate("document.querySelector('[data-connection-card] a[href=\"/connect\"]')?.getAttribute('href')") === "/connect");
    await click('[data-connection-card] a[href="/connect"]');
    check("Get Started opens the connection guide", await evaluate("location.pathname") === "/connect");
    await navigate(`${base}/`);
    await click('[data-prompt-tab="1"]');
    const promptTab = await evaluate(`(async()=>({selected:document.querySelector('[data-prompt-tab="1"]').getAttribute('aria-selected'),question:document.querySelector('[data-example-question]').textContent.trim(),copied:await navigator.clipboard.readText().catch(()=>null)}))()`, true);
    check("Example prompt selection and copy remain functional", promptTab.selected === "true" && promptTab.question === "What deadlines are coming up?" && promptTab.copied === "What deadlines are coming up?", JSON.stringify(promptTab));
    await click(".menu-toggle");
    check("Mobile navigation opens accessibly", await evaluate("document.querySelector('.menu-toggle').getAttribute('aria-expanded') === 'true' && !document.querySelector('#mobile-menu').hidden"));

    await navigate(`${base}/connect`);
    await click('[data-connect-guide] [data-guide-next]');
    await click('[data-connect-guide] [data-copy-mcp]');
    const connectCopy = await evaluate(`(async()=>({label:document.querySelector('[data-copy-mcp]').textContent.trim(),value:await navigator.clipboard.readText().catch(()=>null)}))()`, true);
    check("Connection-page Copy preserves the legacy MCP address", connectCopy.label === "Copied" && connectCopy.value === "https://classroom.jarvis404.com/mcp", JSON.stringify(connectCopy));
    check("Open ChatGPT link remains available", await evaluate("document.querySelector('[data-connect-guide] a[href=\"https://chatgpt.com/plugins\"]')?.textContent.trim()") === "Open ChatGPT");
  }

  const report = { phase, captureOnly, browser: path.basename(chromePath), base, screenshots: [path.join(outputDirectory, `${phase}-390x844.png`), path.join(outputDirectory, `${phase}-1440x900.png`)], viewportResults, passed, results };
  console.log(JSON.stringify(report, null, 2));
} finally {
  socket?.close();
  if (process.platform === "win32" && browser.pid) {
    try { execFileSync("taskkill.exe", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore" }); }
    catch { browser.kill(); }
  } else browser.kill();
  await new Promise(resolve => {
    if (browser.exitCode !== null) return resolve();
    browser.once("exit", resolve);
    setTimeout(resolve, 3000).unref();
  });
  await new Promise(resolve => server.close(() => resolve()));
  try { await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch { console.warn(`Browser profile cleanup pending at ${profile}`); }
}

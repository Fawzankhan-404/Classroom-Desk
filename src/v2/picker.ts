import type { AttachmentAuthorizationStore } from "./attachments.js";

export type V2PickerConfig = { apiKey: string; appId: string; baseUrl: string };
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export function buildOnePickAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  fileId: string;
}): string {
  if (!input.clientId.trim() || !input.state.trim() || !input.codeChallenge.trim() || !input.fileId.trim()) throw new Error("One-pick authorization configuration is incomplete.");
  const redirect = new URL(input.redirectUri);
  if (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && ["127.0.0.1", "localhost"].includes(redirect.hostname))) throw new Error("One-pick redirect must use HTTPS or an explicitly local origin.");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", redirect.toString());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", DRIVE_FILE_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("trigger_onepick", "true");
  url.searchParams.set("file_ids", input.fileId);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export function parseOnePickCallback(input: { callbackUrl: string; redirectUri: string; expectedState: string; expectedFileId: string }): { code: string } {
  const callback = new URL(input.callbackUrl);
  const redirect = new URL(input.redirectUri);
  if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname) throw new Error("onepick_redirect_mismatch");
  if (callback.searchParams.get("state") !== input.expectedState) throw new Error("onepick_state_mismatch");
  if (callback.searchParams.has("error")) throw new Error("onepick_authorization_denied");
  const picked = (callback.searchParams.get("picked_file_ids") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (picked.length !== 1 || picked[0] !== input.expectedFileId) throw new Error("onepick_wrong_file");
  const scopes = new Set((callback.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean));
  if (scopes.size !== 1 || !scopes.has(DRIVE_FILE_SCOPE)) throw new Error("onepick_scope_mismatch");
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("onepick_code_missing");
  return { code };
}

export function pickerSecurityHeaders(nonce: string): Record<string, string> {
  return {
    "cache-control": "no-store, max-age=0",
    pragma: "no-cache",
    // Google must receive the page origin to enforce the API key's HTTP referrer restriction.
    "referrer-policy": "origin",
    "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}' 'strict-dynamic' https://apis.google.com https://www.gstatic.com; style-src 'nonce-${nonce}'; connect-src 'self' https://content.googleapis.com https://www.googleapis.com; frame-src https://docs.google.com https://drive.google.com; img-src https://*.googleusercontent.com data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
}

export function pickerConfigFromEnv(env: Record<string, string | undefined> = process.env): V2PickerConfig {
  const apiKey = env.V2_GOOGLE_PICKER_API_KEY?.trim();
  const appId = env.V2_GOOGLE_CLOUD_PROJECT_NUMBER?.trim();
  const baseUrl = env.V2_PICKER_BASE_URL?.trim();
  if (!apiKey || !appId || !baseUrl) throw new Error("V2 Google Picker configuration is incomplete.");
  if (!/^\d+$/.test(appId)) throw new Error("V2 Google Picker App ID must be the numeric Cloud project number.");
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("V2 Picker must use HTTPS or an explicitly local origin.");
  return { apiKey, appId, baseUrl: url.origin };
}

const js = (value: string): string => JSON.stringify(value).replace(/</g, "\\u003c");
const html = (value: string): string => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** Render a one-purpose Picker page. The access token is never put in a URL. */
export function renderPickerPage(input: { authorizationId: string; expectedTitle: string; expectedFileId: string; accessToken: string; config: V2PickerConfig; nonce: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize teacher attachment · Classroom Desk</title><style nonce="${html(input.nonce)}">body{font:16px/1.5 system-ui;margin:0;background:#f5f8f6;color:#14251d}.card{max-width:650px;margin:8vh auto;padding:32px;background:white;border:1px solid #dce7e1;border-radius:20px;box-shadow:0 16px 50px #153d2920}button{background:#087f5b;color:white;border:0;border-radius:10px;padding:12px 18px;font-weight:700;font-size:16px}code{background:#edf5f1;padding:2px 6px;border-radius:5px}</style></head><body><main class="card"><p>Classroom Desk</p><h1>Allow one teacher attachment</h1><p>Select exactly <strong>${html(input.expectedTitle)}</strong>. Classroom Desk will receive access only to the file you choose.</p><button id="open" disabled>Choose this file in Google Drive</button><p id="status" role="status">Loading Google Picker…</p></main><script nonce="${html(input.nonce)}">
const AUTHORIZATION_ID=${js(input.authorizationId)};const EXPECTED_FILE_ID=${js(input.expectedFileId)};const ACCESS_TOKEN=${js(input.accessToken)};const API_KEY=${js(input.config.apiKey)};const APP_ID=${js(input.config.appId)};
let ready=false;let pollAttempts=0;function onApiLoad(){gapi.load('picker',()=>{ready=true;document.getElementById('open').disabled=false;document.getElementById('status').textContent='Ready. Google will show files from the signed-in account.'})}
async function finish(action,fileId){const response=await fetch('/picker/complete',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({authorizationId:AUTHORIZATION_ID,action,fileId})});document.getElementById('status').textContent=response.ok?(action==='picked'?'Authorized. Return to ChatGPT and ask Classroom Desk to read the file.':'Authorization cancelled. The file remains inaccessible.'):'Authorization could not be completed.'}
async function pollAccess(){if(pollAttempts++>=150)return;try{const response=await fetch('/picker/status',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({authorizationId:AUTHORIZATION_ID})});const data=await response.json();if(response.ok&&data.authorized){document.getElementById('status').textContent='Authorized. Return to ChatGPT and ask Classroom Desk to read the file.';return}}catch{}setTimeout(pollAccess,2000)}
function openPicker(){if(!ready)return;const view=new google.picker.DocsView(google.picker.ViewId.DOCS).setMode(google.picker.DocsViewMode.LIST).setFileIds(EXPECTED_FILE_ID);const picker=new google.picker.PickerBuilder().addView(view).setOAuthToken(ACCESS_TOKEN).setDeveloperKey(API_KEY).setAppId(APP_ID).setOrigin(${js(input.config.baseUrl)}).setTitle('Select the exact Classroom attachment').setCallback(data=>{const action=data[google.picker.Response.ACTION];if(action===google.picker.Action.PICKED){const docs=data[google.picker.Response.DOCUMENTS]||[];finish('picked',docs[0]?.[google.picker.Document.ID])}else if(action===google.picker.Action.CANCEL){finish('cancelled')}}).build();picker.setVisible(true);pollAttempts=0;setTimeout(pollAccess,1500)}
document.getElementById('open').addEventListener('click',openPicker);</script><script nonce="${html(input.nonce)}" src="https://apis.google.com/js/api.js"></script><script nonce="${html(input.nonce)}">onApiLoad()</script></body></html>`;
}

export function completePickerAuthorization(input: { body: unknown; subject: string; store: AttachmentAuthorizationStore }): void {
  const body = input.body as { authorizationId?: unknown; action?: unknown; fileId?: unknown };
  if (!body || typeof body.authorizationId !== "string" || !["picked", "cancelled"].includes(String(body.action))) throw new Error("Invalid Picker callback.");
  input.store.complete(body.authorizationId, input.subject, body.action === "picked" && typeof body.fileId === "string" ? body.fileId : undefined);
}

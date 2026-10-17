import type { SaaSUser, EffectiveEntitlement } from "./types.js";
import type { AdminUserHistory, AdminPayment } from "./admin.js";
import type {ConnectionStatus} from "./connection-status.js";
import { rubric, submissions } from "../hackathon/domain.js";

export interface AccountOverview {
  user: SaaSUser;
  entitlement: EffectiveEntitlement;
  history: AdminUserHistory;
  payments: AdminPayment[];
  linked: boolean;
  deletionRequested: boolean;
  connectionStatus?:ConnectionStatus;
  mcpStatus?: { state: string; message: string; plan: string | null; expiresAt: string | null; linked: boolean };
  dashboard?: StudentDashboardData;
}
export interface StudentDashboardData {
  courses: number | null;
  assignmentsShown?: number | null;
  upcomingAssignments: number | null;
  missingAssignments: number | null;
  sync: "connected" | "reauthorization_required" | "not_connected" | "permission_denied" | "api_error";
  partialData?: boolean;
  records?: {
    courses: Array<{ id?: string | null; name?: string | null; section?: string | null; state?: string | null }>;
    assignments: Array<{ courseName: string; title: string; dueAt: string | null; submissionState: string; late: boolean; missing: boolean; assignmentUrl: string | null; instructions?: string }>;
    announcements: Array<{ courseName?: string; text?: string; updatedAt?: string | null }>;
    courseMaterials: Array<{ courseName?: string; title?: string; description?: string; updatedAt?: string | null }>;
  };
}
export const html = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
const date = (value: Date | null | undefined) => value ? html(value.toISOString().slice(0, 10)) : "Not recorded";
const row = (name: string, value: unknown) => `<div><dt>${html(name)}</dt><dd>${html(value)}</dd></div>`;
export interface PortalRenderOptions { preview?: boolean; csrfToken?: string; scriptPath?: string; }

export function portalPage(title: string, user: SaaSUser, content: string, options: PortalRenderOptions = {}): string {
  const preview = options.preview === true;
  const scriptPath = options.scriptPath ?? (title === "Teacher demo" ? "/app/assets/teacher.js" : "/app/assets/account.js");
  const script = preview ? title === "Teacher demo" ? `<script src="${scriptPath}" defer></script>` : "" : `<script src="${scriptPath}" defer></script>`;
  const brand = preview ? '<span class="brand">Classroom Desk <span class="count-pill">DEMO</span></span><span class="identity">Synthetic preview</span>' : '<a class="brand" href="/"><img src="/assets/classroom-desk-logo.svg" width="32" height="32" alt="">Classroom Desk</a><details class="account"><summary>Account</summary><a href="/app">Profile</a><a href="/support">Help</a><form method="post" action="/session/end" data-account-action><button type="submit">Sign out</button></form></details>';
  const nav = preview ? [["Dashboard", "/app"], ["Choose experience", "/app/experience"], ["Teacher demo", "/app/teacher"]] : [["Profile", "/app"], ["Choose experience", "/app/experience"], ["Teacher demo", "/app/teacher"]];
  const footer = preview ? "<span>DEMO only · Synthetic records · No Google Classroom or gradebook access</span>" : '<a href="/connect">Connection guide</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/support">Support</a>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${html(title)} · Classroom Desk</title>${preview ? "" : '<link rel="icon" href="/assets/classroom-desk-favicon.svg">'}<style>${styles}</style>${options.csrfToken ? `<meta name="csrf-token" content="${html(options.csrfToken)}">` : ""}${script}</head><body><header>${brand}</header><nav aria-label="Account navigation">${nav.map(([label,url])=>`<a href="${url}" ${label===title?'aria-current="page"':''}>${label}</a>`).join("")}</nav><main><p class="eyebrow">${preview ? "DEMO workspace" : "Your account"}</p><h1>${html(title)}</h1><p class="identity">${html(preview ? "Synthetic demonstration account" : user.email)}</p><p id="action-feedback" role="status" aria-live="polite"></p>${content}</main><footer>${footer}</footer></body></html>`;
}

export type DashboardPreference = "student" | "teacher";

export function renderExperienceSelector(user: SaaSUser, selected: DashboardPreference | null, options: PortalRenderOptions = {}): string {
  const selectedLabel = selected === "teacher" ? "Teacher" : selected === "student" ? "Student" : "No preference saved yet";
  const option = (value: DashboardPreference, title: string, description: string, badge: string) => `<section class="experience-card"><p class="eyebrow">${badge}</p><h2>${title}</h2><p>${description}</p><form method="post" action="/api/dashboard/preference"><input type="hidden" name="dashboard" value="${value}">${options.csrfToken ? `<input type="hidden" name="csrf" value="${html(options.csrfToken)}">` : ""}<button type="submit" ${selected === value || (selected === null && value === "student") ? 'aria-pressed="true"' : ""}>${selected === value ? `Continue as ${title}` : selected === null && value === "student" ? "Continue as Student (default)" : `Choose ${title}`}</button></form></section>`;
  return portalPage("Choose experience", user, `<section><p class="eyebrow">Your dashboard</p><h2>Choose how you want to use Classroom Desk.</h2><p>This changes your dashboard preference only. It does not change your Google Classroom permissions. Classroom Desk is free to use.</p><p class="preference-state">Current preference: <strong>${selectedLabel}</strong></p></section><div class="experience-grid">${option("student", "Student", "Keep your existing student account, course, assignment and deadline experience. Student is the default.", "Recommended default")}${option("teacher", "Teacher", "Open a synthetic assessment demonstration. Real teacher data is available only after Google verifies teacher access.", "Demo workspace")}</div><style>.experience-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.experience-card{margin:18px 0}.experience-card h2{margin:4px 0 12px}.experience-card p:not(.eyebrow){min-height:3.2em}.preference-state{padding:12px 14px;background:#e4eee7;border-radius:6px}@media(max-width:620px){.experience-grid{grid-template-columns:1fr}.experience-card p:not(.eyebrow){min-height:0}}</style>`, options);
}

export function renderTeacherDashboard(user: SaaSUser, options: PortalRenderOptions = {}): string {
  const count = submissions.length;
  return portalPage("Teacher demo", user, `<section class="demo-banner" role="status"><p class="eyebrow">Synthetic demonstration · DEMO</p><h2>Teacher assessment · DEMO data only</h2><p>This workspace contains ${count} DEMO synthetic submissions and rubric version ${rubric.version}. Selecting Teacher does not grant Classroom permissions. Real rosters, submissions, or grades require verified Google teacher authorization.</p><p><strong>Gradebook writeback is disabled.</strong> Demo approval applies only to this synthetic assessment.</p></section><div class="assessment-grid" data-account-key="${html(user.id)}"><section><h2>DEMO synthetic submissions <span class="count-pill" id="submission-count">${count}</span></h2><div id="teacher-submissions" class="submission-list" aria-live="polite"><p>Loading synthetic assessment…</p></div></section><section><h2 id="submission-title">Choose a DEMO submission</h2><div id="submission-response" class="submission-response">All names and responses in this demonstration are synthetic.</div><p class="muted">Missing and unreadable work stays unscored and cannot be approved.</p></section><section class="rubric-panel"><h2>Teacher-confirmed DEMO rubric</h2><p><strong>${html(rubric.title)} · version ${rubric.version}</strong><br>Choose ${rubric.choose.count} choice criteria. ${rubric.maximumPoints} maximum points.</p><div class="choice-criteria" id="choice-criteria"></div><label class="optional-toggle"><input type="checkbox" id="include-optional"> Include optional editing criterion</label><div id="rubric-criteria"></div><p class="draft-total">Draft total <strong><span id="draft-total">0</span> points</strong></p><div class="actions"><button type="button" id="save-demo-draft">Save DEMO draft</button><button type="button" class="secondary" id="approve-demo-draft">Approve locally (DEMO)</button></div><p class="muted">Each positive mark needs an exact quote from the selected synthetic response. Approval remains local to this demo.</p></section><section><h2>DEMO assessment review</h2><div id="assessment-report" aria-live="polite"><p>Draft marks and review flags will appear here.</p></div></section></div><p><a href="/app/experience">Switch dashboard experience</a></p><style>.demo-banner{background:#e4eee7;border-color:#c6daca}.demo-banner h2{margin-bottom:6px}.assessment-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 18px}.assessment-grid>section{min-width:0}.submission-list{display:grid;gap:6px}.submission-option{display:flex;width:100%;justify-content:space-between;gap:10px;text-align:left;background:#fff;color:var(--ink);border-color:var(--line)}.submission-option[aria-pressed="true"]{background:#e4eee7;color:var(--green)}.submission-state{font-size:.8rem;color:var(--muted)}.submission-response{white-space:pre-wrap;overflow-wrap:anywhere;padding:14px;background:#f8f7f3;border:1px solid var(--line);border-radius:6px;min-height:110px}.review-flag{color:#815316;background:#fbf1dc;border-radius:5px;padding:8px 10px;margin:8px 0}.choice-criteria{display:flex;gap:10px;flex-wrap:wrap}.choice-criteria label,.optional-toggle{display:flex;gap:8px;align-items:center;background:#f8f7f3;border-radius:6px;padding:8px 10px}.rubric-row{display:grid;grid-template-columns:minmax(120px,1fr) 76px;gap:8px;align-items:center;border-bottom:1px solid var(--line);padding:12px 0}.rubric-row small{display:block;color:var(--muted)}.rubric-row input{max-width:76px}.rubric-row .evidence-input{grid-column:1/-1;max-width:none}.draft-total{display:flex;justify-content:space-between;border-top:1px solid var(--line);padding-top:12px}.count-pill{display:inline-block;background:#e4eee7;color:var(--green);font-size:.8rem;border-radius:999px;padding:2px 9px}@media(max-width:760px){.assessment-grid{grid-template-columns:1fr}.rubric-row{grid-template-columns:minmax(0,1fr) 68px}.actions button{flex:1}}</style>`, { ...options, scriptPath: "/app/assets/teacher.js" });
}
export function renderProfile(view: AccountOverview): string {
  const {user,history}=view;
  const mcp=view.mcpStatus;
  const mcpStatus=mcp?`${mcp.state}${mcp.linked?` · ${mcp.plan??"no plan"}${mcp.expiresAt?` until ${mcp.expiresAt.slice(0,10)}`:""}`:""}`:view.linked?"Status unavailable":"Authorization required";
  const mcpMessage=mcp?.message??"Connect Classroom Desk in ChatGPT and authorize your Google account to check access status.";
  const dashboard=view.dashboard;
  const dashboardMarkup = dashboard ? renderStudentDashboard(dashboard) : "";
  return portalPage("Profile", user, `${dashboardMarkup}<section><h2>${html(user.displayName)}</h2><dl>${row("Email",user.email)}${row("Member since",date(user.createdAt))}${row("Account status",user.status)}${row("Website sign-in","Signed in with Google")}</dl></section><section><h2>Google Classroom & ChatGPT</h2><p>Your Google identity establishes your Classroom Desk account during authorization.</p><dl>${row("Account authorization",view.linked?"Recorded":"Not linked")}${row("Google authorization for linked identity",view.connectionStatus==="authorized"?"Authorized":view.connectionStatus==="reauthorization_required"?"Reauthorization required":view.connectionStatus==="not_linked"?"No linked identity":"Status temporarily unavailable")}${row("Product access","Free")}${row("Google connection",mcpStatus)}</dl><p>${html(mcpMessage)}</p><p>The website cannot inspect ChatGPT’s private active connection or see which Google identity is selected there. Confirm the account in ChatGPT by listing courses. Google authorization status above applies to the server-side linked identity.</p><div class="actions"><a class="button" href="/connect">Connect to ChatGPT</a><button type="button" data-copy="https://classroom.jarvis404.com/mcp">Copy MCP URL</button><a href="/app/connection">Manage connection</a></div></section>${history.subscriptions.some(s=>s.status==="active"||s.status==="pending")?'<section><h2>Existing subscription</h2><p>Classroom Desk is free. Any existing recurring subscription may continue until you cancel it.</p><a class="button secondary" href="/app/subscription">Review or cancel subscription</a></section>':''}<section><h2>Account controls</h2><div class="actions"><a class="button secondary" href="/login?next=/app">Switch website account</a><form method="post" action="/session/end" data-account-action><button type="submit">Sign out</button></form></div><details><summary>Request account deletion</summary><p>This submits a request for review; it does not immediately delete records, cancel a subscription, or revoke Google access. See the <a href="/privacy">privacy and retention policy</a>.</p>${view.deletionRequested?'<p role="status">A deletion request is awaiting review.</p>':'<form method="post" action="/api/account/deletion-request" data-account-action><label>Reason (optional)<textarea name="reason" maxlength="1000"></textarea></label><label><input type="checkbox" name="confirm" value="yes" required> I request deletion of my signed-in account.</label><button type="submit">Submit deletion request</button></form>'}</details></section>`);
}

function renderStudentDashboard(dashboard: StudentDashboardData): string {
  const messages = {
    connected: "Live data was returned by Google Classroom for this signed-in account.",
    not_connected: "Connect Classroom Desk in ChatGPT and authorize the Google account that has your courses.",
    reauthorization_required: "Google authorization is missing or expired. Reconnect Classroom Desk in ChatGPT, then reload this page.",
    permission_denied: "Google did not grant the read-only Classroom permission needed for this information.",
    api_error: "Google Classroom could not be reached. Try again in a moment.",
  } as const;
  const records = dashboard.records;
  const courses = records?.courses ?? [];
  const assignments = records?.assignments ?? [];
  const announcements = records?.announcements ?? [];
  const materials = records?.courseMaterials ?? [];
  const classroomLink = (value: string | null) => {
    if (!value) return "";
    try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "classroom.google.com" ? url.href : ""; } catch { return ""; }
  };
  const courseItems = courses.length ? `<ul class="dashboard-list">${courses.map(course => `<li><strong>${html(course.name || "Unnamed course")}</strong>${course.section ? ` <span>${html(course.section)}</span>` : ""}</li>`).join("")}</ul>` : dashboard.sync === "connected" ? "<p>No active courses were returned by Google Classroom.</p>" : "";
  const assignmentItems = assignments.length ? `<ul class="dashboard-list">${assignments.map(item => {
    const href = classroomLink(item.assignmentUrl);
    const due = item.dueAt ? date(new Date(item.dueAt)) : "No due date";
    const flags = [item.missing ? "Missing" : "", item.late ? "Late" : ""].filter(Boolean).join(" · ");
    const submission = item.submissionState === "UNKNOWN" ? "Submission status unavailable" : item.submissionState;
    return `<li><strong>${href ? `<a href="${html(href)}" target="_blank" rel="noopener noreferrer">${html(item.title)}</a>` : html(item.title)}</strong><span>${html(item.courseName)} · Due ${html(due)} · ${html(submission)}${flags ? ` · ${html(flags)}` : ""}</span>${item.instructions ? `<p>${html(item.instructions.slice(0, 500))}</p>` : ""}</li>`;
  }).join("")}</ul>` : dashboard.sync === "connected" ? "<p>No assignments were returned for the accessible courses.</p>" : "";
  const announcementItems = announcements.length ? `<ul class="dashboard-list">${announcements.map(item => `<li><strong>${html(item.courseName || "Course announcement")}</strong><p>${html(item.text || "")}</p></li>`).join("")}</ul>` : "<p>No announcements were returned.</p>";
  const materialItems = materials.length ? `<ul class="dashboard-list">${materials.map(item => `<li><strong>${html(item.title || "Untitled material")}</strong><span>${html(item.courseName || "")}</span>${item.description ? `<p>${html(item.description.slice(0, 500))}</p>` : ""}</li>`).join("")}</ul>` : "<p>No learning materials were returned.</p>";
  return `<section class="student-dashboard"><p class="eyebrow">Student workspace · live Classroom data</p><h2>My Classroom</h2><p role="status">${html(messages[dashboard.sync])}${dashboard.partialData ? " Some Google collections were unavailable; details shown below may be incomplete." : ""}</p><dl>${row("Classroom sync",dashboard.sync.replaceAll("_"," "))}${row("Active courses",dashboard.courses == null ? "Not available" : String(dashboard.courses))}${row("Assignments shown",dashboard.assignmentsShown == null ? "Not available" : String(dashboard.assignmentsShown))}${row("Upcoming assignments",dashboard.upcomingAssignments == null ? "Not available" : String(dashboard.upcomingAssignments))}${row("Missing assignments",dashboard.missingAssignments == null ? "Not available" : String(dashboard.missingAssignments))}</dl>${dashboard.sync === "reauthorization_required" ? '<div class="actions"><a class="button" href="/connect">Reconnect in ChatGPT</a></div>' : ""}${records ? `<section><h3>Courses</h3>${courseItems}<h3>Assignments and deadlines</h3>${assignmentItems}<h3>Announcements</h3>${announcementItems}<h3>Learning materials</h3>${materialItems}</section>` : ""}<div class="actions"><a class="button" href="/connect">Ask ChatGPT about your coursework</a><a class="button secondary" href="/app/experience">Switch experience</a></div><style>.student-dashboard h3{margin-top:24px}.dashboard-list{display:grid;gap:10px;padding:0;list-style:none}.dashboard-list li{display:grid;gap:5px;padding:12px 14px;border:1px solid var(--line);border-radius:6px;background:#fff}.dashboard-list span{color:var(--muted);font-size:.92rem}.dashboard-list p{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}.student-dashboard section{margin-top:16px}</style></section>`;
}
export function renderSubscription(view: AccountOverview, _billingEnabled: boolean): string {
  const h=view.history;
  const subscriptions=h.subscriptions.length?`<ul>${h.subscriptions.map(s=>`<li>${html(s.plan)} · ${html(s.status)} · paid through ${date(s.paidThrough)}${s.status==="active"||s.status==="pending"?`<form method="post" action="/api/billing/subscription/cancel" data-cancel-subscription><input type="hidden" name="subscriptionId" value="${html(s.providerSubscriptionId??"")}"><button class="secondary" type="submit">Cancel future renewal</button></form>`:""}</li>`).join("")}</ul>`:'<p>No subscription is recorded for this account.</p>';
  return portalPage("Existing billing records",view.user,`<section><h2>Classroom Desk is free</h2><p>New payments and subscription enrollment are disabled. Historical payment records remain stored for accounting purposes.</p><h3>Existing subscriptions</h3>${subscriptions}<p id="billing-feedback" role="status" aria-live="polite"></p></section><section><h2>Payment history</h2>${view.payments.length?`<div class="table-scroll"><table><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Status</th></tr></thead><tbody>${view.payments.map(p=>`<tr><td>${date(p.createdAt)}</td><td>${html(p.kind)}</td><td>${html(p.currency)} ${(p.amountPaise/100).toFixed(2)}</td><td>${html(p.status)}</td></tr>`).join("")}</tbody></table></div>`:'<p>No payment records are available.</p>'}</section>`);
}
export function renderConnection(user: SaaSUser, status: { websiteSignedIn:boolean; linked:boolean; google:string; entitlement:string; activePlan:string; expiresAt:Date|null; trialStatus:string; mcpState:string }): string {
  return portalPage("Connection",user,`<section class="onboarding"><h2>Connect in ChatGPT</h2><ol><li>Choose Connect Classroom Desk in ChatGPT.</li><li>Sign in with Google and approve requested access if needed.</li><li>Return to ChatGPT and ask for status and your courses.</li></ol><p>Your verified Google identity establishes your Classroom Desk account. Returning users reuse valid authorization. Reconnect preserves your account.</p><dl><div><dt>Account authorization</dt><dd>${status.linked?"Connected account recorded":"Authorization required"}</dd></div><div><dt>Google authorization</dt><dd>${html(status.google)}</dd></div><div><dt>Product access</dt><dd>Free</dd></div><div><dt>ChatGPT connection</dt><dd>${html(status.mcpState)}</dd></div></dl><p>To use another account, choose Use another Google account during authorization. Google authorization remains specific to that account.</p><p>The website cannot inspect ChatGPT's private active connection. Verify status in ChatGPT.</p><a class="button" href="https://chatgpt.com/plugins">Open ChatGPT</a></section>`);
}
export const accountScript = `
document.addEventListener('click',async e=>{
 const b=e.target.closest('[data-copy]');if(!b)return;
 const s=document.querySelector('#action-feedback');
 const value=b.dataset.copy||'';
 try{
  if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(value);s.textContent='Copied to clipboard.';return;}
  throw new Error('clipboard_unavailable');
 }catch{
  try{
   const area=document.createElement('textarea');area.value=value;area.setAttribute('readonly','');area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();const copied=document.execCommand('copy');area.remove();if(copied){s.textContent='Copied to clipboard.';return;}
  }catch{}
  s.textContent='Copy unavailable. Select the displayed URL and copy it manually.';
 }
});
document.addEventListener('submit',async e=>{
 const f=e.target;if(!f.matches('[data-account-action]'))return;e.preventDefault();
 const b=e.submitter,s=document.querySelector('#action-feedback');if(b)b.disabled=true;s.textContent='Working…';
 try{
  const r=await fetch(f.action,{method:'POST',body:new URLSearchParams(new FormData(f)),credentials:'same-origin',headers:{'Accept':'application/json'}});
  if(!r.ok)throw new Error();
  const path=new URL(f.action).pathname;
  if(path==='/session/end'){location.assign('/');return;}
  s.textContent='Your deletion request was recorded for review. Your account remains active.';f.hidden=true;
 }catch{s.textContent='The request could not be completed. Your account state has not been confirmed. Try again or contact support.';if(b)b.disabled=false;}
});
 document.addEventListener('submit',async e=>{
  const f=e.target;if(!f.matches('[data-cancel-subscription]'))return;e.preventDefault();
  const b=e.submitter,out=document.querySelector('#billing-feedback');if(b)b.disabled=true;out.textContent='Cancelling future renewal…';
  try{const r=await fetch(f.action,{method:'POST',body:new URLSearchParams(new FormData(f)),credentials:'same-origin',headers:{'Accept':'application/json'}});const data=await r.json();if(!r.ok)throw new Error(data.error||'cancellation_failed');out.textContent='Future renewal cancelled. Existing paid access remains through the verified paid-through date.';f.hidden=true;}
  catch{out.textContent='Cancellation could not be confirmed. Contact support before the next renewal.';if(b)b.disabled=false;}
});`;
const styles=`:root{color-scheme:light;--ink:#202923;--muted:#536259;--paper:#f8f7f3;--line:#d7ded7;--green:#116444}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 system-ui,sans-serif}header,nav,main,footer{max-width:1040px;margin:auto;padding:20px 24px}header{display:flex;justify-content:space-between;gap:16px;align-items:center}.brand{display:flex;gap:10px;align-items:center;font-weight:750;text-decoration:none;color:var(--ink)}.account{position:relative}.account[open]{background:white;border:1px solid var(--line);padding:10px;border-radius:8px}.account a{display:block;padding:8px}nav{display:flex;gap:12px;border-bottom:1px solid var(--line);flex-wrap:wrap}nav a{padding:10px;text-decoration:none}nav a[aria-current]{background:#e4eee7;border-radius:6px;font-weight:700}a{color:var(--green);text-underline-offset:3px}main{max-width:900px;min-height:65vh}h1{font-size:clamp(2rem,5vw,3rem);line-height:1.15;margin:0}h2{font-size:1.35rem;margin:0 0 16px}.eyebrow{font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;color:var(--green);margin-bottom:6px}.identity{overflow-wrap:anywhere;color:var(--muted)}section{background:white;border:1px solid var(--line);border-radius:12px;padding:24px;margin:24px 0}.onboarding{padding:0;border:0;background:transparent}.setup-step h3{margin-top:0}.progress{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;padding:0;list-style:none}.progress li{border-top:3px solid var(--line);padding:8px 4px;color:var(--muted);font-size:.9rem}.progress li[data-state=complete]{border-color:#7ca48a;color:var(--green)}.progress li[aria-current=step]{border-color:var(--green);color:var(--ink);font-weight:700}.mcp-copy input{flex:1;min-width:min(100%,280px)}blockquote{margin:12px 0;padding:14px 18px;border-left:4px solid var(--green);background:#f2f6f2;overflow-wrap:anywhere}[hidden]{display:none!important}p,dt{color:var(--muted)}dl>div{display:grid;grid-template-columns:minmax(120px,1fr) 2fr;gap:16px;padding:10px 0;border-bottom:1px solid #ebeeeb}dd{margin:0;overflow-wrap:anywhere}button,.button{display:inline-flex;align-items:center;justify-content:center;background:var(--green);color:white;border:1px solid var(--green);border-radius:6px;padding:10px 16px;min-height:44px;font:600 15px/1.4 system-ui;cursor:pointer;text-decoration:none;text-align:center}.secondary{background:white;color:var(--green)}button:hover,.button:hover{background:#0a4b32;color:white}button:disabled{background:#e3e7e3;color:#536259;cursor:wait;border-color:#acb7ae}:focus-visible{outline:3px solid #0d7451;outline-offset:3px}.actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}form{margin:0}label{display:block;margin:14px 0}input:not([type=checkbox]),textarea{display:block;width:100%;padding:12px;border:1px solid #96a69a;border-radius:6px;font:inherit;color:var(--ink);background:white}summary{cursor:pointer;min-height:44px;padding:10px 0}footer{display:flex;flex-wrap:wrap;gap:20px;border-top:1px solid var(--line);font-size:14px}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;text-align:left}td,th{padding:12px;border-bottom:1px solid var(--line)}#action-feedback:not(:empty){border-left:3px solid var(--green);padding:12px;background:#e4eee7}@media(max-width:620px){header,nav,main,footer{padding:16px}section{padding:18px}dl>div{grid-template-columns:1fr;gap:2px}.brand{font-size:14px}nav{gap:0}nav a{font-size:14px}button,.button{max-width:100%}.progress{grid-template-columns:1fr 1fr}.progress li{font-size:.82rem}.mcp-copy .actions{align-items:stretch}.mcp-copy input{min-width:0;flex-basis:100%}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}`;

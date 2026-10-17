import type express from "express";
import { readSessionCookie } from "./sessions.js";
import { renderAdminBilling, renderAdminCRM, renderAdminReferrals, renderAdminUser } from "./admin.js";
import type { SaaSStore } from "./store.js";
import { requireSameOrigin } from "./csrf.js";
import {html,portalPage} from "./account-portal.js";

export function registerAdminRoutes(app: express.Express, store: SaaSStore): void {
  app.use("/admin", requireSameOrigin);
  app.use("/admin", (_req,res,next)=>{
    res.setHeader("Cache-Control","no-store");
    res.setHeader("Content-Security-Policy","default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    next();
  });
  app.get("/admin/audit",async(req,res)=>{
    const actor=await currentAdmin(req.get("cookie"),store);
    if(!actor)return res.status(403).type('text').send('Administrator access required.');
    const events=await store.adminAudit();
    return res.type('html').send(portalPage('Operational audit',actor,`<section><h2>Recent administrative actions</h2><p>Up to 50 recorded actions. Credentials and OAuth payloads are excluded.</p>${events.length?`<ul>${events.map(e=>`<li>${html(new Date(e.created_at).toISOString())} · ${html(e.action)} · ${html(e.reason)}</li>`).join('')}</ul>`:'<p>No administrative actions recorded.</p>'}<a href="/admin">Back to users</a></section>`));
  });
  app.get("/admin", async (req, res) => {
    const actor = await currentAdmin(req.get("cookie"), store);
    if (!actor) return res.status(403).type("text").send("Administrator access required.");
    const search = typeof req.query.search === "string" ? req.query.search : "";
    const role = typeof req.query.role === "string" ? req.query.role : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const subscription = typeof req.query.subscription === "string" ? req.query.subscription : undefined;
    const [metrics, users] = await Promise.all([store.adminMetrics(), store.listUsers(search, role, status, subscription)]);
    return res.type("html").send(renderAdminCRM(metrics, users, { search, role, status, subscription }));
  });
  app.get("/admin/billing", async (req, res) => {
    const actor = await currentAdmin(req.get("cookie"), store);
    if (!actor) return res.status(403).type("text").send("Administrator access required.");
    return res.type("html").send(renderAdminBilling(await store.adminPayments()));
  });
  app.get("/admin/referrals", async (req, res) => {
    const actor = await currentAdmin(req.get("cookie"), store);
    if (!actor) return res.status(403).type("text").send("Administrator access required.");
    return res.type("html").send(renderAdminReferrals(await store.adminReferrals()));
  });
  app.get(/^\/admin\/users\/([0-9a-f-]{36})$/, async (req, res) => {
    const actor = await currentAdmin(req.get("cookie"), store);
    if (!actor) return res.status(403).type("text").send("Administrator access required.");
    const user = await store.getUser(String(req.params[0] ?? ""));
    if (!user) return res.status(404).type("text").send("User record not found.");
    return res.type("html").send(renderAdminUser(user, await store.entitlement(user.id), await store.adminUserHistory(user.id)));
  });
  app.post("/admin/access-grants", async (req, res) => {
    const actor = await currentAdmin(req.get("cookie"), store);
    if (!actor) return res.status(403).json({ error: "admin_permission_required" });
    const targetId = typeof req.body?.targetUserId === "string" ? req.body.targetUserId : "";
    const plan = req.body?.plan === "teacher" ? "teacher" : req.body?.plan === "student" ? "student" : "";
    const durationDays = Number(req.body?.durationDays);
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
    if (!targetId || !plan || !Number.isFinite(durationDays)) return res.status(400).json({ error: "invalid_access_grant" });
    try { const grantId = await store.adminGrantAccess(actor.id, targetId, plan, durationDays * 24 * 60 * 60 * 1000, reason); return res.status(201).json({ grantId }); }
    catch (error) { return res.status(403).json({ error: error instanceof Error ? error.message : "access_grant_failed" }); }
  });
  app.post("/admin/access-grants/:grantId/extend", async (req, res) => {
    const actor = await currentAdmin(req.get("cookie"), store);
    if (!actor) return res.status(403).json({ error: "admin_permission_required" });
    const durationDays = Number(req.body?.durationDays);
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
    if (!Number.isFinite(durationDays)) return res.status(400).json({ error: "invalid_access_extension" });
    try { await store.adminExtendAccess(actor.id, String(req.params.grantId), durationDays * 24 * 60 * 60 * 1000, reason); return res.status(204).send(); }
    catch (error) { return res.status(403).json({ error: error instanceof Error ? error.message : "access_extension_failed" }); }
  });
  app.post("/admin/access-grants/:grantId/revoke", async (req, res) => {
    const actor = await currentAdmin(req.get("cookie"), store);
    if (!actor) return res.status(403).json({ error: "admin_permission_required" });
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
    try { await store.adminRevokeAccess(actor.id, String(req.params.grantId), reason); return res.status(204).send(); }
    catch (error) { return res.status(403).json({ error: error instanceof Error ? error.message : "access_revoke_failed" }); }
  });
  app.post(/^\/admin\/users\/([0-9a-f-]{36})\/status$/, async (req, res) => {
    const actor = await currentAdmin(req.get("cookie"), store);
    if (!actor) return res.status(403).json({ error: "admin_permission_required" });
    const status = req.body?.status === "suspended" ? "suspended" : req.body?.status === "active" ? "active" : "";
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
    if (!status) return res.status(400).json({ error: "invalid_status" });
    try { await store.adminSetStatus(actor.id, String(req.params[0] ?? ""), status, reason); return res.status(204).send(); }
    catch (error) { return res.status(403).json({ error: error instanceof Error ? error.message : "status_update_failed" }); }
  });
  app.post(/^\/admin\/users\/([0-9a-f-]{36})\/role$/, async (req, res) => {
    const actor = await currentAdmin(req.get("cookie"), store);
    if (!actor) return res.status(403).json({ error: "admin_permission_required" });
    const role = ["SUPER_ADMIN", "SUPPORT_ADMIN", "STUDENT", "TEACHER"].includes(req.body?.role) ? req.body.role : "";
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
    if (!role) return res.status(400).json({ error: "invalid_role" });
    try { await store.adminChangeRole(actor.id, String(req.params[0] ?? ""), role, reason); return res.status(204).send(); }
    catch (error) { return res.status(403).json({ error: error instanceof Error ? error.message : "role_update_failed" }); }
  });
}

async function currentAdmin(cookie: string | undefined, store: SaaSStore) {
  const token = readSessionCookie(cookie); if (!token) return null;
  const session = await store.sessions.find(token); if (!session) return null;
  const user = await store.getUser(session.userId); return user && (user.role === "SUPER_ADMIN" || user.role === "SUPPORT_ADMIN") && user.status === "active" ? user : null;
}

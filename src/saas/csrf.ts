import type express from "express";

/** Cookie-authenticated mutations must come from the same application origin. */
export function sameOriginMutation(req: express.Request): boolean {
  const origin = req.get("origin");
  const host = req.get("host");
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

export function requireSameOrigin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS" || sameOriginMutation(req)) return next();
  res.status(403).json({ error: "same_origin_required" });
}

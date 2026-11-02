// 47 Swag Co Studio: the dashboard at /app (schedule, approvals, post history, products).
// One password (DASHBOARD_PASSWORD, else CONNECTOR_SECRET) signs in; the session is a signed cookie.
// It installs as a desktop/phone app (manifest + service worker in public/app).
import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { readSchedule, scheduleState, scheduleSheetUrl, isApproved, decide, type Row, type RowState } from "./scheduler.js";

export type DashboardDeps = {
  products(): Promise<{ id: string; town: string; title: string; url: string; price_label: string; hold: boolean; status: string; slides: string[] }[]>;
  instagramMedia(): Promise<any[]>;
};

const PUBLIC = path.resolve("public/app");
const COOKIE = "studio";
const SESSION_DAYS = 30;
const password = () => process.env.DASHBOARD_PASSWORD || process.env.CONNECTOR_SECRET || "";

const mac = (v: string) => createHmac("sha256", `studio:${password()}`).update(v).digest("base64url");
const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
function signedIn(req: express.Request) {
  const c = (req.headers.cookie || "").split(/;\s*/).find((p) => p.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || "";
  const [exp, sig] = c.split(".");
  return !!exp && !!sig && Number(exp) > Date.now() && same(sig, mac(exp));
}

// Slow down password guessing: 10 tries per 15 min per address
const tries = new Map<string, { n: number; reset: number }>();
function tooMany(ip: string) {
  const now = Date.now(), t = tries.get(ip);
  if (!t || t.reset < now) { tries.set(ip, { n: 1, reset: now + 15 * 60_000 }); return false; }
  return ++t.n > 10;
}

// Google Drive links and drive:ID slides -> a thumbnail the signed-in browser can show
export function driveId(url: string) {
  return url.match(/^drive:([\w-]+)$/)?.[1] || url.match(/\/d\/([\w-]{20,})/)?.[1] || url.match(/[?&]id=([\w-]{20,})/)?.[1];
}
export const thumb = (url: string) => { const id = driveId(url); return id ? `https://drive.google.com/thumbnail?id=${id}&sz=w600` : url; };

function rowView(r: Row, s: RowState | undefined, products: Awaited<ReturnType<DashboardDeps["products"]>>) {
  const product = r.product_id ? products.find((p) => p.id === r.product_id) : undefined;
  const slides = r.media.length ? r.media : product?.slides.map((id) => `drive:${id}`) || [];
  const res = s?.result as any;
  const link = (x: any) => (x && !x.error ? x.permalink : undefined);
  const problems = [...r.problems, ...(product?.hold ? [`${product.id} is on HOLD (${product.status}), so it won't post`] : [])];
  const past = !!r.when && r.when.getTime() < Date.now() - 30 * 60_000; // the scheduler's grace period is over
  const state = s?.state || (past ? "missed" : problems.length ? "problem" : isApproved(r, s) ? "waiting" : s?.decision === "skipped" ? "skipped" : "draft");
  return {
    key: r.key, row: r.row, when: r.when?.toISOString(), date: r.date, time: r.time, type: r.type, platforms: r.platforms,
    product: product ? { id: product.id, town: product.town, title: product.title, url: product.url, hold: product.hold } : r.product_id ? { id: r.product_id } : undefined,
    caption: r.caption, instagram_caption: r.instagram_caption, first_comment: r.first_comment || product?.url,
    voiceover: r.voiceover, music: r.music, sheet_status: r.status, decision: s?.decision, state,
    approved: isApproved(r, s), problems, error: s?.error,
    video: s?.video_url || r.video, cover: s?.cover_url || r.cover,
    thumbs: (r.type === "post" ? r.media.slice(0, 1) : slides).map(thumb),
    links: res && typeof res === "object" ? { instagram: link(res.instagram), facebook: link(res.facebook), instagram_error: res.instagram?.error, facebook_error: res.facebook?.error } : undefined,
  };
}

export function dashboardRoutes(app: express.Express, deps: DashboardDeps) {
  // Install files are public (browsers fetch them without cookies); they hold no data
  for (const f of ["manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "sw.js"])
    app.get(`/app/${f}`, (_req, res) => res.sendFile(path.join(PUBLIC, f), { headers: f === "sw.js" ? { "Service-Worker-Allowed": "/app/" } : {} }));

  app.get("/app/login", (_req, res) => res.sendFile(path.join(PUBLIC, "login.html")));
  app.post("/app/login", express.urlencoded({ extended: false }), (req, res) => {
    if (tooMany(req.ip || "?")) return res.redirect(303, "/app/login?e=wait");
    const given = String(req.body?.password || "");
    if (!password() || !same(mac(given), mac(password()))) return res.redirect(303, "/app/login?e=wrong");
    const exp = String(Date.now() + SESSION_DAYS * 86_400_000);
    res.cookie(COOKIE, `${exp}.${mac(exp)}`, { httpOnly: true, secure: req.secure || req.headers["x-forwarded-proto"] === "https", sameSite: "strict", path: "/app", maxAge: SESSION_DAYS * 86_400_000 });
    res.redirect(303, "/app/");
  });
  app.post("/app/logout", (_req, res) => { res.clearCookie(COOKIE, { path: "/app" }); res.redirect(303, "/app/login"); });

  // Everything else needs a session; API writes also need the app's own header (blocks cross-site forms)
  app.use("/app", (req, res, next) => {
    if (!signedIn(req)) return req.path.startsWith("/api/") ? res.status(401).json({ error: "Signed out" }) : res.redirect(302, "/app/login");
    if (req.method !== "GET" && req.headers["x-studio"] !== "1") return res.status(403).json({ error: "Forbidden" });
    next();
  });

  const api = express.Router();
  api.use(express.json());
  const send = (fn: (req: express.Request) => Promise<unknown>) => async (req: express.Request, res: express.Response) => {
    try { res.json(await fn(req)); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  };

  api.get("/status", send(async () => ({
    sheet: scheduleSheetUrl() || null,
    scheduler: !scheduleSheetUrl() ? "not set up" : process.env.SCHEDULER_ENABLED === "false" ? "paused" : "on",
    now: new Date().toISOString(),
  })));

  api.get("/schedule", send(async () => {
    if (!scheduleSheetUrl()) return { rows: [], setup: true };
    const [rows, st, products] = await Promise.all([readSchedule(), scheduleState(), deps.products()]);
    return { rows: rows.map((r) => rowView(r, st[r.key], products)).sort((a, b) => (a.when || "").localeCompare(b.when || "")) };
  }));

  api.post("/rows/:key/:decision", send(async (req) => {
    const d = req.params.decision;
    if (d !== "approve" && d !== "skip" && d !== "reset") throw new Error("Use approve, skip or reset.");
    if (!(await readSchedule()).some((r) => r.key === req.params.key)) throw new Error("That row isn't in the sheet anymore. Refresh.");
    await decide(String(req.params.key), d === "approve" ? "approved" : d === "skip" ? "skipped" : null);
    return { ok: true };
  }));

  api.get("/history", send(async () => ({
    instagram: (await deps.instagramMedia()).map((m) => ({
      id: m.id, when: m.timestamp, type: m.media_product_type === "REELS" ? "reel" : m.media_type === "CAROUSEL_ALBUM" ? "carousel" : "post",
      caption: m.caption || "", permalink: m.permalink, image: m.thumbnail_url || m.media_url, likes: m.like_count ?? 0, comments: m.comments_count ?? 0,
    })),
  })));

  api.get("/products", send(async () => (await deps.products()).map((p) => ({ ...p, thumbs: p.slides.map((id) => thumb(`drive:${id}`)) }))));

  app.use("/app/api", api);
  app.use("/app", express.static(PUBLIC, { index: "index.html", maxAge: 0 }));
}

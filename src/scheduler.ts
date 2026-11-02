// Posting schedule read from a Google Sheet (shared "anyone with the link"), one row per post.
// Every minute: rows marked approved that are due get posted; reels without a finished MP4 are built ~25 min ahead.
// The server can't write to the sheet, so what it has done is kept in a small state file (and shown by schedule_status).
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type Platform = "instagram" | "facebook";
export type Row = {
  row: number; key: string; when?: Date; date: string; time: string; type: string; product_id?: string;
  platforms: Platform[]; caption: string; instagram_caption?: string; first_comment?: string;
  media: string[]; video?: string; cover?: string; voiceover?: string; music?: string; status: string; problems: string[];
};
// decision: Approve/Skip from the dashboard, which wins over the sheet's status column
export type RowState = { state?: "building" | "built" | "posting" | "posted" | "failed" | "missed"; decision?: "approved" | "skipped"; at: string; video_url?: string; cover_url?: string; result?: unknown; error?: string };
export type SchedulerDeps = {
  validate(row: Row): Promise<string[]>; // extra problems (unknown product, HOLD...)
  build(row: Row): Promise<{ video_url: string; cover_url?: string }>;
  publishReel(row: Row, video: { video_url: string; cover_url?: string }): Promise<Record<string, any>>;
  publishPost(row: Row): Promise<Record<string, any>>;
  alreadyPosted(row: Row): Promise<boolean>; // guards against reposting after a restart
};

const TZ = "America/New_York";
const BUILD_AHEAD_MS = 25 * 60_000; // start building a reel this long before it's due
const GRACE_MS = 30 * 60_000; // a row more than this late is skipped, not posted late
const stateFile = () => path.resolve(process.env.SCHEDULE_STATE_FILE || "data/schedule-state.json");
const APPROVED = new Set(["approved", "yes", "go", "ready"]);

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Offset of Eastern time from UTC (ms) at a given instant
function tzOffset(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(utcMs));
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute")) - utcMs;
}

// "2026-11-02" or "11/2/2026", and "11:30", "11:30 AM" or "9am", read as Eastern time
export function easternTime(date: string, time: string): Date | undefined {
  const iso = date.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/), us = date.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  const t = time.trim().match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap]\.?m\.?)?$/i);
  if (!(iso || us) || !t) return undefined;
  const [y, mo, d] = iso ? [+iso[1], +iso[2], +iso[3]] : [+us![3] < 100 ? 2000 + +us![3] : +us![3], +us![1], +us![2]];
  let h = +t[1];
  const mi = +(t[2] || 0), ap = t[3]?.[0].toLowerCase();
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  if (h > 23 || mi > 59 || mo > 12 || d > 31) return undefined;
  const local = Date.UTC(y, mo - 1, d, h, mi);
  return new Date(local - tzOffset(local - tzOffset(local)));
}

export function sheetCsvUrl(url: string): string {
  const id = url.match(/\/spreadsheets\/d\/([\w-]+)/)?.[1];
  if (!id && /^https?:\/\/.+\.csv(\?|$)/i.test(url)) return url; // a plain CSV file (local testing)
  if (!id) throw new Error(`${url} isn't a Google Sheets link.`);
  const gid = url.match(/[#&?]gid=(\d+)/)?.[1];
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ""}`;
}

const splitList = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

export function parseRows(csv: string): Row[] {
  const [header, ...lines] = parseCsv(csv);
  if (!header) return [];
  const cols = header.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));
  return lines.flatMap((cells, i) => {
    const get = (name: string) => (cells[cols.indexOf(name)] ?? "").trim();
    if (!cells.some((c) => c.trim())) return [];
    const problems: string[] = [];
    const date = get("date"), time = get("time"), type = (get("type") || "reel").toLowerCase();
    const when = easternTime(date, time);
    if (!when) problems.push(`date/time "${date} ${time}" isn't readable (use 2026-11-02 and 11:30 AM)`);
    if (type !== "reel" && type !== "post") problems.push(`type "${type}" should be reel or post`);
    const platforms = (splitList(get("platforms").toLowerCase()).length ? splitList(get("platforms").toLowerCase()) : ["instagram", "facebook"])
      .map((p) => (p === "ig" ? "instagram" : p === "fb" ? "facebook" : p));
    const bad = platforms.filter((p) => p !== "instagram" && p !== "facebook");
    if (bad.length) problems.push(`unknown platform ${bad.join(", ")}`);
    const caption = get("caption");
    if (!caption) problems.push("caption is empty");
    const media = splitList(get("media"));
    const video = get("video") || undefined;
    if (type === "post" && !media.length) problems.push("a post needs an image link in media");
    if (type === "reel" && !video && !media.length && !get("product_id")) problems.push("a reel needs a video link, slide links in media, or a product_id with a slide set");
    const r: Omit<Row, "key"> = {
      row: i + 2, when, date, time, type, product_id: get("product_id").toUpperCase() || undefined,
      platforms: platforms as Platform[], caption, instagram_caption: get("instagram_caption") || undefined,
      first_comment: get("first_comment") || undefined, media, video, cover: get("cover") || undefined, voiceover: get("voiceover") || undefined,
      music: get("music") || undefined, status: get("status").toLowerCase(), problems,
    };
    // Same row content -> same key, so a row is posted once even if rows above it move
    const key = createHash("sha1").update(JSON.stringify([date, time, type, r.product_id, r.platforms, caption, r.instagram_caption, media, video])).digest("hex").slice(0, 16);
    return [{ ...r, key }];
  });
}

export function scheduleSheetUrl(): string | undefined {
  return process.env.SCHEDULE_SHEET_URL || undefined;
}

export async function readSchedule(): Promise<Row[]> {
  const url = scheduleSheetUrl();
  if (!url) throw new Error("No schedule sheet set. Set SCHEDULE_SHEET_URL to the Google Sheet's link.");
  const res = await fetch(sheetCsvUrl(url));
  const text = await res.text();
  if (!res.ok || /^\s*<(!doctype|html)/i.test(text)) throw new Error(`Couldn't read the schedule sheet (HTTP ${res.status}). Share it as "Anyone with the link" (viewer).`);
  return parseRows(text);
}

export const isApproved = (r: Row, s?: RowState) => (s?.decision ? s.decision === "approved" : APPROVED.has(r.status));
export const needsBuild = (r: Row) => r.type === "reel" && !r.video; // finished video given, or build one from slides

let state: Record<string, RowState> = {};
let loaded = false;
async function loadState() {
  if (loaded) return;
  loaded = true;
  state = JSON.parse(await readFile(stateFile(), "utf8").catch(() => "{}"));
}
async function saveState() {
  await mkdir(path.dirname(stateFile()), { recursive: true });
  await writeFile(stateFile(), JSON.stringify(state, null, 1));
}
const set = async (key: string, s: Omit<RowState, "at">) => { state[key] = { ...state[key], ...s, at: new Date().toISOString() }; await saveState(); };

export async function scheduleState() { await loadState(); return state; }

// Approve or skip a row from the dashboard (null goes back to the sheet's status); posted rows can't change
export async function decide(key: string, decision: "approved" | "skipped" | null) {
  await loadState();
  const s = state[key];
  if (s?.state === "posting" || s?.state === "posted") throw new Error("That post has already gone out.");
  if (decision) await set(key, { decision });
  else if (s) { delete s.decision; await saveState(); }
}

const inFlight = new Set<string>();
const succeeded = (out: Record<string, any>, platforms: Platform[]) => platforms.some((p) => out[p] && !out[p].error);

// One pass over the sheet: build what's coming up, post what's due
export async function tick(deps: SchedulerDeps, now = Date.now()) {
  await loadState();
  const rows = await readSchedule();
  for (const r of rows) {
    const s = state[r.key];
    if (!isApproved(r, s) || !r.when || inFlight.has(r.key)) continue;
    if (s?.state && ["posted", "failed", "missed", "posting"].includes(s.state)) continue;
    const due = r.when.getTime();
    if (now - due > GRACE_MS) { await set(r.key, { state: "missed", error: `Not posted: it was due at ${r.date} ${r.time} and the server wasn't ready within 30 min.` }); continue; }
    if (now < due - BUILD_AHEAD_MS) continue;

    const problems = [...r.problems, ...(await deps.validate(r))];
    if (problems.length) { await set(r.key, { state: "failed", error: problems.join("; ") }); continue; }

    if (needsBuild(r) && s?.state !== "built") {
      inFlight.add(r.key);
      await set(r.key, { state: "building" });
      deps.build(r)
        .then((v) => set(r.key, { state: "built", ...v }))
        .catch((e) => set(r.key, { state: "failed", error: `Build failed: ${(e as Error).message}` }))
        .finally(() => inFlight.delete(r.key));
      continue;
    }
    if (now < due) continue;

    inFlight.add(r.key);
    await set(r.key, { state: "posting" });
    (async () => {
      try {
        if (await deps.alreadyPosted(r)) return await set(r.key, { state: "posted", result: "Already on Instagram (found the same caption); not posted again." });
        const out = r.type === "post" ? await deps.publishPost(r)
          : await deps.publishReel(r, s?.video_url ? { video_url: s.video_url, cover_url: s.cover_url } : { video_url: r.video!, cover_url: r.cover });
        await set(r.key, succeeded(out, r.platforms) ? { state: "posted", result: out } : { state: "failed", result: out, error: "Every platform refused the post." });
      } catch (e) {
        await set(r.key, { state: "failed", error: (e as Error).message });
      } finally { inFlight.delete(r.key); }
    })();
  }
  return rows;
}

export function startScheduler(deps: SchedulerDeps) {
  if (!scheduleSheetUrl() || process.env.SCHEDULER_ENABLED === "false") {
    console.log("Scheduler off (set SCHEDULE_SHEET_URL to turn it on).");
    return;
  }
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await tick(deps); } catch (e) { console.error("Scheduler:", (e as Error).message); } finally { running = false; }
  };
  setTimeout(run, 15_000).unref();
  setInterval(run, 60_000).unref();
  console.log("Scheduler on: checking the schedule sheet every minute.");
}

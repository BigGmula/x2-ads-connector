import express from "express";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { meta, actId } from "./meta.js";
import { google, cid } from "./google.js";
import { buildReel, listTracks, pickTracks, driveDownloadUrl } from "./reel.js";
import { hostFile, mediaRoutes } from "./hosting.js";
import { fillScript } from "./scripts.js";

// ---------- Safety rails ----------
const READ_ONLY = (process.env.ADS_READ_ONLY || "false").toLowerCase() === "true";
const MAX_DAILY_BUDGET = Number(process.env.MAX_DAILY_BUDGET || 100); // dollars/day, hard cap on any budget this server sets

function guardWrite() {
  if (READ_ONLY) throw new Error("This connector is in READ-ONLY mode (ADS_READ_ONLY=true). No changes were made.");
}
function guardBudget(dollars: number) {
  if (!(dollars > 0)) throw new Error("Budget must be greater than 0.");
  if (dollars > MAX_DAILY_BUDGET)
    throw new Error(`Refused: $${dollars}/day is above your safety cap of $${MAX_DAILY_BUDGET}/day (MAX_DAILY_BUDGET). Raise the cap in your server settings if you really mean it.`);
}
function needConfirm(confirm: boolean | undefined, what: string) {
  if (!confirm)
    throw new Error(`Not done yet: ${what} spends money. Show the user exactly what will change and ask them to approve, then call again with confirm: true.`);
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] });
const wrap = <A>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
  try { return ok(await fn(a)); } catch (e) { return fail(e); }
};

const DateRange = z.enum(["today", "yesterday", "last_7d", "last_14d", "last_30d", "this_month", "last_month"]).default("last_7d");
const GOOGLE_DATES: Record<string, string> = {
  today: "TODAY", yesterday: "YESTERDAY", last_7d: "LAST_7_DAYS", last_14d: "LAST_14_DAYS",
  last_30d: "LAST_30_DAYS", this_month: "THIS_MONTH", last_month: "LAST_MONTH",
};
const money = (micros: unknown) => Math.round(Number(micros || 0) / 10_000) / 100;

function tidyGoogleCampaign(r: any) {
  const m = r.metrics || {};
  const cost = money(m.costMicros);
  return {
    id: r.campaign?.id, name: r.campaign?.name, status: r.campaign?.status, type: r.campaign?.advertisingChannelType,
    daily_budget: money(r.campaignBudget?.amountMicros), budget_resource: r.campaignBudget?.resourceName,
    spend: cost, impressions: Number(m.impressions || 0), clicks: Number(m.clicks || 0),
    ctr_pct: Math.round(Number(m.ctr || 0) * 10000) / 100, avg_cpc: money(m.averageCpc),
    conversions: Number(m.conversions || 0), conv_value: Number(m.conversionsValue || 0),
    cost_per_conv: Number(m.conversions) ? Math.round((cost / Number(m.conversions)) * 100) / 100 : null,
    roas: cost ? Math.round((Number(m.conversionsValue || 0) / cost) * 100) / 100 : null,
  };
}

// Designed 5-slide reel sets in Google Drive, indexed by product ID (P01...)
type SlideSet = { id: string; town: string; title: string; url: string; price_label: string; hold: boolean; status: string; slides: string[] };
const SLIDE_SETS = process.env.SLIDE_SETS_FILE || "reels/slide-sets.json";
const slideSets = async (): Promise<SlideSet[]> => JSON.parse(await readFile(SLIDE_SETS, "utf8")).products;

// Copy a Google Drive file (shared "anyone with the link") onto this server and return its public URL;
// any other URL is returned unchanged
async function rehostDrive(url: string): Promise<string> {
  const direct = driveDownloadUrl(url);
  if (!direct) return url;
  const res = await fetch(direct);
  const type = res.headers.get("content-type") || "";
  if (!res.ok || type.startsWith("text/")) throw new Error(`Couldn't download ${url} from Google Drive. Share it as "Anyone with the link" (viewer).`);
  const ext = type.includes("mp4") || type.startsWith("video/") ? ".mp4" : type.includes("png") ? ".png" : type.includes("jpeg") || type.includes("jpg") ? ".jpg" : "";
  if (!ext) throw new Error(`${url} isn't a video or image (got ${type}).`);
  const dir = await mkdtemp(path.join(tmpdir(), "drive-"));
  try {
    const file = path.join(dir, `file${ext}`);
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    return await hostFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Reel builds run in the background, one at a time (a small server has memory for one build), keyed by job ID
type ReelJob = { id: string; status: "queued" | "building" | "done" | "failed"; started: number; variants: number; result?: unknown; error?: string; done: Promise<void> };
const reelJobs = new Map<string, ReelJob>();
const reelJobsByKey = new Map<string, ReelJob>(); // build settings -> latest job with those settings
let reelQueue: Promise<unknown> = Promise.resolve();
function startReelJob(work: () => Promise<unknown>, variants: number, queued = true, prefix = "reel"): ReelJob {
  const job = { id: `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, status: "queued", started: Date.now(), variants } as ReelJob;
  const run = async () => {
    job.status = "building";
    try { job.result = await work(); job.status = "done"; }
    catch (e) { job.status = "failed"; job.error = (e as Error).message; console.error(`${prefix} ${job.id} failed:`, e); }
  };
  // Builds wait their turn (memory); publishing is light and starts right away
  job.done = (queued ? (reelQueue = reelQueue.then(run)) : run()).then(() => {});
  reelJobs.set(job.id, job);
  for (const [id, j] of reelJobs) if (reelJobs.size > 50 && j.status !== "queued" && j.status !== "building") reelJobs.delete(id);
  return job;
}
async function waitForJob(job: ReelJob, ms: number) {
  await Promise.race([job.done, new Promise((r) => setTimeout(r, ms))]);
  if (job.status === "done") return { job_id: job.id, status: "done", ...(job.result as object) };
  if (job.status === "failed") throw new Error(`${job.id.startsWith("post") ? "Publishing" : "Reel build"} failed: ${job.error}`);
  return {
    job_id: job.id, status: job.status, elapsed_s: Math.round((Date.now() - job.started) / 1000),
    next: job.id.startsWith("post")
      ? `Still publishing (Meta is processing the video). In about 30 s, call publish_reel again with the same settings (or get_reel with job_id "${job.id}"). It won't post twice.`
      : `Still ${job.status}. In about 30-60 s, call get_reel with job_id "${job.id}" (or call build_reel again with the same settings) to get the video. About 1-2 min per variant in total.`,
  };
}

// ---------- Tools ----------
function buildServer() {
  const s = new McpServer({ name: "x2-ads-connector", version: "1.0.0" });

  // Tag every tool read-only vs write so Claude (and the directory) know which ones change things
  const WRITES = new Set(["meta_create_campaign", "meta_set_status", "meta_set_daily_budget", "google_set_campaign_status", "google_set_daily_budget", "google_add_negative_keywords", "build_reel", "publish_reel"]);
  const reg = s.registerTool.bind(s) as any;
  (s as any).registerTool = (name: string, cfg: any, cb: any) =>
    reg(name, { ...cfg, annotations: { title: cfg.title, readOnlyHint: !WRITES.has(name), destructiveHint: false, openWorldHint: true } }, cb);

  // ===== META =====
  s.registerTool("meta_list_ad_accounts", {
    title: "Meta: list ad accounts",
    description: "List the Facebook/Instagram ad accounts this token can access (IDs, names, currency, status).",
    inputSchema: {},
  }, wrap(async () => (await meta.listAdAccounts()).data));

  s.registerTool("meta_list_campaigns", {
    title: "Meta: list campaigns",
    description: "List campaigns in a Meta ad account with status and budgets. Budgets are in cents of the account currency.",
    inputSchema: {
      account_id: z.string().describe("Ad account ID, with or without act_ prefix"),
      status: z.array(z.enum(["ACTIVE", "PAUSED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES"])).optional(),
    },
  }, wrap(async ({ account_id, status }: any) => (await meta.listCampaigns(account_id, status)).data));

  s.registerTool("meta_list_adsets", {
    title: "Meta: list ad sets",
    description: "List ad sets (targeting, budget, optimization) for a whole account or one campaign.",
    inputSchema: {
      account_id: z.string().optional().describe("Use this for every ad set in the account"),
      campaign_id: z.string().optional().describe("Or this for one campaign"),
    },
  }, wrap(async ({ account_id, campaign_id }: any) => {
    if (!account_id && !campaign_id) throw new Error("Give account_id or campaign_id.");
    return (await meta.listAdSets(campaign_id || actId(account_id))).data;
  }));

  s.registerTool("meta_list_ads", {
    title: "Meta: list ads",
    description: "List ads with their creative (headline, body text, thumbnail) under a campaign, ad set, or account (act_ID).",
    inputSchema: { parent_id: z.string().describe("Campaign ID, ad set ID, or act_<account id>") },
  }, wrap(async ({ parent_id }: any) => (await meta.listAds(parent_id)).data));

  s.registerTool("meta_performance", {
    title: "Meta: performance report",
    description: "Spend, impressions, reach, clicks, CTR, CPC, CPM, conversions (actions), cost per action and ROAS. Use level to break down by campaign, adset or ad.",
    inputSchema: {
      object_id: z.string().describe("act_<account id>, or a campaign / ad set / ad ID"),
      date_range: DateRange,
      level: z.enum(["account", "campaign", "adset", "ad"]).default("campaign"),
      breakdown: z.enum(["age", "gender", "country", "region", "publisher_platform", "device_platform"]).optional(),
    },
  }, wrap(async ({ object_id, date_range, level, breakdown }: any) => {
    const id = /^\d+$/.test(object_id) && level === "account" ? actId(object_id) : object_id;
    return (await meta.insights(id, date_range, level, breakdown)).data;
  }));

  s.registerTool("meta_create_campaign", {
    title: "Meta: create campaign (PAUSED)",
    description: "Create a new Meta campaign. It is ALWAYS created PAUSED so nothing spends until the user turns it on. IMPORTANT: ads about credit, loans, credit repair, housing, employment, or politics must set special_ad_categories (e.g. [\"FINANCIAL_PRODUCTS_SERVICES\"] for credit repair).",
    inputSchema: {
      account_id: z.string(),
      name: z.string(),
      objective: z.enum(["OUTCOME_SALES", "OUTCOME_LEADS", "OUTCOME_TRAFFIC", "OUTCOME_AWARENESS", "OUTCOME_ENGAGEMENT", "OUTCOME_APP_PROMOTION"]),
      daily_budget_dollars: z.number().optional().describe("Campaign-level budget (CBO). Leave empty to set budgets on ad sets instead."),
      special_ad_categories: z.array(z.enum(["NONE", "FINANCIAL_PRODUCTS_SERVICES", "CREDIT", "EMPLOYMENT", "HOUSING", "ISSUES_ELECTIONS_POLITICS"])).default([]),
    },
  }, wrap(async ({ account_id, name, objective, daily_budget_dollars, special_ad_categories }: any) => {
    guardWrite();
    if (daily_budget_dollars !== undefined) guardBudget(daily_budget_dollars);
    const cats = (special_ad_categories || []).filter((c: string) => c !== "NONE");
    const r = await meta.createCampaign(account_id, {
      name, objective, special_ad_categories: cats,
      daily_budget_cents: daily_budget_dollars ? Math.round(daily_budget_dollars * 100) : undefined,
    });
    return { created: r.id, status: "PAUSED", note: "Created paused. Add ad sets + ads in Ads Manager, then turn it on with meta_set_status." };
  }));

  s.registerTool("meta_set_status", {
    title: "Meta: pause / turn on",
    description: "Pause or activate a Meta campaign, ad set, or ad. Pausing is instant. Activating spends money and requires confirm: true AFTER the user approves.",
    inputSchema: {
      object_id: z.string().describe("Campaign, ad set, or ad ID"),
      status: z.enum(["PAUSED", "ACTIVE"]),
      confirm: z.boolean().optional(),
    },
  }, wrap(async ({ object_id, status, confirm }: any) => {
    guardWrite();
    if (status === "ACTIVE") needConfirm(confirm, `Turning on ${object_id}`);
    await meta.update(object_id, { status });
    return { object_id, status, done: true };
  }));

  s.registerTool("meta_set_daily_budget", {
    title: "Meta: change daily budget",
    description: "Change the daily budget (in dollars) on a Meta campaign (CBO) or ad set. Requires confirm: true after the user approves. Capped by MAX_DAILY_BUDGET.",
    inputSchema: { object_id: z.string(), daily_budget_dollars: z.number(), confirm: z.boolean().optional() },
  }, wrap(async ({ object_id, daily_budget_dollars, confirm }: any) => {
    guardWrite();
    guardBudget(daily_budget_dollars);
    const before = await meta.get(object_id, "name,daily_budget");
    needConfirm(confirm, `Changing "${before.name}" from $${Number(before.daily_budget || 0) / 100}/day to $${daily_budget_dollars}/day`);
    await meta.update(object_id, { daily_budget: Math.round(daily_budget_dollars * 100) });
    return { object_id, name: before.name, old_daily: Number(before.daily_budget || 0) / 100, new_daily: daily_budget_dollars };
  }));

  // ===== META ORGANIC POSTING =====
  s.registerTool("meta_list_pages", {
    title: "Meta: list Pages + Instagram",
    description: "List the Facebook Pages this connector can post to, with each Page's linked Instagram account.",
    inputSchema: {},
  }, wrap(async () => (await meta.listPages()).data));

  s.registerTool("meta_publish_post", {
    title: "Meta: publish photo post (Facebook + Instagram)",
    description: "Publish a photo post to a Facebook Page and/or its linked Instagram account. Facebook can be scheduled ahead (schedule_at, 10 min to 30 days out); Instagram always posts immediately. Instagram captions can't have clickable links, so end them with 'Link in bio'. Use a public image URL (e.g. the Shopify product image).",
    inputSchema: {
      page_id: z.string(),
      image_url: z.string().url(),
      caption: z.string().min(1).max(2200),
      platforms: z.array(z.enum(["facebook", "instagram"])).default(["facebook", "instagram"]),
      instagram_caption: z.string().max(2200).optional().describe("Optional different caption for Instagram"),
      schedule_at: z.string().optional().describe("ISO time to schedule the Facebook post, e.g. 2026-10-28T11:30:00-04:00. Scheduled posts can't get a first comment."),
      first_comment: z.string().max(2200).optional().describe("Auto-posted as the first comment on each published post, e.g. 'Shop here 👉 <product link>'. Links are clickable in Facebook comments, not Instagram."),
    },
  }, wrap(async ({ page_id, image_url, caption, platforms, instagram_caption, schedule_at, first_comment }: any) => {
    guardWrite();
    const page = await meta.pageInfo(page_id);
    const out: Record<string, unknown> = { page: page.name };
    if (platforms.includes("facebook")) {
      let when: number | undefined;
      if (schedule_at) {
        when = Math.floor(new Date(schedule_at).getTime() / 1000);
        if (!Number.isFinite(when)) throw new Error("schedule_at is not a valid date.");
      }
      try {
        const r = await meta.fbPhotoPost(page_id, page.access_token, image_url, caption, when);
        const postId = r.post_id || r.id;
        out.facebook = { post_id: postId, scheduled: !!when };
        if (first_comment && !when) {
          try { await meta.fbComment(postId, page.access_token, first_comment); (out.facebook as any).first_comment = "posted"; }
          catch (e) { (out.facebook as any).first_comment = (e as Error).message; }
        }
      } catch (e) { out.facebook = { error: (e as Error).message }; }
    }
    if (platforms.includes("instagram")) {
      const ig = page.instagram_business_account?.id;
      if (!ig) out.instagram = { error: "No Instagram professional account is linked to this Page." };
      else {
        try {
          const r = await meta.igPhotoPost(ig, page.access_token, image_url, instagram_caption || caption);
          out.instagram = { media_id: r.id, account: page.instagram_business_account?.username };
          if (first_comment) {
            try { await meta.igComment(r.id, first_comment); (out.instagram as any).first_comment = "posted"; }
            catch (e) { (out.instagram as any).first_comment = (e as Error).message; }
          }
        } catch (e) { out.instagram = { error: (e as Error).message }; }
      }
    }
    return out;
  }));

  // ===== REELS =====
  s.registerTool("list_reel_products", {
    title: "Reels: list products with slide sets",
    description: "List the products that have a designed 5-slide reel set in Google Drive: product ID (P01...), town, title, shop URL, price label, and whether publishing is on HOLD. Optionally filter by town.",
    inputSchema: { town: z.string().optional() },
  }, wrap(async ({ town }: any) => {
    const sets = await slideSets();
    return sets
      .filter((p) => !town || p.town.toLowerCase().includes(String(town).toLowerCase()))
      .map(({ slides, ...p }) => ({ ...p, slide_count: slides.length }));
  }));

  s.registerTool("build_reel", {
    title: "Reels: build a reel video",
    description: "Build a 9:16 Reel MP4 (14 s, 1080x1920, H.264/AAC) from a product's designed 5-slide set (product_id like P25) or from your own slide image URLs, with royalty-free music. Starts a background build and returns a job_id (status 'queued'/'building'); call get_reel with it (or call build_reel again with the same settings) until status is 'done', which gives a public video_url (ready for Instagram/Facebook publishing) and a cover image URL. Nothing is posted. Use variants: 2-3 for A/B tests (each gets a different track). About 1-2 minutes per variant.",
    inputSchema: {
      product_id: z.string().optional().describe("Product with a Drive slide set, e.g. P25 (see list_reel_products)"),
      slide_urls: z.array(z.string()).min(1).max(8).optional().describe("Or your own slides: public image URLs or Google Drive links (shared 'anyone with the link'), in order"),
      variants: z.number().int().min(1).max(3).default(1),
      music: z.string().optional().describe("Track file name from the music folder (e.g. baileys.mp3), or 'none' for silent. Default: random track per variant"),
      safe_area: z.boolean().default(false).describe("Shrink slides so Instagram's caption and buttons never cover the slide's CTA"),
      voiceover: z.string().optional().describe("Add a female voiceover with the music dipped under it: a script angle (town-callout, direct-question, moms-gift, new-drop, outfit-solved), 'random' (a different angle per variant), or leave empty for music only. Needs product_id."),
      platform: z.enum(["instagram", "facebook"]).default("instagram").describe("Where it will post; sets the spoken call to action (link in bio vs tap the link)"),
    },
  }, wrap(async ({ product_id, slide_urls, variants, music, safe_area, voiceover, platform }: any) => {
    let product: SlideSet | undefined;
    let slides: string[];
    if (product_id) {
      product = (await slideSets()).find((p) => p.id.toUpperCase() === String(product_id).trim().toUpperCase());
      if (!product) throw new Error(`No slide set for ${product_id}. Use list_reel_products to see the IDs.`);
      slides = product.slides.map((id) => `drive:${id}`);
    } else if (slide_urls?.length) slides = slide_urls;
    else throw new Error("Give product_id or slide_urls.");

    let tracks: (string | undefined)[];
    if (music === "none") tracks = Array(variants).fill(undefined);
    else if (music) {
      const t = (await listTracks()).find((f) => path.basename(f).toLowerCase() === String(music).toLowerCase());
      if (!t) throw new Error(`Track ${music} not found. Available: ${(await listTracks()).map((f) => path.basename(f)).join(", ")}`);
      tracks = Array(variants).fill(t);
    } else tracks = await pickTracks(variants);

    if (voiceover && !product) throw new Error("Voiceover scripts are written from the product's details, so give product_id.");

    // Calling again with the same settings returns that build (still running, or finished in the last 30 min)
    // instead of starting another, so clients that can't see get_reel can still collect the result.
    const key = JSON.stringify([product?.id || slide_urls, variants, music || "", safe_area, voiceover || "", platform]);
    const recent = reelJobsByKey.get(key);
    if (recent && reelJobs.has(recent.id) && (recent.status === "queued" || recent.status === "building" || (recent.status === "done" && Date.now() - recent.started < 30 * 60_000)))
      return await waitForJob(recent, 20_000);

    // Building takes a minute or two on a small server, longer than a tool call should hang, so it runs as a
    // background job. Wait briefly in case it's quick, otherwise hand back the job ID for get_reel.
    const job = startReelJob(async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "reels-"));
      try {
        const out = [];
        for (let i = 0; i < variants; i++) {
          const script = voiceover ? await fillScript(product!, voiceover, platform) : undefined;
          const r = await buildReel({ slides: slides.map((src) => ({ src })), music: tracks[i], safeArea: safe_area, voiceover: script?.text, outPath: path.join(dir, `reel-${i}.mp4`) });
          out.push({
            variant: String.fromCharCode(65 + i),
            video_url: await hostFile(r.path),
            cover_url: await hostFile(r.cover),
            duration_s: r.duration,
            music: tracks[i] ? path.basename(tracks[i]!) : "none",
            ...(script ? { voiceover_angle: script.angle, voiceover_voice: r.voice, voiceover_script: script.text } : {}),
          });
        }
        return {
          product: product && { id: product.id, town: product.town, title: product.title, url: product.url, price_label: product.price_label },
          ...(product?.hold ? { warning: `${product.id} is on HOLD (${product.status}). Don't publish it until Glen releases it.` } : {}),
          reels: out,
          note: "Not posted. Check that the price and offer on the last slide still match checkout before publishing." +
            (voiceover ? " The voice is AI-generated: turn on the platform's AI-content label when publishing." : ""),
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, variants);
    reelJobsByKey.set(key, job);
    return await waitForJob(job, 20_000);
  }));

  s.registerTool("publish_reel", {
    title: "Reels: publish to Instagram + Facebook",
    description:
      "Publish a finished reel (video_url from build_reel) to Instagram Reels and/or Facebook Page Reels, then post the product link as the first comment. " +
      "Posting is public: show the user the caption, platforms and video first, and only call with confirm: true after they approve. dry_run: true uploads and checks everything on Meta's side but posts nothing. " +
      "Copy rules (47 Swag Co): lead with the town, then the offer; Instagram caption ends with 'Link in bio' (links aren't clickable there); Facebook can carry the full shop link; no delivery-date promises. " +
      "The first comment is the bare product URL only (from product_id). Products on HOLD are refused. A daily cap (MAX_DAILY_POSTS, default 2) blocks extra posts. " +
      "Runs in the background: returns a job_id; call publish_reel again with the same settings (or get_reel with the job_id) until status is 'done'. The voiceover is AI-generated: turn on the AI-content label in the app if required.",
    inputSchema: {
      video_url: z.string().url().describe("MP4 from build_reel, or a Google Drive link to an MP4 shared 'anyone with the link' (copied onto this server first)"),
      cover_url: z.string().url().optional().describe("Cover image from build_reel or a shared Google Drive link (Instagram cover)"),
      caption: z.string().min(1).max(2200).describe("Facebook caption (also used for Instagram unless instagram_caption is given)"),
      instagram_caption: z.string().max(2200).optional(),
      product_id: z.string().optional().describe("P01...; used for the first comment (product URL) and the HOLD check"),
      first_comment: z.string().max(2200).optional().describe("Override the first comment; default is the product URL"),
      platforms: z.array(z.enum(["instagram", "facebook"])).default(["instagram", "facebook"]),
      page_id: z.string().optional().describe("Facebook Page ID; default the 47 Swag Co Page"),
      dry_run: z.boolean().default(false),
      confirm: z.boolean().optional(),
    },
  }, wrap(async ({ video_url, cover_url, caption, instagram_caption, product_id, first_comment, platforms, page_id, dry_run, confirm }: any) => {
    guardWrite();
    let product: SlideSet | undefined;
    if (product_id) {
      product = (await slideSets()).find((p) => p.id.toUpperCase() === String(product_id).trim().toUpperCase());
      if (!product) throw new Error(`No product ${product_id}. Use list_reel_products to see the IDs.`);
      if (product.hold && !dry_run) throw new Error(`Refused: ${product.id} is on HOLD (${product.status}). Only Glen can release it.`);
    }
    const comment = first_comment || product?.url;
    const pageId = page_id || process.env.META_PAGE_ID || "1378673685337029";
    const page = await meta.pageInfo(pageId);
    const ig = page.instagram_business_account?.id;
    if (platforms.includes("instagram") && !ig) throw new Error("No Instagram professional account is linked to this Page.");

    if (!dry_run) {
      // Daily cap (counted on Instagram, Eastern time) so the account isn't flagged for posting too much
      const cap = Number(process.env.MAX_DAILY_POSTS || 2);
      if (ig) {
        const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
        const posted = ((await meta.igRecentMedia(ig)).data || []).filter((m: any) => new Date(m.timestamp).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) === today).length;
        if (posted >= cap) throw new Error(`Refused: ${posted} posts already today on Instagram (cap ${cap}, MAX_DAILY_POSTS). Try tomorrow or raise the cap.`);
      }
      if (!confirm) throw new Error(`Not posted yet: this publishes publicly to ${platforms.join(" + ")} on ${page.name}. Show the user the video, caption${comment ? ` and first comment (${comment})` : ""}, get their OK, then call again with confirm: true.`);
    }

    const key = JSON.stringify(["publish", video_url, platforms, dry_run]);
    const recent = reelJobsByKey.get(key);
    if (recent && reelJobs.has(recent.id) && recent.status !== "failed") return await waitForJob(recent, 20_000);

    const job = startReelJob(async () => {
      const out: Record<string, unknown> = { page: page.name, dry_run };
      // Google Drive links are copied onto this server first: Meta needs a direct, public file URL
      const video = await rehostDrive(video_url), cover = cover_url ? await rehostDrive(cover_url) : undefined;
      if (video !== video_url) out.hosted_video_url = video;
      const tasks: Promise<void>[] = [];
      if (platforms.includes("instagram")) tasks.push((async () => {
        try {
          const c = await meta.igReelContainer(ig, video, instagram_caption || caption, cover);
          // Meta downloads and processes the video; usually 30 s to 2 min
          let status = "";
          for (let i = 0; i < 60; i++) {
            status = (await meta.igContainerStatus(c.id)).status_code;
            if (status === "FINISHED" || status === "ERROR" || status === "EXPIRED") break;
            await new Promise((r) => setTimeout(r, 5000));
          }
          if (status !== "FINISHED") throw new Error(`Instagram couldn't process the video (status ${status || "unknown"}).`);
          if (dry_run) { out.instagram = { ready: true, note: "Uploaded and processed by Instagram; not published (dry run)." }; return; }
          const p = await meta.igPublish(ig, c.id);
          const info = await meta.igMedia(p.id).catch(() => ({}));
          const res: Record<string, unknown> = { media_id: p.id, permalink: (info as any).permalink };
          if (comment) {
            try { await meta.igComment(p.id, comment); res.first_comment = "posted"; }
            catch (e) { res.first_comment = `failed: ${(e as Error).message}`; }
          }
          out.instagram = res;
        } catch (e) { out.instagram = { error: (e as Error).message }; }
      })());
      if (platforms.includes("facebook")) tasks.push((async () => {
        try {
          const st = await meta.fbReelStart(pageId, page.access_token);
          await meta.fbReelUpload(st.upload_url, page.access_token, video);
          if (dry_run) { out.facebook = { ready: true, note: "Uploaded to Facebook; not published (dry run). The unfinished upload is discarded." }; return; }
          await meta.fbReelFinish(pageId, page.access_token, st.video_id, caption);
          const res: Record<string, unknown> = { video_id: st.video_id };
          // Comments work once Facebook has finished processing the reel
          for (let i = 0; i < 36; i++) {
            const v = await meta.fbVideoStatus(st.video_id, page.access_token).catch(() => ({} as any));
            res.permalink = v.permalink_url ? `https://www.facebook.com${v.permalink_url}` : res.permalink;
            const vs = v.status?.video_status;
            if (vs === "ready" || vs === "published" || v.status?.publishing_phase?.status === "complete") break;
            if (vs === "error") { res.processing = "error"; break; }
            await new Promise((r) => setTimeout(r, 5000));
          }
          if (comment) {
            try { await meta.fbComment(st.video_id, page.access_token, comment); res.first_comment = "posted"; }
            catch (e) { res.first_comment = `failed: ${(e as Error).message}`; }
          }
          out.facebook = res;
        } catch (e) { out.facebook = { error: (e as Error).message }; }
      })());
      await Promise.all(tasks);
      return out;
    }, 1, false, "post");
    reelJobsByKey.set(key, job);
    return await waitForJob(job, 20_000);
  }));

  s.registerTool("get_reel", {
    title: "Reels: check a reel build",
    description: "Check a reel build started by build_reel. Returns status 'queued', 'building', 'done' (with the video and cover URLs) or 'failed' (with the reason). Builds take about 1-2 minutes per variant; check again every 30-60 s until done.",
    inputSchema: { job_id: z.string() },
  }, wrap(async ({ job_id }: any) => {
    const job = reelJobs.get(String(job_id));
    if (!job) throw new Error(`No reel build ${job_id}. Builds are forgotten after a server restart; start a new one with build_reel.`);
    return await waitForJob(job, 15_000);
  }));

  // ===== GOOGLE =====
  s.registerTool("google_list_accounts", {
    title: "Google Ads: list accounts",
    description: "List Google Ads customer IDs this login can access.",
    inputSchema: {},
  }, wrap(async () => (await google.listAccessible()).resourceNames?.map((r: string) => r.split("/")[1])));

  s.registerTool("google_campaign_performance", {
    title: "Google Ads: campaign performance",
    description: "Every campaign with status, daily budget, spend, clicks, CTR, CPC, conversions, cost per conversion and ROAS.",
    inputSchema: { customer_id: z.string().describe("10-digit customer ID, dashes OK"), date_range: DateRange },
  }, wrap(async ({ customer_id, date_range }: any) => {
    const rows = await google.query(customer_id, `
      SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
             campaign_budget.amount_micros, campaign_budget.resource_name,
             metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc,
             metrics.conversions, metrics.conversions_value
      FROM campaign WHERE campaign.status != 'REMOVED' AND segments.date DURING ${GOOGLE_DATES[date_range]}
      ORDER BY metrics.cost_micros DESC`);
    return rows.map(tidyGoogleCampaign);
  }));

  s.registerTool("google_search_terms", {
    title: "Google Ads: search terms",
    description: "What people actually typed before clicking. Use this to find wasted spend and negative keyword ideas.",
    inputSchema: { customer_id: z.string(), date_range: DateRange, campaign_id: z.string().optional(), limit: z.number().default(100) },
  }, wrap(async ({ customer_id, date_range, campaign_id, limit }: any) => {
    const rows = await google.query(customer_id, `
      SELECT search_term_view.search_term, campaign.name, ad_group.name,
             metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
      FROM search_term_view WHERE segments.date DURING ${GOOGLE_DATES[date_range]}
      ${campaign_id ? `AND campaign.id = ${Number(campaign_id)}` : ""}
      ORDER BY metrics.cost_micros DESC LIMIT ${Math.min(Number(limit) || 100, 1000)}`);
    return rows.map((r: any) => ({
      term: r.searchTermView?.searchTerm, campaign: r.campaign?.name, ad_group: r.adGroup?.name,
      spend: money(r.metrics?.costMicros), clicks: Number(r.metrics?.clicks || 0), conversions: Number(r.metrics?.conversions || 0),
    }));
  }));

  s.registerTool("google_keyword_performance", {
    title: "Google Ads: keyword performance",
    description: "Keyword-level spend, clicks, conversions and quality score.",
    inputSchema: { customer_id: z.string(), date_range: DateRange, limit: z.number().default(100) },
  }, wrap(async ({ customer_id, date_range, limit }: any) => {
    const rows = await google.query(customer_id, `
      SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.quality_info.quality_score,
             campaign.name, metrics.cost_micros, metrics.clicks, metrics.conversions, metrics.average_cpc
      FROM keyword_view WHERE segments.date DURING ${GOOGLE_DATES[date_range]}
      ORDER BY metrics.cost_micros DESC LIMIT ${Math.min(Number(limit) || 100, 1000)}`);
    return rows.map((r: any) => ({
      keyword: r.adGroupCriterion?.keyword?.text, match: r.adGroupCriterion?.keyword?.matchType,
      quality_score: r.adGroupCriterion?.qualityInfo?.qualityScore ?? null, campaign: r.campaign?.name,
      spend: money(r.metrics?.costMicros), clicks: Number(r.metrics?.clicks || 0),
      conversions: Number(r.metrics?.conversions || 0), avg_cpc: money(r.metrics?.averageCpc),
    }));
  }));

  s.registerTool("google_run_query", {
    title: "Google Ads: custom report (GAQL)",
    description: "Run any read-only Google Ads Query Language (GAQL) SELECT for reports the other tools don't cover. Money fields are in micros (divide by 1,000,000).",
    inputSchema: { customer_id: z.string(), gaql: z.string() },
  }, wrap(async ({ customer_id, gaql }: any) => {
    if (!/^\s*select\b/i.test(gaql)) throw new Error("Only SELECT queries are allowed.");
    return (await google.query(customer_id, gaql)).slice(0, 1000);
  }));

  s.registerTool("google_set_campaign_status", {
    title: "Google Ads: pause / enable campaign",
    description: "Pause or enable a Google Ads campaign. Pausing is instant. Enabling spends money and requires confirm: true AFTER the user approves.",
    inputSchema: { customer_id: z.string(), campaign_id: z.string(), status: z.enum(["PAUSED", "ENABLED"]), confirm: z.boolean().optional() },
  }, wrap(async ({ customer_id, campaign_id, status, confirm }: any) => {
    guardWrite();
    if (status === "ENABLED") needConfirm(confirm, `Enabling campaign ${campaign_id}`);
    await google.mutateCampaign(customer_id, campaign_id, { status });
    return { campaign_id, status, done: true };
  }));

  s.registerTool("google_set_daily_budget", {
    title: "Google Ads: change daily budget",
    description: "Change a Google Ads campaign's daily budget in dollars. Requires confirm: true after the user approves. Capped by MAX_DAILY_BUDGET. Note: shared budgets affect every campaign using them.",
    inputSchema: { customer_id: z.string(), campaign_id: z.string(), daily_budget_dollars: z.number(), confirm: z.boolean().optional() },
  }, wrap(async ({ customer_id, campaign_id, daily_budget_dollars, confirm }: any) => {
    guardWrite();
    guardBudget(daily_budget_dollars);
    const [row] = await google.query(customer_id, `
      SELECT campaign.name, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared
      FROM campaign WHERE campaign.id = ${Number(campaign_id)}`);
    if (!row) throw new Error(`Campaign ${campaign_id} not found in ${cid(customer_id)}.`);
    const old = money(row.campaignBudget?.amountMicros);
    needConfirm(confirm, `Changing "${row.campaign?.name}" from $${old}/day to $${daily_budget_dollars}/day${row.campaignBudget?.explicitlyShared ? " (SHARED budget — affects other campaigns too)" : ""}`);
    await google.mutateBudget(customer_id, row.campaignBudget.resourceName, Math.round(daily_budget_dollars * 1_000_000));
    return { campaign: row.campaign?.name, old_daily: old, new_daily: daily_budget_dollars };
  }));

  s.registerTool("google_add_negative_keywords", {
    title: "Google Ads: add negative keywords",
    description: "Block search terms from triggering a campaign (saves money, never increases spend).",
    inputSchema: {
      customer_id: z.string(), campaign_id: z.string(),
      keywords: z.array(z.string()).min(1).max(200),
      match_type: z.enum(["EXACT", "PHRASE", "BROAD"]).default("PHRASE"),
    },
  }, wrap(async ({ customer_id, campaign_id, keywords, match_type }: any) => {
    guardWrite();
    await google.addNegativeKeywords(customer_id, campaign_id, keywords, match_type);
    return { campaign_id, added: keywords.length, match_type };
  }));

  // ===== CROSS-PLATFORM =====
  s.registerTool("all_platforms_summary", {
    title: "All platforms: spend summary",
    description: "One-shot spend and results across Meta + Google for a date range. Skips any platform that isn't configured.",
    inputSchema: {
      meta_account_id: z.string().optional(),
      google_customer_id: z.string().optional(),
      date_range: DateRange,
    },
  }, wrap(async ({ meta_account_id, google_customer_id, date_range }: any) => {
    const out: Record<string, unknown> = { date_range };
    if (meta_account_id) {
      try {
        const [row] = (await meta.insights(actId(meta_account_id), date_range, "account")).data || [];
        out.meta = row ? { spend: Number(row.spend), impressions: Number(row.impressions), clicks: Number(row.clicks), ctr: Number(row.ctr), actions: row.actions } : { spend: 0 };
      } catch (e) { out.meta = { error: (e as Error).message }; }
    }
    if (google_customer_id) {
      try {
        const [r] = await google.query(google_customer_id, `
          SELECT metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value
          FROM customer WHERE segments.date DURING ${GOOGLE_DATES[date_range]}`);
        const m = r?.metrics || {};
        out.google = { spend: money(m.costMicros), impressions: Number(m.impressions || 0), clicks: Number(m.clicks || 0), conversions: Number(m.conversions || 0), conv_value: Number(m.conversionsValue || 0) };
      } catch (e) { out.google = { error: (e as Error).message }; }
    }
    return out;
  }));

  return s;
}

// ---------- HTTP server ----------
const SECRET = process.env.CONNECTOR_SECRET || "";
if (SECRET.length < 24) {
  console.error("CONNECTOR_SECRET must be set to a long random string (24+ chars). Refusing to start.");
  process.exit(1);
}
const secretOk = (s: string) => {
  const a = Buffer.from(s || ""), b = Buffer.from(SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
};

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => res.send("x2 ads connector is running."));
mediaRoutes(app);

app.post("/mcp/:secret", async (req, res) => {
  if (!secretOk(req.params.secret)) return res.status(404).end();
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});
app.all("/mcp/:secret", (_req, res) => res.status(405).set("Allow", "POST").end());

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`x2 ads connector listening on :${PORT} (read-only: ${READ_ONLY}, budget cap: $${MAX_DAILY_BUDGET}/day)`));

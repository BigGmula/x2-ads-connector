// Meta (Facebook/Instagram) Marketing API client
const V = process.env.META_API_VERSION || "v23.0";
const BASE = `https://graph.facebook.com/${V}`;

function token(): string {
  const t = process.env.META_ACCESS_TOKEN;
  if (!t) throw new Error("META_ACCESS_TOKEN is not set. See SETUP.md step 2.");
  return t;
}

export function actId(id: string): string {
  const clean = String(id).replace(/^act_/, "").trim();
  return `act_${clean}`;
}

async function call(method: "GET" | "POST", path: string, params: Record<string, unknown> = {}) {
  const url = new URL(`${BASE}/${path.replace(/^\//, "")}`);
  const body = new URLSearchParams();
  const target = method === "GET" ? url.searchParams : body;
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    target.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  target.set("access_token", token());
  const res = await fetch(url, method === "POST" ? { method, body } : { method });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new Error(`Meta API error ${res.status}: ${e.message || res.statusText}${e.error_user_msg ? " — " + e.error_user_msg : ""}`);
  }
  return json;
}

export const meta = {
  listAdAccounts: () =>
    call("GET", "me/adaccounts", { fields: "id,name,account_status,currency,amount_spent,timezone_name", limit: 100 }),

  listCampaigns: (accountId: string, status?: string[]) =>
    call("GET", `${actId(accountId)}/campaigns`, {
      fields: "id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time,special_ad_categories",
      effective_status: status && status.length ? status : undefined,
      limit: 200,
    }),

  // parentPath is either "act_123" (whole account) or a campaign id
  listAdSets: (parentPath: string) =>
    call("GET", `${parentPath}/adsets`, {
      fields: "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event,targeting",
      limit: 200,
    }),

  listAds: (parentId: string) =>
    call("GET", `${parentId}/ads`, {
      fields: "id,name,adset_id,campaign_id,status,effective_status,creative{id,name,title,body,thumbnail_url}",
      limit: 200,
    }),

  insights: (objectId: string, datePreset: string, level: string, breakdowns?: string) =>
    call("GET", `${objectId}/insights`, {
      date_preset: datePreset,
      level,
      breakdowns,
      fields:
        "campaign_name,adset_name,ad_name,spend,impressions,reach,clicks,ctr,cpc,cpm,frequency,actions,cost_per_action_type,purchase_roas",
      limit: 500,
    }),

  createCampaign: (accountId: string, p: { name: string; objective: string; daily_budget_cents?: number; special_ad_categories: string[] }) =>
    call("POST", `${actId(accountId)}/campaigns`, {
      name: p.name,
      objective: p.objective,
      status: "PAUSED", // always created paused — you flip it on yourself
      special_ad_categories: p.special_ad_categories,
      daily_budget: p.daily_budget_cents,
      bid_strategy: p.daily_budget_cents ? "LOWEST_COST_WITHOUT_CAP" : undefined,
    }),

  update: (objectId: string, fields: Record<string, unknown>) => call("POST", objectId, fields),

  get: (objectId: string, fields: string) => call("GET", objectId, { fields }),

  // ----- Organic posting (Facebook Page + Instagram) -----
  listPages: () => call("GET", "me/accounts", { fields: "id,name,instagram_business_account{id,username}", limit: 100 }),

  pageInfo: (pageId: string) => call("GET", pageId, { fields: "name,access_token,instagram_business_account{id,username}" }),

  // Facebook photo post on a Page (optionally scheduled 10 min – 30 days ahead)
  fbPhotoPost: async (pageId: string, pageToken: string, imageUrl: string, caption: string, scheduleUnix?: number) => {
    const body = new URLSearchParams({ url: imageUrl, caption, access_token: pageToken });
    if (scheduleUnix) { body.set("published", "false"); body.set("scheduled_publish_time", String(scheduleUnix)); }
    const res = await fetch(`${BASE}/${pageId}/photos`, { method: "POST", body });
    const j: any = await res.json();
    if (!res.ok || j.error) throw new Error(`Facebook post failed: ${j.error?.message || res.statusText}`);
    return j; // { id, post_id }
  },

  // Comment on a published FB post (page token) or IG media (system token)
  fbComment: async (postId: string, pageToken: string, message: string) => {
    const res = await fetch(`${BASE}/${postId}/comments`, { method: "POST", body: new URLSearchParams({ message, access_token: pageToken }) });
    const j: any = await res.json();
    if (!res.ok || j.error) throw new Error(`Facebook comment failed: ${j.error?.message || res.statusText}`);
    return j;
  },
  igComment: (mediaId: string, message: string) => call("POST", `${mediaId}/comments`, { message }),

  // Instagram feed post: create container, wait until ready, publish
  igPhotoPost: async (igId: string, token: string, imageUrl: string, caption: string) => {
    const c = await call("POST", `${igId}/media`, { image_url: imageUrl, caption, access_token: token });
    for (let i = 0; i < 10; i++) {
      const s = await call("GET", c.id, { fields: "status_code" });
      if (s.status_code === "FINISHED") break;
      if (s.status_code === "ERROR") throw new Error("Instagram could not process the image.");
      await new Promise((r) => setTimeout(r, 2000));
    }
    return call("POST", `${igId}/media_publish`, { creation_id: c.id });
  },

  // ----- Reels -----
  // Instagram: create a REELS container from a public video URL; Meta downloads and processes it
  igReelContainer: (igId: string, videoUrl: string, caption: string, coverUrl?: string) =>
    call("POST", `${igId}/media`, { media_type: "REELS", video_url: videoUrl, caption, share_to_feed: true, cover_url: coverUrl }),
  igContainerStatus: (containerId: string) => call("GET", containerId, { fields: "status_code,status" }),
  igPublish: (igId: string, containerId: string) => call("POST", `${igId}/media_publish`, { creation_id: containerId }),
  igMedia: (mediaId: string) => call("GET", mediaId, { fields: "permalink,timestamp" }),
  igRecentMedia: (igId: string) => call("GET", `${igId}/media`, { fields: "timestamp,media_product_type", limit: 25 }),

  // Facebook Page Reels (page token): start an upload session, have Meta fetch the hosted file, then finish
  fbReelStart: (pageId: string, pageToken: string) => pageCall("POST", `${pageId}/video_reels`, pageToken, { upload_phase: "start" }),
  fbReelUpload: async (uploadUrl: string, pageToken: string, fileUrl: string) => {
    const res = await fetch(uploadUrl, { method: "POST", headers: { Authorization: `OAuth ${pageToken}`, file_url: fileUrl } });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || j.error || j.success === false) throw new Error(`Facebook Reel upload failed: ${j.error?.message || j.debug_info?.message || res.statusText}`);
    return j;
  },
  fbReelFinish: (pageId: string, pageToken: string, videoId: string, description: string, scheduleUnix?: number) =>
    pageCall("POST", `${pageId}/video_reels`, pageToken, {
      upload_phase: "finish", video_id: videoId, description,
      video_state: scheduleUnix ? "SCHEDULED" : "PUBLISHED", scheduled_publish_time: scheduleUnix,
    }),
  fbVideoStatus: (videoId: string, pageToken: string) => pageCall("GET", videoId, pageToken, { fields: "status,permalink_url" }),
};

// Graph call with a Page access token (Page posting needs the Page's own token, not the system user's)
async function pageCall(method: "GET" | "POST", path: string, pageToken: string, params: Record<string, unknown> = {}) {
  const url = new URL(`${BASE}/${path.replace(/^\//, "")}`);
  const body = new URLSearchParams();
  const target = method === "GET" ? url.searchParams : body;
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) target.set(k, String(v));
  target.set("access_token", pageToken);
  const res = await fetch(url, method === "POST" ? { method, body } : { method });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`Meta API error ${res.status}: ${j.error?.message || res.statusText}${j.error?.error_user_msg ? " — " + j.error.error_user_msg : ""}`);
  return j;
}

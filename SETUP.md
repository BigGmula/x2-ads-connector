# x2 Ads Connector — Setup Guide

Your own Claude connector for **Meta (Facebook/Instagram) Ads** and **Google Ads**. No monthly SaaS fee — you only pay for hosting (~$5/mo) and your actual ad spend.

## What Claude can do with it

| Read (safe, anytime) | Write (with safety rails) |
|---|---|
| List ad accounts (Meta + Google) | Create Meta and Google Search campaigns (always created **PAUSED**) |
| Campaign / ad set / ad lists with creatives | Pause or turn on campaigns, ad sets, ads |
| Performance: spend, CTR, CPC, CPM, conversions, ROAS | Change daily budgets |
| Breakdowns by age, gender, region, device, platform | Add negative keywords (Google) |
| Google search terms (find wasted spend) | Google ad groups, keywords, responsive search ads (UTM-tagged), locations |
| Google keyword performance + quality scores | |
| Custom Google reports (GAQL) | |
| One-shot Meta + Google spend summary | |

**Safety rails built in**
- Anything that *spends* money (turning on, budget changes) is refused until you approve it in chat.
- `MAX_DAILY_BUDGET` hard cap (default $30/day) — the server refuses any budget above it, no matter what.
- `ADS_READ_ONLY=true` turns off all changes entirely.
- New campaigns are always created paused. Every Google create tool has `dry_run` (Google checks it, nothing is created) and needs `confirm: true` to really create. Each create call is logged as a `[google-create]` line in the server logs.
- The connector URL contains a long secret; wrong URL = 404.

---

## Step 1 — Put it online (Railway, ~10 min)

1. Create a free GitHub account if you don't have one, make a **private** repo, and upload this folder (everything except `node_modules` and `dist`).
2. Go to **railway.app** → New Project → Deploy from GitHub → pick the repo.
3. Railway auto-detects Node. Set **Build command** `npm install && npm run build` and **Start command** `npm start`.
4. Under **Variables**, add everything from `.env.example` (filled in from steps 2–3 below).
5. Under **Settings → Networking**, click **Generate Domain**. You'll get something like `x2-ads.up.railway.app`.

Make your secret: on a Mac, open Terminal and run `openssl rand -hex 32`. Paste the result as `CONNECTOR_SECRET`.

(Render.com works too, but its free tier sleeps and Claude's first request may time out.)

## Step 2 — Meta Ads token (~15 min)

1. **developers.facebook.com** → My Apps → Create App → type **Business** → connect it to your Business Manager.
2. Add the **Marketing API** product to the app.
3. Go to **business.facebook.com → Business Settings → Users → System Users** → Add → role **Admin**.
4. Click the system user → **Assign Assets** → pick your ad accounts → give **Manage campaigns**.
5. Click **Generate New Token** → choose your app → check `ads_read` and `ads_management` → set expiry **Never**.
6. Paste it as `META_ACCESS_TOKEN`.

Your own ad accounts work right away — no App Review needed.

## Step 3 — Google Ads (~20 min)

1. **Google Cloud project + API access**: console.cloud.google.com → new project → enable **Google Ads API** → go to **Google Ads API → Overview** (console.cloud.google.com/google/ads-apis/overview) → **Apply for access** to move from *Test* to **Explorer** (2,880 operations/day on real accounts, usually approved in minutes). Developer tokens were retired on 2026-09-09; access now belongs to the Cloud project, so `GOOGLE_ADS_DEVELOPER_TOKEN` can stay empty. Billing on the project must be active (not free trial).
2. **OAuth client**: **Google Auth Platform** → Get started (app name, your email, audience *External*) → **Audience → Publish app** (in *Testing* mode refresh tokens expire after 7 days) → **Clients → Create client**, type **Web application**, authorized redirect URI `https://developers.google.com/oauthplayground`. → `GOOGLE_ADS_CLIENT_ID` and `GOOGLE_ADS_CLIENT_SECRET`
3. **Refresh token**: go to developers.google.com/oauthplayground → gear icon → check *Use your own OAuth credentials* → paste the client ID/secret → in scope box type `https://www.googleapis.com/auth/adwords` → Authorize → sign in with the Google account that owns the ads (click through the "Google hasn't verified this app" warning: Advanced → Go to app) → **Exchange authorization code for tokens** → copy the refresh token. → `GOOGLE_ADS_REFRESH_TOKEN`
4. Put your Manager account ID (no dashes) in `GOOGLE_ADS_LOGIN_CUSTOMER_ID`.

Skip this step if you only want Meta for now — the Meta tools work on their own.

## Step 4 — Plug it into Claude

Add it as a **custom connector** in Claude's connector settings (needs a paid Claude plan):

- Name: `x2 Ads`
- URL: `https://YOUR-RAILWAY-DOMAIN/mcp/YOUR_CONNECTOR_SECRET`
- No OAuth fields needed.

Then try: *"Using x2 Ads, show me my Meta spend and results for the last 7 days by campaign."*

## Test it locally first (optional)

```bash
npm install
cp .env.example .env   # fill in values
npm run build && node --env-file=.env dist/index.js
```

## Step 5 — Voiceovers (optional, ~10 min)

Reels can have a woman's voice reading a short script (from `reels/voiceover-scripts.json`) with the music dipped underneath. Voices come from ElevenLabs. Three creator-style female voices rotate (Hayley, Elena, Liz) so the performance report shows which one sells.

1. ElevenLabs needs a **paid plan (Starter or higher)** for commercial use of the audio in ads and business posts.
2. In ElevenLabs, open **Voices → Voice Library** and add **Hayley - Natural TikTok & UGC**, **Elena - Young, upbeat social creator** and **Liz – Social Media & Ad - Youtube - TikTok** to **My Voices** (the API can only use voices you've added).
3. **Developers → API Keys → Create API key** (Text to Speech access is enough). Copy it.
4. Put it in `ELEVENLABS_API_KEY` (in Render's environment variables, and in a local `.env` file to build reels on your computer).

Try it locally: `npm run reel -- P25 --vo each` builds one version per script angle into `reels/out`.
The voice is AI-generated, so turn on the platform's AI-content label when posting.

## Step 6 — Posting schedule (~5 min)

The connector posts on its own from a Google Sheet, one row per reel or photo post. It checks the sheet every minute.

1. Open the **47 Swag Co — Posting Schedule** sheet in Drive. **Share → General access → Anyone with the link → Viewer.** (The server reads it without signing in; the link is long and unguessable. Don't post it publicly.)
2. In Render, add the environment variable `SCHEDULE_SHEET_URL` = the sheet's link. Render restarts with the scheduler on.
3. Fill in rows. Times are **Eastern**. A row posts only when its **status** column says `approved`; anything else (`draft`, empty) is left alone.

| Column | What to put |
|---|---|
| date, time | `2026-11-02` or `11/2/2026`, and `11:30 AM` or `7pm` |
| type | `reel` or `post` |
| product_id | `P25` etc. (from the slide sets): gives the slides, the first-comment link and the HOLD check |
| platforms | `instagram, facebook` (default both), or just one |
| caption, instagram_caption | Facebook caption; Instagram uses `instagram_caption` if filled, else `caption` |
| first_comment | Override the first comment (default: the product link) |
| media | Reel: slide image links (Drive, in order) to build from. Post: the image link |
| video, cover | A finished reel MP4 (and cover image) to post as is, with no build |
| voiceover | A script angle (`town-callout`, `direct-question`, `moms-gift`, `new-drop`, `outfit-solved`, `random`) |
| music | A track from `music/` (e.g. `baileys.mp3`), `none`, or empty for a random one |
| status | `approved` to post |

- Reels that need building start 25 minutes before their time. A row that's more than 30 minutes late (server down) is skipped, not posted late.
- Products on HOLD, unreadable dates and missing captions are refused and shown as problems.
- Ask Claude "what's on the schedule?" (the `schedule_status` tool) to see what's waiting, posted (with links) or failed and why.
- To pause everything, set `SCHEDULER_ENABLED=false` in Render.

## Step 7 — 47 Studio, the dashboard app (~2 min)

Open **https://x2-ads-connector.onrender.com/app** to see the schedule, approve or skip posts, see what's posted and browse products.

1. In Render, add `DASHBOARD_PASSWORD` (any password you'll remember). Without it, the password is `CONNECTOR_SECRET`.
2. **Install it as an app:** on a PC, open the link in Chrome or Edge and click the install icon in the address bar (or menu → *Install 47 Studio*). On an iPhone, Safari → Share → *Add to Home Screen*; on Android, Chrome menu → *Install app*.
3. **Approve / Skip** in the app wins over the sheet's status column. Those choices are kept on the server's disk, which Render wipes on each deploy, so add a Render **Disk** (1 GB, mount path `/var/data`) and set `SCHEDULE_STATE_FILE=/var/data/schedule-state.json` to keep them. Without a disk, a deploy resets app approvals (rows then go back to what the sheet says; nothing extra gets posted).

## Notes

- **Credit repair ads on Meta**: set `special_ad_categories` to `FINANCIAL_PRODUCTS_SERVICES`. Meta rejects credit-related ads without it, and it limits age/zip targeting.
- **API versions** are set by `META_API_VERSION` and `GOOGLE_ADS_API_VERSION`. Both platforms retire old versions about once a year — if you start seeing "version deprecated" errors, bump the number in Railway variables.
- **Never share the connector URL** — it's effectively the password to your ad accounts. If it leaks, change `CONNECTOR_SECRET` in Railway and update the URL in Claude.

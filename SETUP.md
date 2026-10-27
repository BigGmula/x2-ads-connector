# x2 Ads Connector — Setup Guide

Your own Claude connector for **Meta (Facebook/Instagram) Ads** and **Google Ads**. No monthly SaaS fee — you only pay for hosting (~$5/mo) and your actual ad spend.

## What Claude can do with it

| Read (safe, anytime) | Write (with safety rails) |
|---|---|
| List ad accounts (Meta + Google) | Create Meta campaigns (always created **PAUSED**) |
| Campaign / ad set / ad lists with creatives | Pause or turn on campaigns, ad sets, ads |
| Performance: spend, CTR, CPC, CPM, conversions, ROAS | Change daily budgets |
| Breakdowns by age, gender, region, device, platform | Add negative keywords (Google) |
| Google search terms (find wasted spend) | |
| Google keyword performance + quality scores | |
| Custom Google reports (GAQL) | |
| One-shot Meta + Google spend summary | |

**Safety rails built in**
- Anything that *spends* money (turning on, budget changes) is refused until you approve it in chat.
- `MAX_DAILY_BUDGET` hard cap — the server refuses any budget above it, no matter what.
- `ADS_READ_ONLY=true` turns off all changes entirely.
- New campaigns are always created paused.
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

## Step 3 — Google Ads (~20 min + approval wait)

1. **Developer token**: you need a Google Ads **Manager account** (free, ads.google.com/home/tools/manager-accounts). In it: Tools → **API Center** → apply. You start with *test access*; apply for **Basic access** (usually a few business days) to touch real accounts. → `GOOGLE_ADS_DEVELOPER_TOKEN`
2. **Google Cloud**: console.cloud.google.com → new project → enable **Google Ads API** → APIs & Services → Credentials → Create **OAuth client ID** (type *Desktop app*). → `GOOGLE_ADS_CLIENT_ID` and `GOOGLE_ADS_CLIENT_SECRET`
3. **Refresh token**: go to developers.google.com/oauthplayground → gear icon → check *Use your own OAuth credentials* → paste the client ID/secret → in scope box type `https://www.googleapis.com/auth/adwords` → Authorize → sign in with the Google account that owns the ads → **Exchange authorization code for tokens** → copy the refresh token. → `GOOGLE_ADS_REFRESH_TOKEN`
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

## Notes

- **Credit repair ads on Meta**: set `special_ad_categories` to `FINANCIAL_PRODUCTS_SERVICES`. Meta rejects credit-related ads without it, and it limits age/zip targeting.
- **API versions** are set by `META_API_VERSION` and `GOOGLE_ADS_API_VERSION`. Both platforms retire old versions about once a year — if you start seeing "version deprecated" errors, bump the number in Railway variables.
- **Never share the connector URL** — it's effectively the password to your ad accounts. If it leaks, change `CONNECTOR_SECRET` in Railway and update the URL in Claude.

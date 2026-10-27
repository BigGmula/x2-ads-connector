// Google Ads API (REST) client
const V = process.env.GOOGLE_ADS_API_VERSION || "v21";
const BASE = `https://googleads.googleapis.com/${V}`;

let cached: { token: string; exp: number } | null = null;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. See SETUP.md step 3.`);
  return v;
}

export const cid = (id: string) => String(id).replace(/-/g, "").trim();

async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.exp - 60_000) return cached.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: need("GOOGLE_ADS_CLIENT_ID"),
      client_secret: need("GOOGLE_ADS_CLIENT_SECRET"),
      refresh_token: need("GOOGLE_ADS_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  const j: any = await res.json();
  if (!res.ok) throw new Error(`Google OAuth error: ${j.error_description || j.error || res.statusText}`);
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

async function call(path: string, body: unknown) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await accessToken()}`,
    "developer-token": need("GOOGLE_ADS_DEVELOPER_TOKEN"),
    "Content-Type": "application/json",
  };
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) headers["login-customer-id"] = cid(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
  const res = await fetch(`${BASE}/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const details = j?.error?.details?.[0]?.errors?.map((e: any) => e.message).join("; ");
    throw new Error(`Google Ads API error ${res.status}: ${details || j?.error?.message || res.statusText}`);
  }
  return j;
}

async function listAccessible() {
  const res = await fetch(`${BASE}/customers:listAccessibleCustomers`, {
    headers: { Authorization: `Bearer ${await accessToken()}`, "developer-token": need("GOOGLE_ADS_DEVELOPER_TOKEN") },
  });
  const j: any = await res.json();
  if (!res.ok) throw new Error(`Google Ads API error ${res.status}: ${j?.error?.message || res.statusText}`);
  return j;
}

export const google = {
  listAccessible,

  // Run any GAQL query (read-only)
  query: async (customerId: string, gaql: string) => {
    const rows: any[] = [];
    let pageToken: string | undefined;
    do {
      const j = await call(`customers/${cid(customerId)}/googleAds:search`, { query: gaql, pageToken });
      rows.push(...(j.results || []));
      pageToken = j.nextPageToken;
    } while (pageToken && rows.length < 5000);
    return rows;
  },

  mutateCampaign: (customerId: string, campaignId: string, fields: Record<string, unknown>) =>
    call(`customers/${cid(customerId)}/campaigns:mutate`, {
      operations: [
        {
          update: { resourceName: `customers/${cid(customerId)}/campaigns/${campaignId}`, ...fields },
          updateMask: Object.keys(fields).join(","),
        },
      ],
    }),

  mutateBudget: (customerId: string, budgetResource: string, amountMicros: number) =>
    call(`customers/${cid(customerId)}/campaignBudgets:mutate`, {
      operations: [{ update: { resourceName: budgetResource, amountMicros: String(amountMicros) }, updateMask: "amount_micros" }],
    }),

  addNegativeKeywords: (customerId: string, campaignId: string, keywords: string[], matchType: string) =>
    call(`customers/${cid(customerId)}/campaignCriteria:mutate`, {
      operations: keywords.map((text) => ({
        create: {
          campaign: `customers/${cid(customerId)}/campaigns/${campaignId}`,
          negative: true,
          keyword: { text, matchType },
        },
      })),
    }),
};

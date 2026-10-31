// Google Ads campaign building: turns tool inputs into googleAds:mutate operations.
// Kept free of network calls (except the injected geo lookup) so it can be unit tested.

export const LIMITS = { headline: 30, description: 90, path: 15, keyword: 80, headlinesMin: 3, headlinesMax: 15, descriptionsMin: 2, descriptionsMax: 4 };
export type MatchType = "EXACT" | "PHRASE" | "BROAD";

const cid = (id: string) => String(id).replace(/-/g, "").trim();
export const micros = (dollars: number) => String(Math.round(dollars * 1_000_000));
export const idOf = (resourceName: string) => String(resourceName).split("/").pop()!;
export const res = {
  budget: (c: string, id: string | number) => `customers/${cid(c)}/campaignBudgets/${id}`,
  campaign: (c: string, id: string | number) => `customers/${cid(c)}/campaigns/${id}`,
  adGroup: (c: string, id: string | number) => `customers/${cid(c)}/adGroups/${id}`,
};

// "Team & Business Merch" -> "team-business-merch"
export const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Adds utm_source=google, utm_medium=cpc, utm_campaign=<slug>; keeps any UTM values already on the URL
export function withUtm(url: string, campaign: string): string {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`final_url must be a web address: ${url}`);
  const set = (k: string, v: string) => { if (!u.searchParams.has(k)) u.searchParams.set(k, v); };
  set("utm_source", "google");
  set("utm_medium", "cpc");
  set("utm_campaign", slug(campaign));
  return u.toString();
}

// ---------- Locations ----------
const STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};

export type Radius = { town: string; state?: string; radius_miles: number; lat?: number; lng?: number };
export type Place = string | Radius;
export type Region = { name: string; state: string; canonical: string };

// "Nassau County, NY" -> { name: "Nassau County", state: "NY", canonical: "Nassau County,New York,United States" }
export function parseRegion(place: string): Region {
  const [rawName, rawState = "NY"] = place.split(",").map((s) => s.trim());
  if (!rawName) throw new Error(`Empty location: "${place}"`);
  const state = rawState.toUpperCase();
  const stateName = STATES[state] || Object.values(STATES).find((n) => n.toLowerCase() === rawState.toLowerCase());
  if (!stateName) throw new Error(`Unknown US state "${rawState}" in "${place}". Use e.g. "Nassau County, NY".`);
  return { name: rawName, state, canonical: `${rawName},${stateName},United States` };
}

export function splitPlaces(places: Place[]) {
  const regions: Region[] = [], radii: Radius[] = [];
  for (const p of places) {
    if (typeof p === "string") regions.push(parseRegion(p));
    else {
      if (!(p.radius_miles > 0 && p.radius_miles <= 500)) throw new Error(`Radius for ${p.town} must be between 0 and 500 miles.`);
      radii.push(p);
    }
  }
  return { regions, radii };
}

// GAQL that finds the geo target constants for regions (counties, cities, states, ZIPs) by canonical name
export function geoQuery(regions: Region[]): string {
  const names = regions.map((r) => `'${r.canonical.replace(/'/g, "\\'")}'`).join(", ");
  return `SELECT geo_target_constant.resource_name, geo_target_constant.canonical_name, geo_target_constant.target_type, geo_target_constant.status
    FROM geo_target_constant WHERE geo_target_constant.canonical_name IN (${names}) AND geo_target_constant.status = 'ENABLED'`;
}

export type GeoLookup = (gaql: string) => Promise<any[]>;
export type ResolvedRegion = Region & { geoTargetConstant: string; type?: string };

export async function resolveRegions(regions: Region[], lookup: GeoLookup): Promise<ResolvedRegion[]> {
  if (!regions.length) return [];
  const rows = await lookup(geoQuery(regions));
  return regions.map((r) => {
    const hit = rows.find((x) => x.geoTargetConstant?.canonicalName?.toLowerCase() === r.canonical.toLowerCase());
    if (!hit) throw new Error(`Google Ads has no location named "${r.canonical}". Check the spelling (e.g. "Suffolk County, NY", "Lindenhurst, NY", "11757, NY").`);
    return { ...r, geoTargetConstant: hit.geoTargetConstant.resourceName, type: hit.geoTargetConstant.targetType };
  });
}

export function locationOps(campaignRn: string, regions: ResolvedRegion[], radii: Radius[]) {
  const ops = regions.map((r) => ({ campaignCriterionOperation: { create: { campaign: campaignRn, location: { geoTargetConstant: r.geoTargetConstant } } } }));
  for (const r of radii) {
    const proximity: Record<string, unknown> = { radius: r.radius_miles, radiusUnits: "MILES" };
    if (r.lat !== undefined && r.lng !== undefined)
      proximity.geoPoint = { latitudeInMicroDegrees: Math.round(r.lat * 1e6), longitudeInMicroDegrees: Math.round(r.lng * 1e6) };
    else proximity.address = { cityName: r.town, provinceCode: (r.state || "NY").toUpperCase(), countryCode: "US" };
    ops.push({ campaignCriterionOperation: { create: { campaign: campaignRn, proximity } } } as any);
  }
  return ops;
}

// ---------- Campaign + budget ----------
export type CampaignInput = { name: string; daily_budget: number; max_cpc?: number; start_paused?: boolean };

export function campaignOps(customerId: string, c: CampaignInput, ids = { budget: -1, campaign: -2 }) {
  const budgetRn = res.budget(customerId, ids.budget), campaignRn = res.campaign(customerId, ids.campaign);
  return {
    budgetRn, campaignRn,
    ops: [
      {
        campaignBudgetOperation: {
          create: {
            resourceName: budgetRn,
            // Budget names must be unique in the account
            name: `${c.name} budget ${new Date().toISOString().slice(0, 19).replace("T", " ")}`,
            amountMicros: micros(c.daily_budget),
            deliveryMethod: "STANDARD",
            explicitlyShared: false,
          },
        },
      },
      {
        campaignOperation: {
          create: {
            resourceName: campaignRn,
            name: c.name,
            // Always PAUSED: turn it on with google_set_campaign_status after the user approves
            status: "PAUSED",
            advertisingChannelType: "SEARCH",
            campaignBudget: budgetRn,
            // Maximize Clicks, optionally with a max CPC ceiling
            targetSpend: c.max_cpc ? { cpcBidCeilingMicros: micros(c.max_cpc) } : {},
            networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
            // Only people physically in (or regularly in) the target area, not people "interested in" it
            geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE", negativeGeoTargetType: "PRESENCE" },
            containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
          },
        },
      },
    ],
  };
}

// ---------- Ad groups, keywords, ads ----------
export function adGroupOp(campaignRn: string, name: string, maxCpc: number, resourceName?: string) {
  if (!(maxCpc > 0)) throw new Error("max_cpc must be greater than 0.");
  return {
    adGroupOperation: {
      create: { ...(resourceName ? { resourceName } : {}), name, campaign: campaignRn, status: "ENABLED", type: "SEARCH_STANDARD", cpcBidMicros: micros(maxCpc) },
    },
  };
}

export function cleanKeywords(keywords: string[]): string[] {
  const placeholder = keywords.find((k) => /\[(town|school)\]/i.test(k));
  if (placeholder) throw new Error(`Replace the placeholder in "${placeholder}" with a real town or school name.`);
  const out = [...new Set(keywords.map((k) => k.trim().replace(/^[\["+]+|[\]"]+$/g, "").replace(/\s+/g, " ").toLowerCase()).filter(Boolean))];
  for (const k of out) {
    if (k.length > LIMITS.keyword) throw new Error(`Keyword too long (max ${LIMITS.keyword} chars): "${k}"`);
    if (k.split(" ").length > 10) throw new Error(`Keyword has more than 10 words: "${k}"`);
    if (/[!@%^*()={};~`<>?\\|\[\]]/.test(k)) throw new Error(`Keyword has characters Google rejects: "${k}"`);
  }
  return out;
}

export function keywordOps(adGroupRn: string, keywords: string[], matchType: MatchType, negative = false) {
  return cleanKeywords(keywords).map((text) => ({
    adGroupCriterionOperation: {
      create: { adGroup: adGroupRn, ...(negative ? { negative: true } : { status: "ENABLED" }), keyword: { text, matchType } },
    },
  }));
}

export function campaignNegativeOps(campaignRn: string, keywords: string[], matchType: MatchType) {
  return cleanKeywords(keywords).map((text) => ({
    campaignCriterionOperation: { create: { campaign: campaignRn, negative: true, keyword: { text, matchType } } },
  }));
}

export type RsaInput = { headlines: string[]; descriptions: string[]; final_url: string; path1?: string; path2?: string };

export function validateRsa(a: RsaInput) {
  const errs: string[] = [];
  const h = a.headlines.map((s) => s.trim()).filter(Boolean), d = a.descriptions.map((s) => s.trim()).filter(Boolean);
  if (h.length < LIMITS.headlinesMin || h.length > LIMITS.headlinesMax) errs.push(`Need ${LIMITS.headlinesMin}-${LIMITS.headlinesMax} headlines (got ${h.length}).`);
  if (d.length < LIMITS.descriptionsMin || d.length > LIMITS.descriptionsMax) errs.push(`Need ${LIMITS.descriptionsMin}-${LIMITS.descriptionsMax} descriptions (got ${d.length}).`);
  for (const s of h) if (s.length > LIMITS.headline) errs.push(`Headline over ${LIMITS.headline} chars (${s.length}): "${s}"`);
  for (const s of d) if (s.length > LIMITS.description) errs.push(`Description over ${LIMITS.description} chars (${s.length}): "${s}"`);
  if (new Set(h.map((s) => s.toLowerCase())).size !== h.length) errs.push("Headlines must be unique.");
  if (new Set(d.map((s) => s.toLowerCase())).size !== d.length) errs.push("Descriptions must be unique.");
  for (const [k, v] of [["path1", a.path1], ["path2", a.path2]] as const)
    if (v && (v.length > LIMITS.path || /\s|\//.test(v))) errs.push(`${k} must be ${LIMITS.path} chars or fewer with no spaces or slashes: "${v}"`);
  if (a.path2 && !a.path1) errs.push("path2 needs path1.");
  if (errs.length) throw new Error(`Responsive search ad not valid:\n- ${errs.join("\n- ")}`);
  return { headlines: h, descriptions: d };
}

export function rsaOp(adGroupRn: string, utmCampaign: string, a: RsaInput) {
  const { headlines, descriptions } = validateRsa(a);
  const finalUrl = withUtm(a.final_url, utmCampaign);
  return {
    finalUrl,
    op: {
      adGroupAdOperation: {
        create: {
          adGroup: adGroupRn,
          status: "ENABLED",
          ad: {
            finalUrls: [finalUrl],
            responsiveSearchAd: {
              headlines: headlines.map((text) => ({ text })),
              descriptions: descriptions.map((text) => ({ text })),
              ...(a.path1 ? { path1: a.path1 } : {}),
              ...(a.path2 ? { path2: a.path2 } : {}),
            },
          },
        },
      },
    },
  };
}

// Pulls resource names out of a googleAds:mutate response, in operation order
export function resultNames(response: any): string[] {
  return (response?.mutateOperationResponses || []).map((r: any) => (Object.values(r)[0] as any)?.resourceName).filter(Boolean);
}

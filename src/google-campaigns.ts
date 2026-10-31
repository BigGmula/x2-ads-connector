// Google Ads create tools: campaign, ad group, keywords, responsive search ad, locations,
// and a one-shot builder for a whole Search campaign. Every create supports dry_run / confirm.
import * as b from "./google-builder.js";
import type { MatchType, Place, RsaInput } from "./google-builder.js";

export type Client = {
  mutate(customerId: string, ops: unknown[], validateOnly?: boolean): Promise<any>;
  query(customerId: string, gaql: string): Promise<any[]>;
};
export type Guards = { guardWrite(): void; guardBudget(dollars: number): void };
export type Flags = { dry_run?: boolean; confirm?: boolean };
export type Log = (entry: Record<string, unknown>) => void;

// One JSON line per create call in the server log (Render keeps these under Logs)
export const logCreate: Log = (entry) => console.log(`[google-create] ${JSON.stringify({ at: new Date().toISOString(), ...entry })}`);

const cid = (id: string) => String(id).replace(/-/g, "").trim();
const num = (id: string, what: string) => {
  if (!/^\d+$/.test(String(id).trim())) throw new Error(`${what} must be a numeric ID (got "${id}").`);
  return String(id).trim();
};

export type AdGroupPlan = RsaInput & {
  name: string; max_cpc: number; keywords: string[]; match_type?: MatchType; negative_keywords?: string[];
};
export type CampaignPlan = {
  customer_id: string; name: string; daily_budget: number; max_cpc?: number; locations: Place[];
  negative_keywords?: string[]; negative_match_type?: MatchType; ad_groups: AdGroupPlan[];
};

export function campaignTools(client: Client, guards: Guards, log: Log = logCreate) {
  // Shared path for every create: guard, confirm gate, Google call (validate-only for dry runs)
  async function run(customerId: string, ops: unknown[], f: Flags, what: string) {
    if (!f.dry_run) guards.guardWrite(); // dry runs only validate, so they work in read-only mode too
    if (!f.dry_run && !f.confirm)
      throw new Error(`Not created yet: ${what}. Show the user the plan (or call with dry_run: true to have Google check it first), get their OK, then call again with confirm: true.`);
    try {
      const r = await client.mutate(customerId, ops, !!f.dry_run);
      return { validated: true, names: b.resultNames(r), operations: ops.length };
    } catch (e) {
      if (f.dry_run) return { validated: false, error: (e as Error).message, names: [] as string[], operations: ops.length };
      throw e;
    }
  }

  // Logs every call, including ones refused by the budget cap, read-only mode or a missing confirm
  const logged = <A extends { customer_id: string } & Flags>(tool: string, fn: (a: A) => Promise<any>) => async (a: A) => {
    const entry = { tool, customer_id: cid(a.customer_id), dry_run: !!a.dry_run, confirm: !!a.confirm, name: (a as any).name };
    try {
      const out = await fn(a);
      log({
        ...entry,
        outcome: a.dry_run ? (String(out.google_validation).startsWith("passed") ? "validated" : "invalid") : "created",
        ...(a.dry_run ? { google_validation: out.google_validation } : { result: Object.fromEntries(Object.entries(out).filter(([k]) => /_ids?$/.test(k))) }),
      });
      return out;
    } catch (e) {
      const error = (e as Error).message;
      log({ ...entry, outcome: /^(Refused|Not created yet|This connector is in READ-ONLY)/.test(error) ? "refused" : "error", error });
      throw e;
    }
  };

  const dryOut = (r: { validated: boolean; error?: string }, extra: Record<string, unknown>) => ({
    dry_run: true,
    google_validation: r.validated ? "passed (Google checked every operation; nothing was created)" : `failed: ${r.error}`,
    ...extra,
  });

  // Turns place names into location operations; in a dry run a failed lookup is reported instead of thrown
  async function locations(customerId: string, campaignRn: string, places: Place[], dry: boolean) {
    const { regions, radii } = b.splitPlaces(places);
    try {
      const resolved = await b.resolveRegions(regions, (q) => client.query(customerId, q));
      return {
        ops: b.locationOps(campaignRn, resolved, radii),
        summary: [
          ...resolved.map((r) => ({ place: r.canonical, geo_target: r.geoTargetConstant, type: r.type })),
          ...radii.map((r) => ({ place: `${r.radius_miles} mi around ${r.town}, ${(r.state || "NY").toUpperCase()}` })),
        ],
      };
    } catch (e) {
      if (!dry) throw e;
      return {
        ops: b.locationOps(campaignRn, [], radii),
        summary: [...regions.map((r) => ({ place: r.canonical, geo_target: null })), ...radii.map((r) => ({ place: `${r.radius_miles} mi around ${r.town}` }))],
        error: `Couldn't look up locations: ${(e as Error).message}`,
      };
    }
  }

  async function adGroupName(customerId: string, adGroupId: string) {
    const [row] = await client.query(customerId, `SELECT ad_group.name FROM ad_group WHERE ad_group.id = ${adGroupId}`);
    if (!row?.adGroup?.name) throw new Error(`Ad group ${adGroupId} not found in ${cid(customerId)}.`);
    return row.adGroup.name as string;
  }

  const impl = {
    async createCampaign(a: { customer_id: string; name: string; daily_budget: number; locations: Place[]; start_paused?: boolean; max_cpc?: number } & Flags) {
      guards.guardBudget(a.daily_budget);
      if (!a.locations?.length) throw new Error("Give at least one location; a campaign without locations shows everywhere.");
      const c = b.campaignOps(a.customer_id, a);
      const loc = await locations(a.customer_id, c.campaignRn, a.locations, !!a.dry_run);
      const ops = [...c.ops, ...loc.ops];
      const r = await run(a.customer_id, ops, a, `Search campaign "${a.name}" at $${a.daily_budget}/day (paused)`);
      const plan = {
        name: a.name, status: "PAUSED", bidding: a.max_cpc ? `Maximize Clicks, max CPC $${a.max_cpc}` : "Maximize Clicks",
        daily_budget: a.daily_budget, networks: "Google Search only", locations: loc.summary,
        ...(loc.error ? { locations_error: loc.error } : {}),
        ...(a.start_paused === false ? { note: "start_paused: false is ignored: new campaigns are always created PAUSED. Turn it on with google_set_campaign_status." } : {}),
      };
      if (a.dry_run) return dryOut(r, { plan, operations: ops });
      return {
        created: true, campaign_id: b.idOf(r.names[1]), budget_id: b.idOf(r.names[0]), ...plan,
        next: "Add ad groups (google_create_ad_group), keywords and ads, then turn it on with google_set_campaign_status after the user approves.",
      };
    },

    async createAdGroup(a: { customer_id: string; campaign_id: string; name: string; max_cpc: number } & Flags) {
      const campaignRn = b.res.campaign(a.customer_id, num(a.campaign_id, "campaign_id"));
      const ops = [b.adGroupOp(campaignRn, a.name, a.max_cpc)];
      const r = await run(a.customer_id, ops, a, `ad group "${a.name}" (max CPC $${a.max_cpc}) in campaign ${a.campaign_id}`);
      const plan = { campaign_id: a.campaign_id, name: a.name, max_cpc: a.max_cpc };
      if (a.dry_run) return dryOut(r, { plan, operations: ops });
      return { created: true, ad_group_id: b.idOf(r.names[0]), ...plan };
    },

    async addKeywords(a: { customer_id: string; ad_group_id: string; keywords?: string[]; match_type?: MatchType; negative_keywords?: string[]; negative_match_type?: MatchType } & Flags) {
      const adGroupRn = b.res.adGroup(a.customer_id, num(a.ad_group_id, "ad_group_id"));
      const positive = b.keywordOps(adGroupRn, a.keywords || [], a.match_type || "PHRASE");
      const negative = b.keywordOps(adGroupRn, a.negative_keywords || [], a.negative_match_type || "PHRASE", true);
      if (!positive.length && !negative.length) throw new Error("Give keywords and/or negative_keywords.");
      const ops = [...positive, ...negative];
      const r = await run(a.customer_id, ops, a, `${positive.length} keywords + ${negative.length} negatives in ad group ${a.ad_group_id}`);
      const plan = {
        ad_group_id: a.ad_group_id, match_type: a.match_type || "PHRASE",
        keywords: b.cleanKeywords(a.keywords || []), negative_keywords: b.cleanKeywords(a.negative_keywords || []),
      };
      if (a.dry_run) return dryOut(r, { plan, operations: ops });
      return { created: true, added: positive.length, negatives_added: negative.length, ...plan };
    },

    async createResponsiveSearchAd(a: { customer_id: string; ad_group_id: string; ad_group_name?: string } & RsaInput & Flags) {
      const id = num(a.ad_group_id, "ad_group_id");
      b.validateRsa(a); // fail fast on copy problems before any lookup
      let name = a.ad_group_name, warning: string | undefined;
      if (!name) {
        try { name = await adGroupName(a.customer_id, id); }
        catch (e) {
          if (!a.dry_run) throw e;
          name = `ad-group-${id}`;
          warning = `Couldn't read the ad group name (${(e as Error).message}); utm_campaign uses "${name}" in this dry run.`;
        }
      }
      const { op, finalUrl } = b.rsaOp(b.res.adGroup(a.customer_id, id), name, a);
      const r = await run(a.customer_id, [op], a, `responsive search ad in ad group ${a.ad_group_id} -> ${finalUrl}`);
      const plan = {
        ad_group_id: a.ad_group_id, final_url: finalUrl, display_path: [a.path1, a.path2].filter(Boolean).join("/"),
        headlines: a.headlines.length, descriptions: a.descriptions.length, ...(warning ? { warning } : {}),
      };
      if (a.dry_run) return dryOut(r, { plan, operations: [op] });
      return { created: true, ad_id: b.idOf(r.names[0]).split("~").pop(), status: "ENABLED (shows only when the campaign is on)", ...plan };
    },

    async addLocationTargets(a: { customer_id: string; campaign_id: string; places: Place[] } & Flags) {
      const campaignRn = b.res.campaign(a.customer_id, num(a.campaign_id, "campaign_id"));
      if (!a.places?.length) throw new Error("Give at least one place.");
      const loc = await locations(a.customer_id, campaignRn, a.places, !!a.dry_run);
      const r = await run(a.customer_id, loc.ops, a, `${loc.ops.length} location targets on campaign ${a.campaign_id}`);
      const plan = { campaign_id: a.campaign_id, locations: loc.summary, ...(loc.error ? { locations_error: loc.error } : {}) };
      if (a.dry_run) return dryOut(r, { plan, operations: loc.ops });
      return { created: true, added: loc.ops.length, ...plan };
    },

    // Budget, campaign, locations, negatives, ad groups, keywords and ads in ONE atomic request:
    // either everything is created or nothing is, and a dry run validates the whole thing end to end.
    async buildSearchCampaign(a: CampaignPlan & Flags) {
      guards.guardBudget(a.daily_budget);
      if (!a.locations?.length) throw new Error("Give at least one location.");
      if (!a.ad_groups?.length) throw new Error("Give at least one ad group.");
      const c = b.campaignOps(a.customer_id, a);
      const loc = await locations(a.customer_id, c.campaignRn, a.locations, !!a.dry_run);
      const ops: unknown[] = [...c.ops, ...loc.ops, ...b.campaignNegativeOps(c.campaignRn, a.negative_keywords || [], a.negative_match_type || "PHRASE")];
      const groups = a.ad_groups.map((g, i) => {
        const rn = b.res.adGroup(a.customer_id, -(10 + i));
        const kw = b.keywordOps(rn, g.keywords, g.match_type || "PHRASE");
        if (!kw.length) throw new Error(`Ad group "${g.name}" needs keywords.`);
        const neg = b.keywordOps(rn, g.negative_keywords || [], "PHRASE", true);
        const ad = b.rsaOp(rn, g.name, g);
        ops.push(b.adGroupOp(c.campaignRn, g.name, g.max_cpc, rn), ...kw, ...neg, ad.op);
        return {
          name: g.name, max_cpc: g.max_cpc, match_type: g.match_type || "PHRASE", keywords: b.cleanKeywords(g.keywords),
          ...(neg.length ? { negative_keywords: b.cleanKeywords(g.negative_keywords || []) } : {}),
          final_url: ad.finalUrl, display_path: [g.path1, g.path2].filter(Boolean).join("/"),
          headlines: g.headlines, descriptions: g.descriptions,
        };
      });
      const r = await run(a.customer_id, ops, a,
        `Search campaign "${a.name}" at $${a.daily_budget}/day (paused) with ${groups.length} ad groups`);
      const plan = {
        campaign: { name: a.name, status: "PAUSED", daily_budget: a.daily_budget, bidding: a.max_cpc ? `Maximize Clicks, max CPC $${a.max_cpc}` : "Maximize Clicks", networks: "Google Search only" },
        locations: loc.summary, ...(loc.error ? { locations_error: loc.error } : {}),
        campaign_negative_keywords: b.cleanKeywords(a.negative_keywords || []),
        ad_groups: groups, operations: ops.length,
      };
      if (a.dry_run) return dryOut(r, plan);
      const names = r.names;
      return {
        created: true, campaign_id: b.idOf(names.find((n) => n.includes("/campaigns/"))!),
        ad_group_ids: names.filter((n) => n.includes("/adGroups/")).map(b.idOf),
        ...plan,
        next: "Created PAUSED. Review it in Google Ads, then turn it on with google_set_campaign_status after the user approves.",
      };
    },
  };
  return {
    createCampaign: logged("google_create_campaign", impl.createCampaign),
    createAdGroup: logged("google_create_ad_group", impl.createAdGroup),
    addKeywords: logged("google_add_keywords", impl.addKeywords),
    createResponsiveSearchAd: logged("google_create_responsive_search_ad", impl.createResponsiveSearchAd),
    addLocationTargets: logged("google_add_location_targets", impl.addLocationTargets),
    buildSearchCampaign: logged("google_build_search_campaign", impl.buildSearchCampaign),
  };
}

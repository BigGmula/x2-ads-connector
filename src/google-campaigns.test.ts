import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as b from "./google-builder.js";
import { campaignTools, type Client } from "./google-campaigns.js";

const CUST = "123-456-7890";
const GEO: Record<string, string> = {
  "Nassau County,New York,United States": "geoTargetConstants/9001",
  "Suffolk County,New York,United States": "geoTargetConstants/9002",
};

// Fake Google Ads client: records mutate calls, answers geo and ad group lookups
function fake(opts: { fail?: string } = {}) {
  const calls: { customerId: string; ops: any[]; validateOnly: boolean }[] = [];
  const client: Client = {
    async query(_c, gaql) {
      if (gaql.includes("FROM geo_target_constant"))
        return Object.entries(GEO).filter(([n]) => gaql.includes(n)).map(([canonicalName, resourceName]) => ({ geoTargetConstant: { canonicalName, resourceName, targetType: "County" } }));
      if (gaql.includes("FROM ad_group")) return [{ adGroup: { name: "Custom Hats" } }];
      return [];
    },
    async mutate(customerId, ops, validateOnly = false) {
      calls.push({ customerId, ops: ops as any[], validateOnly });
      if (opts.fail) throw new Error(opts.fail);
      if (validateOnly) return {};
      // Echo back resource names with real-looking IDs, in operation order
      return {
        mutateOperationResponses: (ops as any[]).map((op, i) => {
          const [kind, body] = Object.entries(op)[0] as [string, any];
          const rn = body.create.resourceName?.replace(/-\d+$/, String(1000 + i)) || `customers/1234567890/x/${1000 + i}`;
          const result = kind.replace("Operation", "Result");
          return { [result]: { resourceName: kind === "adGroupAdOperation" ? `customers/1234567890/adGroupAds/55~${1000 + i}` : rn } };
        }),
      };
    },
  };
  return { client, calls };
}

let budgetCap = 30, readOnly = false;
const guards = {
  guardWrite() { if (readOnly) throw new Error("READ-ONLY"); },
  guardBudget(d: number) { if (!(d > 0) || d > budgetCap) throw new Error(`Refused: $${d}/day is above your safety cap of $${budgetCap}/day (MAX_DAILY_BUDGET).`); },
};
function tools(opts: { fail?: string } = {}) {
  const f = fake(opts), logs: any[] = [];
  return { ...f, logs, t: campaignTools(f.client, guards, (e) => logs.push(e)) };
}

// ---------- builder ----------
test("withUtm adds google/cpc/ad group slug and keeps existing params", () => {
  const u = new URL(b.withUtm("https://47swagco.com/collections/business-bundles?variant=1", "Team & Business Merch"));
  assert.equal(u.searchParams.get("utm_source"), "google");
  assert.equal(u.searchParams.get("utm_medium"), "cpc");
  assert.equal(u.searchParams.get("utm_campaign"), "team-business-merch");
  assert.equal(u.searchParams.get("variant"), "1");
  const kept = new URL(b.withUtm("https://x.com/?utm_campaign=fall", "Hats"));
  assert.equal(kept.searchParams.get("utm_campaign"), "fall");
});

test("parseRegion builds Google canonical names", () => {
  assert.equal(b.parseRegion("Nassau County, NY").canonical, "Nassau County,New York,United States");
  assert.equal(b.parseRegion("Suffolk County, New York").canonical, "Suffolk County,New York,United States");
  assert.throws(() => b.parseRegion("Springfield, ZZ"), /Unknown US state/);
});

test("radius places become proximity criteria (address, or lat/lng when given)", () => {
  const ops = b.locationOps("customers/1/campaigns/2", [], [
    { town: "West Islip", radius_miles: 5 },
    { town: "Lindenhurst", radius_miles: 3, lat: 40.6868, lng: -73.3735 },
  ]) as any[];
  assert.deepEqual(ops[0].campaignCriterionOperation.create.proximity, { radius: 5, radiusUnits: "MILES", address: { cityName: "West Islip", provinceCode: "NY", countryCode: "US" } });
  assert.deepEqual(ops[1].campaignCriterionOperation.create.proximity.geoPoint, { latitudeInMicroDegrees: 40686800, longitudeInMicroDegrees: -73373500 });
  assert.throws(() => b.splitPlaces([{ town: "X", radius_miles: 0 }]), /between 0 and 500/);
});

test("campaignOps: own budget, PAUSED, Maximize Clicks, Search only, presence targeting", () => {
  const { ops, budgetRn } = b.campaignOps(CUST, { name: "C", daily_budget: 20, max_cpc: 3, start_paused: false }) as any;
  const budget = ops[0].campaignBudgetOperation.create, camp = ops[1].campaignOperation.create;
  assert.equal(budget.amountMicros, "20000000");
  assert.equal(budget.explicitlyShared, false);
  assert.equal(camp.status, "PAUSED");
  assert.equal(camp.campaignBudget, budgetRn);
  assert.equal(camp.advertisingChannelType, "SEARCH");
  assert.deepEqual(camp.targetSpend, { cpcBidCeilingMicros: "3000000" });
  assert.equal(camp.networkSettings.targetSearchNetwork, false);
  assert.equal(camp.geoTargetTypeSetting.positiveGeoTargetType, "PRESENCE");
  assert.equal(camp.containsEuPoliticalAdvertising, "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING");
});

test("keywords are cleaned, de-duplicated and placeholders rejected", () => {
  assert.deepEqual(b.cleanKeywords([" Custom Hats ", "[custom hats]", "\"custom beanies\""]), ["custom hats", "custom beanies"]);
  assert.throws(() => b.cleanKeywords(["[town] hoodie"]), /placeholder/);
  assert.throws(() => b.cleanKeywords(["hats!"]), /characters/);
  const neg = b.keywordOps("customers/1/adGroups/2", ["free"], "BROAD", true) as any[];
  assert.equal(neg[0].adGroupCriterionOperation.create.negative, true);
});

test("validateRsa enforces Google's limits", () => {
  const ok = { headlines: ["A", "B", "C"], descriptions: ["D", "E"], final_url: "https://47swagco.com" };
  assert.doesNotThrow(() => b.validateRsa(ok));
  assert.throws(() => b.validateRsa({ ...ok, headlines: ["A", "B"] }), /3-15 headlines/);
  assert.throws(() => b.validateRsa({ ...ok, headlines: [...ok.headlines, "x".repeat(31)] }), /over 30/);
  assert.throws(() => b.validateRsa({ ...ok, descriptions: ["D", "y".repeat(91)] }), /over 90/);
  assert.throws(() => b.validateRsa({ ...ok, headlines: ["A", "a", "C"] }), /unique/);
  assert.throws(() => b.validateRsa({ ...ok, path1: "has space" }), /path1/);
  assert.throws(() => b.validateRsa({ ...ok, headlines: Array.from({ length: 16 }, (_, i) => `H${i}`) }), /3-15/);
});

// ---------- tools: safety ----------
test("create without dry_run or confirm is refused, logged, and calls nothing", async () => {
  const { t, calls, logs } = tools();
  await assert.rejects(t.createAdGroup({ customer_id: CUST, campaign_id: "77", name: "Custom Hats", max_cpc: 2 }), /confirm: true/);
  assert.equal(calls.length, 0);
  assert.equal(logs[0].outcome, "refused");
  assert.equal(logs[0].tool, "google_create_ad_group");
});

test("daily budget above MAX_DAILY_BUDGET is refused even with confirm", async () => {
  const { t, calls, logs } = tools();
  await assert.rejects(t.createCampaign({ customer_id: CUST, name: "C", daily_budget: 31, locations: ["Nassau County, NY"], confirm: true }), /safety cap of \$30/);
  assert.equal(logs[0].outcome, "refused");
  assert.equal(logs[0].tool, "google_create_campaign");
  await assert.rejects(t.buildSearchCampaign({ customer_id: CUST, name: "C", daily_budget: 50, locations: ["Nassau County, NY"], ad_groups: [], dry_run: true }), /safety cap/);
  assert.equal(calls.length, 0);
});

test("read-only mode blocks real creates but allows dry runs", async () => {
  readOnly = true;
  try {
    const { t, calls } = tools();
    await assert.rejects(t.createAdGroup({ customer_id: CUST, campaign_id: "77", name: "G", max_cpc: 2, confirm: true }), /READ-ONLY/);
    const r: any = await t.createAdGroup({ customer_id: CUST, campaign_id: "77", name: "G", max_cpc: 2, dry_run: true });
    assert.equal(r.dry_run, true);
    assert.equal(calls[0].validateOnly, true);
  } finally { readOnly = false; }
});

test("campaigns are created PAUSED even when start_paused is false", async () => {
  const { t, calls, logs } = tools();
  const r: any = await t.createCampaign({ customer_id: CUST, name: "47 Swag", daily_budget: 20, locations: ["Nassau County, NY", { town: "West Islip", radius_miles: 5 }], start_paused: false, confirm: true });
  assert.equal(calls[0].validateOnly, false);
  assert.equal(calls[0].ops[1].campaignOperation.create.status, "PAUSED");
  assert.equal(r.status, "PAUSED");
  assert.match(r.note, /always created PAUSED/);
  assert.equal(r.campaign_id, "1001");
  assert.equal(r.budget_id, "1000");
  // budget + campaign + county + radius
  assert.equal(calls[0].ops.length, 4);
  assert.equal(calls[0].ops[2].campaignCriterionOperation.create.location.geoTargetConstant, "geoTargetConstants/9001");
  assert.equal(logs.at(-1).outcome, "created");
});

test("dry run validates with Google (validateOnly) and returns the plan", async () => {
  const { t, calls, logs } = tools();
  const r: any = await t.addLocationTargets({ customer_id: CUST, campaign_id: "77", places: ["Nassau County, NY", "Suffolk County, NY"], dry_run: true });
  assert.equal(calls[0].validateOnly, true);
  assert.match(r.google_validation, /^passed/);
  assert.equal(r.plan.locations.length, 2);
  assert.equal(logs[0].outcome, "validated");
});

test("dry run reports Google errors instead of throwing; real create throws", async () => {
  const { t } = tools({ fail: "Google Ads API error 400: bad keyword" });
  const r: any = await t.addKeywords({ customer_id: CUST, ad_group_id: "55", keywords: ["custom hats"], dry_run: true });
  assert.match(r.google_validation, /failed: .*bad keyword/);
  await assert.rejects(t.addKeywords({ customer_id: CUST, ad_group_id: "55", keywords: ["custom hats"], confirm: true }), /bad keyword/);
});

test("unknown location fails a real create", async () => {
  const { t } = tools();
  await assert.rejects(t.addLocationTargets({ customer_id: CUST, campaign_id: "77", places: ["Atlantis County, NY"], confirm: true }), /no location named/);
});

test("RSA looks up the ad group name for utm_campaign", async () => {
  const { t, calls } = tools();
  const r: any = await t.createResponsiveSearchAd({
    customer_id: CUST, ad_group_id: "55", headlines: ["Custom Hats", "Long Island Made", "Embroidered Hats"],
    descriptions: ["Custom embroidered hats.", "Order online today."], final_url: "https://47swagco.com/products/x", path1: "custom", path2: "hats", confirm: true,
  });
  assert.equal(r.final_url, "https://47swagco.com/products/x?utm_source=google&utm_medium=cpc&utm_campaign=custom-hats");
  assert.equal(r.ad_id, "1000");
  assert.equal(calls[0].ops[0].adGroupAdOperation.create.ad.responsiveSearchAd.path2, "hats");
});

test("non-numeric IDs are rejected", async () => {
  const { t } = tools();
  await assert.rejects(t.createAdGroup({ customer_id: CUST, campaign_id: "abc", name: "G", max_cpc: 1, dry_run: true }), /numeric/);
});

test("the 47swagco.com campaign plan passes every check and stays paused under the cap", async () => {
  const plan = JSON.parse(readFileSync(new URL("../campaigns/47swagco-search.json", import.meta.url), "utf8"));
  const { t, calls } = tools();
  const r: any = await t.buildSearchCampaign({ customer_id: CUST, ...plan, dry_run: true });
  assert.match(r.google_validation, /^passed/);
  assert.equal(calls[0].validateOnly, true);
  assert.equal(r.campaign.status, "PAUSED");
  assert.ok(plan.daily_budget <= 30);
  assert.deepEqual(r.ad_groups.map((g: any) => g.name), ["Custom Hats", "Custom Beanies", "Town Hoodies", "Team & Business Merch"]);
  assert.deepEqual(r.campaign_negative_keywords, ["free", "cheap", "diy", "jobs", "wholesale blanks"]);
  assert.deepEqual(r.locations.map((l: any) => l.geo_target), ["geoTargetConstants/9001", "geoTargetConstants/9002"]);
  for (const g of r.ad_groups) assert.match(g.final_url, /^https:\/\/47swagco\.com\/.+utm_source=google&utm_medium=cpc&utm_campaign=/);
});

test("buildSearchCampaign links everything with temporary IDs in one request", async () => {
  const { t, calls } = tools();
  const g = (name: string) => ({
    name, max_cpc: 2, keywords: [`${name} long island`, name], headlines: ["One", "Two", "Three"], descriptions: ["Desc one.", "Desc two."],
    final_url: "https://47swagco.com/collections/x", path1: "custom",
  });
  const r: any = await t.buildSearchCampaign({
    customer_id: CUST, name: "47 Swag Co - Search", daily_budget: 20, locations: ["Nassau County, NY", "Suffolk County, NY"],
    negative_keywords: ["free", "cheap"], ad_groups: [g("custom hats"), g("custom beanies")], confirm: true,
  });
  assert.equal(calls.length, 1);
  const ops = calls[0].ops;
  const groupRns = ops.filter((o) => o.adGroupOperation).map((o) => o.adGroupOperation.create.resourceName);
  assert.deepEqual(groupRns, ["customers/1234567890/adGroups/-10", "customers/1234567890/adGroups/-11"]);
  assert.ok(ops.filter((o) => o.adGroupOperation).every((o) => o.adGroupOperation.create.campaign === "customers/1234567890/campaigns/-2"));
  assert.equal(ops.filter((o) => o.adGroupCriterionOperation).length, 4);
  assert.equal(ops.filter((o) => o.campaignCriterionOperation?.create.negative).length, 2);
  const ad = ops.find((o) => o.adGroupAdOperation).adGroupAdOperation.create;
  assert.equal(ad.adGroup, "customers/1234567890/adGroups/-10");
  assert.match(ad.ad.finalUrls[0], /utm_campaign=custom-hats/);
  assert.equal(r.ad_group_ids.length, 2);
  assert.equal(r.campaign.status, "PAUSED");
});

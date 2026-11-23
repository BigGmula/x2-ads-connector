import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { loadBrands, matchBrand, pageIdFor, customScript, brandLook } from "./brands.js";
import { parseRows } from "./scheduler.js";

test("brands file: every brand has an id, a Page and match words; the first is the default 47 Swag Co Page", async () => {
  const brands = await loadBrands();
  assert.equal(brands[0].page_id, "1378673685337029");
  for (const b of brands) assert.ok(b.id && /^\d{8,}$/.test(b.page_id) && b.match.length, b.id);
  assert.equal(new Set(brands.map((b) => b.page_id)).size, brands.length);
});

test("a brand is picked by name, handle or Page ID, never from digits inside another Page ID", async () => {
  const brands = await loadBrands();
  const id = (v?: string) => matchBrand(brands, v)?.id;
  assert.equal(id("wallvice"), "wallvice");
  assert.equal(id("Wall Vice"), "wallvice");
  assert.equal(id("@wallviceart"), "wallvice");
  assert.equal(id("1365533129984620"), "wallvice");
  assert.equal(id("47 Swag Co"), "47swagco");
  assert.equal(id("47swagco"), "47swagco");
  assert.equal(id(""), undefined);
  assert.equal(id("some other shop"), undefined);
  assert.equal(id("99994700001111"), undefined); // an unknown Page ID that happens to contain "47"
});

test("page cell -> Page ID: a brand, a bare Page ID, or nothing for a typo", async () => {
  const brands = await loadBrands();
  assert.equal(pageIdFor(brands, "Wallvice"), "1365533129984620");
  assert.equal(pageIdFor(brands, " 123456789012345 "), "123456789012345");
  assert.equal(pageIdFor(brands, "walvice"), undefined);
});

test("voiceover cell: a sentence is the script, one word is an angle", () => {
  assert.equal(customScript("Stop shopping for art. Start saying it."), "Stop shopping for art. Start saying it.");
  assert.equal(customScript("town-callout"), undefined);
  assert.equal(customScript(undefined), undefined);
});

test("brand look: Wallvice brings its voice and closing slide, the default brand changes nothing", async () => {
  const brands = await loadBrands();
  const w = brandLook(matchBrand(brands, "wallvice"));
  assert.equal(w.voice, "68RUZBDjLe2YBQvv8zFx");
  assert.equal(w.endSlide, "reels/brand/wallvice-end-card.png");
  await stat(w.endSlide!); // the closing card ships with the repo
  assert.equal(w.endCard, undefined);
  assert.deepEqual(brandLook(undefined), {});
  const d = brandLook(matchBrand(brands, "47swagco"));
  assert.ok(!d.voice && !d.endCard && !d.endSlide);
});

test("schedule rows: the page column is read, and rows without one keep the key they had before the column existed", () => {
  const before = parseRows("date,time,type,product_id,caption,media,video,status\n2026-11-02,12:00 PM,reel,P25,Build me,,,approved\n");
  const after = parseRows("date,time,type,product_id,page,caption,media,video,status\n2026-11-02,12:00 PM,reel,P25,,Build me,,,approved\n2026-11-02,12:00 PM,reel,P25,Wallvice,Build me,,,approved\n");
  // The key as it was computed before the page column was added
  const legacy = createHash("sha1").update(JSON.stringify(["2026-11-02", "12:00 PM", "reel", "P25", ["instagram", "facebook"], "Build me", undefined, [], undefined])).digest("hex").slice(0, 16);
  assert.equal(before[0].key, legacy);
  assert.equal(after[0].key, legacy);
  assert.equal(after[0].page, undefined);
  assert.equal(after[1].page, "Wallvice");
  assert.notEqual(after[1].key, before[0].key); // the same reel to another Page is its own post
  assert.equal(parseRows("date,time,type,brand,caption,video,status\n2026-11-02,9am,reel,wallvice,Hi,https://x/v.mp4,approved\n")[0].page, "wallvice");
});

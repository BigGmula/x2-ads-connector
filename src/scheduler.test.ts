import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, parseRows, easternTime, sheetCsvUrl, tick, type SchedulerDeps } from "./scheduler.js";

test("CSV with quotes, commas and line breaks", () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","line1\nline2 ""q"""\n'), [["a", "b"], ["x, y", 'line1\nline2 "q"']]);
});

test("Eastern time, both date styles, across DST", () => {
  assert.equal(easternTime("2026-11-02", "11:30 AM")!.toISOString(), "2026-11-02T16:30:00.000Z"); // EST
  assert.equal(easternTime("10/30/2026", "7pm")!.toISOString(), "2026-10-30T23:00:00.000Z"); // EDT
  assert.equal(easternTime("11/2/2026", "12:15:00 AM")!.toISOString(), "2026-11-02T05:15:00.000Z");
  assert.equal(easternTime("tomorrow", "9"), undefined);
});

test("sheet link to CSV export", () => {
  assert.equal(sheetCsvUrl("https://docs.google.com/spreadsheets/d/abc_123/edit#gid=42"), "https://docs.google.com/spreadsheets/d/abc_123/export?format=csv&gid=42");
});

test("rows: defaults and problems", () => {
  const rows = parseRows("Date,Time,Type,Product ID,Platforms,Caption,Media,Status\n2026-11-02,9am,post,,ig,Hi,,approved\n2026-11-02,10am,reel,P25,,Yo,,Approved\n");
  assert.deepEqual(rows[0].platforms, ["instagram"]);
  assert.match(rows[0].problems.join(), /image link/);
  assert.deepEqual(rows[1].platforms, ["instagram", "facebook"]);
  assert.equal(rows[1].status, "approved");
  assert.equal(rows[1].problems.length, 0);
});

test("tick: builds ahead, posts when due, once, and skips unapproved or late rows", async () => {
  process.env.SCHEDULE_SHEET_URL = "https://docs.google.com/spreadsheets/d/test/edit";
  process.env.SCHEDULE_STATE_FILE = `${process.env.TMP || "/tmp"}/schedtest/state-${Date.now()}.json`;
  const csv = "date,time,type,product_id,caption,media,video,status\n" +
    "2026-11-02,12:00 PM,reel,P25,Build me,,,approved\n" +
    "2026-11-02,12:00 PM,post,,Photo,https://x/y.png,,approved\n" +
    "2026-11-02,12:00 PM,post,,Draft,https://x/y.png,,draft\n" +
    "2026-11-02,10:00 AM,reel,,Late,,https://x/v.mp4,approved\n";
  globalThis.fetch = (async () => new Response(csv)) as any;
  const calls: string[] = [];
  const deps: SchedulerDeps = {
    validate: async () => [],
    build: async (r) => { calls.push(`build ${r.caption}`); return { video_url: "https://h/v.mp4" }; },
    publishReel: async (r, v) => { calls.push(`reel ${r.caption} ${v.video_url}`); return { instagram: { permalink: "ig" }, facebook: { permalink: "fb" } }; },
    publishPost: async (r) => { calls.push(`post ${r.caption}`); return { instagram: { media_id: "1" }, facebook: { error: "nope" } }; },
    alreadyPosted: async () => false,
  };
  const noon = easternTime("2026-11-02", "12:00 PM")!.getTime();
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await tick(deps, noon - 60 * 60_000); await settle(); // too early for anything
  assert.deepEqual(calls, []);
  await tick(deps, noon - 20 * 60_000); await settle(); // inside the build window
  assert.deepEqual(calls, ["build Build me"]);
  await tick(deps, noon + 60_000); await settle(); // due
  await tick(deps, noon + 2 * 60_000); await settle(); // again: nothing reposts
  assert.deepEqual(calls.sort(), ["build Build me", "post Photo", "reel Build me https://h/v.mp4"]);
});

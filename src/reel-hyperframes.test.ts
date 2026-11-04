import test from "node:test";
import assert from "node:assert/strict";
import { compositionHtml } from "./reel-hyperframes.js";

const html = compositionHtml({ slides: ["a.png", "b.png", "c.png"], durations: [2, 3, 4], transition: 0.35, accent: "0x112233", highlight: "0xFFAA00" });

test("composition runs the full length and registers its timeline", () => {
  assert.match(html, /data-composition-id="main" data-start="0" data-duration="9"/);
  assert.match(html, /window\.__timelines\.main=tl/);
});

test("each later slide starts early enough to wipe over the one before", () => {
  assert.match(html, /id="s1"[^>]*data-start="1\.65" data-duration="3\.35"/);
  assert.match(html, /id="s2"[^>]*data-start="4\.65" data-duration="4\.35"/);
});

test("brand colors become CSS colors", () => {
  assert.match(html, /background:#112233/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { alignWords, captionGroups, captionTimes, compositionHtml, snapDurations } from "./reel-hyperframes.js";

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

test("slide changes move to the nearest beat and the total stays the same", () => {
  const d = snapDurations([2, 3, 4], [2.2, 4.9, 8.5]);
  assert.deepEqual(d, [2.2, 2.7, 4.1]);
  assert.equal(d.reduce((a, b) => a + b, 0), 9);
});

test("a beat too far away leaves the change alone", () => {
  assert.deepEqual(snapDurations([2, 3], [3.5]), [2, 3]);
  assert.deepEqual(snapDurations([2, 3], []), [2, 3]);
});

const w = (text: string, start: number) => ({ text, start, end: start + 0.2 });

test("captions keep the script's spelling when the word counts match", () => {
  assert.equal(alignWords([w("Okay", 0), w("Massapequa,", 1)], "Okay Massapequa...")[1].text, "Massapequa...");
  assert.equal(alignWords([w("Okay", 0)], "Two words")[0].text, "Okay");
});

test("caption times start with the voice and follow its speed", () => {
  assert.deepEqual(captionTimes([w("a", 1), w("b", 3)], 0.3, 2).map((x) => x.start), [0.3, 1.3]);
});

test("captions break at punctuation and stop before the last slide", () => {
  const g = captionGroups([w("one,", 0), w("two", 1), w("three", 2), w("four", 3), w("five", 4), w("six", 9)], 5);
  assert.deepEqual(g.map((x) => x.map((y) => y.text).join(" ")), ["one,", "two three four", "five"]);
});

test("a pause in the script ends the phrase, and the dots aren't shown", () => {
  const h = compositionHtml({ slides: ["a.png"], durations: [5], transition: 0.35, accent: "0x000000", highlight: "0xFFAA00", captions: [w("Okay", 0), w("Town...", 1), w("this", 2)] });
  assert.match(h, /OKAY<\/span> <span id="w0_1">TOWN<\/span><\/div>/);
});

test("caption words are escaped and highlighted in time", () => {
  const h = compositionHtml({ slides: ["a.png", "b.png"], durations: [3, 3], transition: 0.35, accent: "0x000000", highlight: "0xFFAA00", captions: [w("R&B", 1)] });
  assert.match(h, /R&amp;B/);
  assert.match(h, /tl\.set\("#w0_0",\{color:"#FFAA00"/);
});

// Build reels locally from a JSON job file:  npm run reel -- reels/p25-east-islip.json
// Job file: { name, outDir?, slides: [{src, text?, seconds?}], fit?, motion?, safeArea?, transition?,
//             hooks?: [..], music?: [..] | false, variants?, musicStart?, secondsPerSlide?, endCard?: {logo?, shopUrl?, code?, cta?} }
// Slide src: local path (relative to the job file), public URL, Google Drive link, or "drive:<file id>"
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildReelVariants, pickTracks } from "./reel.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run reel -- <job.json>");
  process.exit(1);
}
const job = JSON.parse(await readFile(file, "utf8"));
const base = path.dirname(path.resolve(file));
const local = (p?: string) => (p && !/^(https?:\/\/|drive:)/i.test(p) ? path.resolve(base, p) : p);

const started = Date.now();
const results = await buildReelVariants(
  {
    slides: job.slides.map((s: any) => ({ ...s, src: local(s.src) })),
    fit: job.fit, motion: job.motion, safeArea: job.safeArea, transition: job.transition,
    endCard: job.endCard && { ...job.endCard, logo: local(job.endCard.logo) },
    musicStart: job.musicStart,
    secondsPerSlide: job.secondsPerSlide,
  },
  job.hooks || (job.hook ? [job.hook] : []),
  // music: list of tracks, false for silent, or left out to pick `variants` (default 1) different tracks from ./music
  job.music === false ? [] : job.music ? job.music.map(local) : await pickTracks(job.variants || 1),
  path.resolve(base, job.outDir || "out"),
  job.name || path.basename(file, ".json"),
);
for (const r of results) console.log(`${r.variant}: ${r.path} (${r.duration}s)${r.hook ? ` hook="${r.hook}"` : ""}${r.music ? ` music=${path.basename(r.music)}` : ""}`);
console.log(`Done in ${Math.round((Date.now() - started) / 1000)}s.`);

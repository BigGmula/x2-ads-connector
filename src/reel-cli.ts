// Build reels locally.
//   npm run reel -- reels/p25-east-islip.json   a JSON job file (below)
//   npm run reel -- P25 P17                     products from reels/slide-sets.json
//   npm run reel -- --all                       every product with a slide set (HOLD ones included, marked in the name)
// Job file: { name, outDir?, slides: [{src, text?, seconds?}], fit?, motion?, safeArea?, transition?,
//             hooks?: [..], music?: [..] | false, variants?, musicStart?, secondsPerSlide?, endCard?: {logo?, shopUrl?, code?, cta?} }
// Slide src: local path (relative to the job file), public URL, Google Drive link, or "drive:<file id>"
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildReelVariants, pickTracks } from "./reel.js";

const args = process.argv.slice(2);
if (!args.length) {
  console.error("Usage: npm run reel -- <job.json> | <product id...> | --all");
  process.exit(1);
}

const started = Date.now();

if (args[0].endsWith(".json")) {
  const file = args[0];
  const job = JSON.parse(await readFile(file, "utf8"));
  const base = path.dirname(path.resolve(file));
  const local = (p?: string) => (p && !/^(https?:\/\/|drive:)/i.test(p) ? path.resolve(base, p) : p);
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
} else {
  const sets: { id: string; town: string; hold: boolean; slides: string[] }[] = JSON.parse(await readFile("reels/slide-sets.json", "utf8")).products;
  const wanted = args[0] === "--all" ? sets : args.map((id) => {
    const p = sets.find((s) => s.id.toUpperCase() === id.toUpperCase());
    if (!p) throw new Error(`No slide set for ${id}.`);
    return p;
  });
  // Spread the tracks out so neighbouring reels don't share a song
  const tracks = await pickTracks(wanted.length);
  for (const [i, p] of wanted.entries()) {
    const name = `${p.id}-${p.town.toLowerCase().replace(/[^a-z0-9]+/g, "-")}${p.hold ? "-HOLD" : ""}`;
    try {
      const [r] = await buildReelVariants({ slides: p.slides.map((id) => ({ src: `drive:${id}` })) }, [], [tracks[i]], path.resolve("reels/out"), name);
      console.log(`${p.id} ${p.town}: ${path.basename(r.path)} (${r.duration}s) music=${path.basename(tracks[i])}`);
    } catch (e) {
      console.log(`${p.id} ${p.town}: FAILED ${(e as Error).message.slice(0, 300)}`);
    }
  }
}
console.log(`Done in ${Math.round((Date.now() - started) / 1000)}s.`);

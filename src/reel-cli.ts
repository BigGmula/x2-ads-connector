// Build reels locally.
//   npm run reel -- reels/p25-east-islip.json   a JSON job file (below)
//   npm run reel -- P25 P17                     products from reels/slide-sets.json
//   npm run reel -- --all                       every product with a slide set (HOLD ones included, marked in the name)
//   npm run reel -- P25 --vo each --platform facebook   add a voiceover (an angle from reels/voiceover-scripts.json, random, or each)
// Job file: { name, outDir?, slides: [{src, text?, seconds?}], fit?, motion?, safeArea?, transition?,
//             hooks?: [..], music?: [..] | false, variants?, musicStart?, secondsPerSlide?, endCard?: {logo?, shopUrl?, code?, cta?} }
// Slide src: local path (relative to the job file), public URL, Google Drive link, or "drive:<file id>"
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildReelVariants, pickTracks } from "./reel.js";
import { angleIds, fillScript, type Platform, type ScriptProduct } from "./scripts.js";

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
  // Flags: --vo <angle | random | each>  (each = one version per script angle)   --platform instagram|facebook
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const vo = flag("--vo"), platform = (flag("--platform") || "instagram") as Platform;
  const sets: (ScriptProduct & { id: string; hold: boolean; slides: string[] })[] = JSON.parse(await readFile("reels/slide-sets.json", "utf8")).products;
  const wanted = args[0] === "--all" ? sets : args.map((id) => {
    const p = sets.find((s) => s.id.toUpperCase() === id.toUpperCase());
    if (!p) throw new Error(`No slide set for ${id}.`);
    return p;
  });
  const angles = vo === "each" ? await angleIds() : vo ? [vo] : [];
  // Spread the tracks out so neighbouring reels don't share a song
  const tracks = await pickTracks(wanted.length * Math.max(angles.length, 1));
  for (const [i, p] of wanted.entries()) {
    const name = `${p.id}-${p.town.toLowerCase().replace(/[^a-z0-9]+/g, "-")}${p.hold ? "-HOLD" : ""}${vo ? "-vo" : ""}`;
    try {
      const scripts = await Promise.all(angles.map((a) => fillScript(p, a, platform)));
      const mine = tracks.slice(i * Math.max(angles.length, 1), (i + 1) * Math.max(angles.length, 1));
      const rs = await buildReelVariants({ slides: p.slides.map((id) => ({ src: `drive:${id}` })) }, [], mine, path.resolve("reels/out"), name, Math.max(angles.length, 1), scripts.map((s) => s.text));
      for (const [k, r] of rs.entries())
        console.log(`${p.id} ${p.town}: ${path.basename(r.path)} (${r.duration}s) music=${path.basename(r.music || "none")}${scripts[k] ? ` vo=${scripts[k].angle} voice=${r.voice}` : ""}`);
    } catch (e) {
      console.log(`${p.id} ${p.town}: FAILED ${(e as Error).message.slice(0, 300)}`);
    }
  }
}
console.log(`Done in ${Math.round((Date.now() - started) / 1000)}s.`);

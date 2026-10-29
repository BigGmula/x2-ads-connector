// Reel builder: slides -> 9:16 MP4 (H.264 + AAC, 1080x1920, 30 fps) using ffmpeg
//
// Two looks:
//  - "fit"  (default): designed 9:16 reel slides that already carry their own text, price and CTA.
//           Shown whole, never cropped, no overlays, gentle push-in, short dissolves.
//  - "blur": plain product photos (e.g. Shopify images). Photo over a blurred copy of itself,
//           Ken Burns motion, optional hook / captions / end card drawn on top.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir, availableParallelism } from "node:os";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ffmpegStatic from "ffmpeg-static";
import { pickVoice, speak, voiceName, wavSeconds } from "./voice.js";

const W = 1080, H = 1920, FPS = 30;
// Small servers (e.g. Render's 512 MB / 0.5 CPU plan): one filter thread, a faster x264 preset and a lighter
// supersample for the push-in, so a reel fits in memory and builds in about a minute.
// Render reports the host's cores, not the plan's, so being on Render (RENDER=true) counts as low power too.
const LOW_POWER = process.env.REEL_LOW_POWER ? process.env.REEL_LOW_POWER === "true" : process.env.RENDER === "true" || availableParallelism() <= 2;
const SS = LOW_POWER ? 1.5 : 2; // push-in is rendered at this multiple of 1080x1920, then scaled down (smooth motion)
const HOOK_SECONDS = 1.5;
// Timing for a designed 5-slide set: hook, on-model, detail, styled outfit, price + CTA
export const SET_TIMING = [2.0, 3.0, 2.5, 2.5, 4.0];
// Instagram draws its header over the top and caption/buttons over the bottom of a Reel
const SAFE_TOP = 110, SAFE_BOTTOM = 340;

export type Brand = {
  font?: string;        // .ttf path; defaults to Anton (bundled via npm)
  accent: string;       // ffmpeg colors, e.g. 0x1F51FF
  highlight: string;
  background: string;
};

// 47 Swag Co: black, white, electric blue, restrained pink accent
export const DEFAULT_BRAND: Brand = { accent: "0x1F51FF", highlight: "0xFF4FA3", background: "black" };

export type ReelSlide = { src: string; text?: string; seconds?: number };

export type ReelOptions = {
  slides: ReelSlide[];          // 1-8 images: public URLs, Google Drive links / "drive:<file id>", or local paths
  fit?: "fit" | "blur";         // see top of file; default "fit"
  motion?: "push" | "kenburns" | "none"; // default: push for fit, kenburns for blur
  safeArea?: boolean;           // shrink slides so nothing sits under Instagram's header, caption or buttons
  transition?: number;          // dissolve length in seconds; default 0.2 (fit) / 0.35 (blur)
  hook?: string;                // big text for the first 1.5 s (blur look; designed slides have their own)
  endCard?: { logo?: string; shopUrl?: string; code?: string; cta?: string };
  music?: string;               // URL or local path to a track the business owns or licenses
  musicStart?: number;          // seconds into the track to start; default: where the beat is in full swing
  voiceover?: string;           // script to speak as one continuous take; the music dips under the voice
  voice?: string;               // ElevenLabs voice ID or name (zara, brielle, lyan); default: one from the rotation
  secondsPerSlide?: number;     // for slides without their own `seconds`; a 5-slide fit set uses SET_TIMING
  endCardSeconds?: number;      // default 3
  outPath: string;              // where to write the .mp4 (a cover .jpg is written beside it)
  brand?: Partial<Brand>;
};

export type ReelResult = { path: string; cover: string; duration: number; slides: number; voice?: string };

// ---------- helpers ----------
const ffmpegBin = () => {
  const bin = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string | null);
  if (!bin) throw new Error("ffmpeg not found. Install ffmpeg-static (npm install) or set FFMPEG_PATH.");
  return bin;
};

let fontCache: string | undefined;
async function defaultFont(): Promise<string> {
  if (fontCache) return fontCache;
  if (process.env.REEL_FONT) return (fontCache = process.env.REEL_FONT);
  const dir = path.dirname(createRequire(import.meta.url).resolve("@expo-google-fonts/anton/package.json"));
  const find = async (d: string, depth: number): Promise<string | undefined> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name === "Anton_400Regular.ttf") return p;
      if (e.isDirectory() && depth > 0 && e.name !== "node_modules") { const f = await find(p, depth - 1); if (f) return f; }
    }
  };
  const f = await find(dir, 2);
  if (!f) throw new Error("Anton font not found. Run npm install, or set REEL_FONT to a .ttf file.");
  return (fontCache = f);
}

function wrapWords(text: string, max: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of text.trim().split(/\s+/)) {
    if (cur && (cur + " " + w).length > max) { lines.push(cur); cur = w; }
    else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

// Google Drive links and "drive:<id>" become a direct download of the file itself.
// Works for files shared "anyone with the link"; private files need the Drive API.
export function driveDownloadUrl(src: string): string | undefined {
  const m = src.match(/^drive:([\w-]{20,})$/) || src.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#]*&)?id=)([\w-]{20,})/)
    || src.match(/drive\.usercontent\.google\.com\/download\?(?:[^#]*&)?id=([\w-]{20,})/);
  return m ? `https://drive.usercontent.google.com/download?id=${m[1]}&export=download&confirm=t` : undefined;
}

// Fetch a URL or copy a local file into the job folder; returns the file name inside it
async function fetchInto(dir: string, src: string, name: string, kind: "image" | "audio"): Promise<string> {
  const drive = driveDownloadUrl(src);
  if (drive || /^https?:\/\//i.test(src)) {
    const res = await fetch(drive || src);
    if (!res.ok) throw new Error(`Could not download ${src} (HTTP ${res.status}).`);
    const type = res.headers.get("content-type") || "";
    if (type.startsWith("text/"))
      throw new Error(drive ? `Google Drive returned a page instead of the file. Share it as "Anyone with the link" (viewer): ${src}` : `${src} returned a web page, not a ${kind} file.`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 50 * 1024 * 1024) throw new Error(`${src} is over 50 MB.`);
    const fromType = type.split("/")[1]?.split(";")[0].replace("jpeg", "jpg").replace("mpeg", "mp3");
    const ext = (!drive && path.extname(new URL(src).pathname).toLowerCase()) || (fromType ? "." + fromType : kind === "image" ? ".png" : ".mp3");
    await writeFile(path.join(dir, name + ext), buf);
    return name + ext;
  }
  await stat(src).catch(() => { throw new Error(`File not found: ${src}`); });
  const ext = path.extname(src).toLowerCase();
  await copyFile(src, path.join(dir, name + ext));
  return name + ext;
}

function runFfmpeg(args: string[], cwd: string, timeoutMs = 5 * 60_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // On small servers every decoder gets one thread (by default each starts one per core and buffers frames for them)
    const a = LOW_POWER ? args.flatMap((x, i) => (x === "-i" && args[i - 1] !== "-threads" ? ["-threads", "1", x] : [x])) : args;
    if (process.env.REEL_KEEP_TMP) appendFileSync(path.join(cwd, "cmds.jsonl"), JSON.stringify(a) + "\n");
    const p = spawn(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y", ...a], { cwd });
    let err = "";
    const out: Buffer[] = [];
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("ffmpeg timed out.")); }, timeoutMs);
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg failed (exit ${code}): ${err.trim()}`));
    });
  });
}

// Average color of the image's bottom strip, used to pad a fitted slide so the edge blends in
async function edgeColor(file: string, cwd: string): Promise<string> {
  const px = await runFfmpeg(["-i", file, "-vf", "crop=iw:ih*0.03:0:ih*0.97,scale=1:1:flags=area", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], cwd);
  return px.length >= 3 ? "0x" + [...px.subarray(0, 3)].map((b) => b.toString(16).padStart(2, "0")).join("") : "black";
}

// Integrated loudness (LUFS) of an audio file; undefined for silence
async function measureLufs(file: string, cwd: string): Promise<number | undefined> {
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn(ffmpegBin(), ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128", "-f", "null", "-"], { cwd });
    let err = "";
    p.stderr.on("data", (d) => { err = (err + d).slice(-6000); });
    p.on("error", reject);
    p.on("close", () => resolve(err));
  });
  const m = [...out.matchAll(/I:\s+(-?[\d.]+|-inf) LUFS/g)].pop();
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) && v > -70 ? v : undefined;
}

// Royalty-free tracks the business owns or licenses (default ./music)
export async function listTracks(dir = process.env.REEL_MUSIC_DIR || "music"): Promise<string[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  return files.filter((f) => /\.(mp3|m4a|aac|wav)$/i.test(f)).sort().map((f) => path.resolve(dir, f));
}

// `count` different tracks in random order
export async function pickTracks(count: number, dir?: string): Promise<string[]> {
  const all = await listTracks(dir);
  if (!all.length) throw new Error("No music found. Put .mp3 tracks in ./music or set REEL_MUSIC_DIR.");
  const shuffled = all.map((t) => [Math.random(), t] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  return Array.from({ length: count }, (_, i) => shuffled[i % shuffled.length]);
}

// Where the track gets going: first half-second within 5 dB of its loudest, so a reel never opens on a quiet intro
async function autoMusicStart(file: string, cwd: string, needSeconds: number): Promise<number> {
  await runFfmpeg(["-t", "75", "-i", file, "-af", "aresample=8000,asetnsamples=4000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=rms.txt", "-f", "null", "-"], cwd);
  const txt = await readFile(path.join(cwd, "rms.txt"), "utf8").catch(() => "");
  const levels = [...txt.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((m) => (m[1] === "-inf" ? -120 : Number(m[1])));
  if (!levels.length) return 0;
  const usable = levels.slice(0, Math.max(1, levels.length - Math.ceil(needSeconds * 2)));
  const peak = Math.max(...usable);
  const i = usable.findIndex((l) => l >= peak - 5);
  return Math.max(0, i * 0.5 - 0.25);
}

// Ken Burns move for slide i over F frames (zoompan expressions; `on` = output frame number)
function kenBurns(i: number, F: number): string {
  const p = `(on/${Math.max(F - 1, 1)})`;
  const cx = "x='iw/2-(iw/zoom/2)'", cy = "y='ih/2-(ih/zoom/2)'";
  switch (i % 4) {
    case 0: return `z='1+0.10*${p}':${cx}:${cy}`;                         // zoom in
    case 1: return `z='1.10-0.10*${p}':${cx}:${cy}`;                      // zoom out
    case 2: return `z='1.10':x='(iw-iw/zoom)*${p}':${cy}`;                 // pan right
    default: return `z='1.10':x='(iw-iw/zoom)*(1-${p})':${cy}`;            // pan left
  }
}

// ---------- builder ----------
export async function buildReel(o: ReelOptions): Promise<ReelResult> {
  if (o.slides.length < 1 || o.slides.length > 8) throw new Error("Give 1 to 8 slides.");
  const brand = { ...DEFAULT_BRAND, ...o.brand };
  const fit = o.fit || "fit";
  const motion = o.motion || (fit === "fit" ? "push" : "kenburns");
  const T = o.transition ?? (fit === "fit" ? 0.2 : 0.35);
  const n = o.slides.length;
  const hasEnd = !!o.endCard && !!(o.endCard.logo || o.endCard.shopUrl || o.endCard.code || o.endCard.cta);
  const E = hasEnd ? (o.endCardSeconds ?? 3) : 0;

  // Seconds each slide is on screen: its own, the designed-set timing, or an even split kept inside 7-20 s
  const useSet = fit === "fit" && n === SET_TIMING.length && !o.secondsPerSlide;
  const free = useSet ? 0 : o.slides.filter((s) => s.seconds === undefined).length;
  const fixed = o.slides.reduce((a, s, i) => a + (s.seconds ?? (useSet ? SET_TIMING[i] : 0)), 0);
  const even = free ? Math.min(Math.max(o.secondsPerSlide ?? 2.6, (7 - E - fixed) / free, 1.5), Math.max((20 - E - fixed) / free, 1.5)) : 0;
  const dur = o.slides.map((s, i) => s.seconds ?? (useSet ? SET_TIMING[i] : even));
  const total = Math.round((dur.reduce((a, b) => a + b, 0) + E) * 100) / 100;

  const outPath = path.resolve(o.outPath);
  const cover = outPath.replace(/\.mp4$/i, "") + ".jpg";
  await mkdir(path.dirname(outPath), { recursive: true });
  const dir = await mkdtemp(path.join(tmpdir(), "reel-"));
  try {
    // Everything lives in the job folder and is referenced by relative name, so the filter graph needs no path escaping
    await copyFile(brand.font || (await defaultFont()), path.join(dir, "font.ttf"));
    const slideFiles = await Promise.all(o.slides.map((sl, i) => fetchInto(dir, sl.src, `slide${i}`, "image")));
    const logoFile = o.endCard?.logo ? await fetchInto(dir, o.endCard.logo, "logo", "image") : undefined;
    const musicFile = o.music ? await fetchInto(dir, o.music, "music", "audio") : undefined;

    let tf = 0;
    const textFile = async (t: string) => { const f = `t${tf++}.txt`; await writeFile(path.join(dir, f), t); return f; };

    // Clean caption: white text with a soft shadow that rises and fades in (no boxes)
    const caption = async (text: string, c: { size: number; maxChars: number; yCenter: number; start: number; end?: number; color?: string }) => {
      const lines = wrapWords(text.toUpperCase(), c.maxChars);
      const longest = Math.max(...lines.map((l) => l.length));
      const size = Math.min(c.size, Math.floor((W - 140) / (longest * 0.48)));
      const lh = Math.round(size * 1.08);
      const top = Math.round(c.yCenter - (lines.length * lh) / 2);
      const fadeOut = c.end !== undefined ? `*min(1,max(0,(${c.end}-t)/0.2))` : "";
      const parts: string[] = [];
      for (const [k, line] of lines.entries()) {
        const d = c.start + k * 0.08; // lines arrive one after another
        const e = `min(1,max(0,(t-${d})/0.35))`;
        parts.push(`drawtext=fontfile=font.ttf:textfile=${await textFile(line)}:expansion=none:fontsize=${size}:fontcolor=${c.color || "white"}` +
          `:shadowcolor=black@0.55:shadowx=0:shadowy=${Math.round(size * 0.06)}:x=(w-text_w)/2` +
          `:y='${top + k * lh}+${Math.round(size * 0.5)}*(1-${e})*(1-${e})':alpha='${e}${fadeOut}'` +
          `:enable='between(t,${d},${c.end ?? 999})'`);
      }
      return parts.join(",");
    };

    // Each slide (and the end card) is rendered to its own short clip first, one at a time, so only one
    // slide's frames are ever in memory; the clips are then joined with dissolves in the final pass.
    const clipFiles: string[] = [];
    const renderClip = async (clipInputs: string[], filter: string, frames: number) => {
      const f = `clip${clipFiles.length}.mp4`;
      await runFfmpeg([...(LOW_POWER ? ["-filter_complex_threads", "1"] : []), ...clipInputs, "-filter_complex", filter, "-map", "[v]",
        "-frames:v", String(frames), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-g", "1", "-pix_fmt", "yuv420p", "-r", String(FPS),
        ...(LOW_POWER ? ["-threads", "2"] : []), f], dir);
      clipFiles.push(f);
    };

    for (let i = 0; i < n; i++) {
      const last = i === n - 1 && !hasEnd;
      const D = dur[i] + (last ? 0 : T), F = Math.round(D * FPS);
      const pre: string[] = [];
      let base: string;
      if (fit === "fit") {
        // Whole slide, never cropped: fit inside the frame (or the safe area) and pad with its own edge color
        const pad = await edgeColor(slideFiles[i], dir);
        const bh = o.safeArea ? H - SAFE_TOP - SAFE_BOTTOM : H, top = o.safeArea ? SAFE_TOP : 0;
        base = `[0:v]scale=${W}:${bh}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:${top}+(${bh}-ih)/2:color=${pad},setsar=1`;
        // Push-in reaches 3%: only the outer padding / edge pixels leave the frame
        base += motion === "none" ? `,zoompan=z='1':d=${F}:s=${W}x${H}:fps=${FPS}`
          : `,scale=${Math.round(W * SS)}:${Math.round(H * SS)}:flags=lanczos,zoompan=z='1+0.03*(on/${Math.max(F - 1, 1)})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${F}:s=${W}x${H}:fps=${FPS}`;
      } else {
        pre.push(
          `[0:v]format=rgb24,split[a][b]`,
          `[a]scale=540:960:force_original_aspect_ratio=increase,crop=540:960,boxblur=20:2,eq=brightness=-0.18,scale=${W * 2}:${H * 2}[bg]`,
          `[b]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=decrease[fg]`,
        );
        const z = motion === "none" ? "z='1'" : motion === "push" ? `z='1+0.03*(on/${Math.max(F - 1, 1)})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'` : kenBurns(i, F);
        base = `[bg][fg]overlay=(W-w)/2:(H-h)/2,zoompan=${z}:d=${F}:s=${W}x${H}:fps=${FPS},setsar=1`;
      }
      const texts: string[] = [];
      // Text sits above and below the photo (over the darkened backdrop), never on the product itself
      if (i === 0 && o.hook) texts.push(await caption(o.hook, { size: 150, maxChars: 12, yCenter: H * 0.15, start: 0.1 }));
      const t = o.slides[i].text;
      if (t) texts.push(await caption(t, { size: 92, maxChars: 16, yCenter: H * (o.safeArea ? 0.7 : 0.8), start: 0.25 }));
      await renderClip(["-i", slideFiles[i]], [...pre, `${base},format=yuv420p${texts.length ? "," + texts.join(",") : ""}[v]`].join(";"), F);
    }

    // Optional end card: logo, shop URL, discount code, CTA
    if (hasEnd) {
      const ec = o.endCard!;
      const parts: string[] = [];
      if (ec.shopUrl) parts.push(await caption(`Shop ${ec.shopUrl}`, { size: 88, maxChars: 20, yCenter: H * 0.53, start: 0.2 }));
      if (ec.code) parts.push(await caption(`Code ${ec.code}`, { size: 80, maxChars: 22, yCenter: H * 0.62, start: 0.45, color: "0x4D7CFF" }));
      if (ec.cta) parts.push(await caption(ec.cta, { size: 60, maxChars: 20, yCenter: H * 0.71, start: 0.7, color: brand.highlight }));
      const g = [`color=c=${brand.background}:s=${W}x${H}:r=${FPS}:d=${E},format=yuv420p[ecbg]`];
      let ecIn = "ecbg";
      if (logoFile) {
        g.push(`[0:v]scale=720:480:force_original_aspect_ratio=decrease,format=rgba[logo]`, `[ecbg][logo]overlay=(W-w)/2:${Math.round(H * 0.2)}:shortest=1[eclogo]`);
        ecIn = "eclogo";
      }
      g.push(`[${ecIn}]${parts.length ? parts.join(",") + "," : ""}setsar=1,fps=${FPS},format=yuv420p[v]`);
      await renderClip(logoFile ? ["-loop", "1", "-t", String(E), "-i", logoFile] : [], g.join(";"), Math.round(E * FPS));
    }

    // Join with short dissolves without holding every clip in memory: each dissolve is rendered as its own tiny
    // clip from the two neighbours, then all pieces are played end to end (clip0, fade, clip1, fade, ...).
    // Clips are all-intra, so the concat in/out points are frame-exact.
    const clips = clipFiles.length;
    const list: string[] = [];
    const durOf = (k: number) => (k < n ? dur[k] : E);
    for (let k = 0; k < clips; k++) {
      list.push(`file '${clipFiles[k]}'`);
      if (k > 0) list.push(`inpoint ${T.toFixed(3)}`);
      if (k < clips - 1) {
        list.push(`outpoint ${durOf(k).toFixed(3)}`);
        const f = `fade${k}.mp4`;
        await runFfmpeg(["-ss", durOf(k).toFixed(3), "-t", T.toFixed(3), "-i", clipFiles[k], "-t", T.toFixed(3), "-i", clipFiles[k + 1],
          "-filter_complex", `[0:v]settb=AVTB,setpts=PTS-STARTPTS[a];[1:v]settb=AVTB,setpts=PTS-STARTPTS[b];[a][b]xfade=transition=fade:duration=${T}:offset=0,format=yuv420p[v]`,
          "-map", "[v]", "-frames:v", String(Math.round(T * FPS)), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-g", "1", "-r", String(FPS), f], dir);
        list.push(`file '${f}'`);
      }
    }
    await writeFile(path.join(dir, "clips.txt"), list.join("\n") + "\n");

    // Audio is mixed in its own small steps. Loudness is measured (ebur128) and corrected with a fixed gain
    // instead of loudnorm, which needs ~120 MB per instance. Final mix lands around -14 LUFS (where Instagram
    // plays) and is limited so phones never clip.
    const STEREO = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
    const gainTo = async (file: string, target: number) => {
      const I = await measureLufs(file, dir);
      return I === undefined ? 0 : Math.max(-20, Math.min(20, target - I));
    };
    const vo = o.voiceover?.trim() || "";
    const voice = vo ? o.voice || pickVoice() : undefined;

    // Music bed: the track trimmed to length and faded; silence if no track
    if (musicFile) {
      const start = o.musicStart ?? (await autoMusicStart(musicFile, dir, total));
      await runFfmpeg(["-stream_loop", "-1", "-ss", start.toFixed(2), "-i", musicFile, "-af",
        `atrim=0:${total},asetpts=PTS-STARTPTS,afade=t=in:d=0.3,afade=t=out:st=${Math.max(total - 1.2, 0)}:d=1.2,${STEREO}`,
        "-c:a", "pcm_f32le", "mus.wav"], dir);
    } else {
      await runFfmpeg(["-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo`, "-t", String(total), "-c:a", "pcm_f32le", "mus.wav"], dir);
    }
    let mixFile = "mus.wav";

    // Voiceover: the whole script recorded as ONE continuous take, so it flows like a real voice actor's read.
    // It starts just after the reel opens and is sped up only if it would run past the end (at most 1.12x,
    // beyond that it starts sounding rushed). The music ducks under the voice.
    if (vo.length) {
      await speak(vo, path.join(dir, "raw.wav"), voice);
      const trim = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03";
      await runFfmpeg(["-i", "raw.wav", "-af", `${trim},areverse,${trim},areverse`, "-c:a", "pcm_s16le", "vo.wav"], dir);
      const secs = wavSeconds(await readFile(path.join(dir, "vo.wav")));
      const START = 0.3, room = total - START - 0.45;
      const tempo = secs > room ? secs / room : 1;
      if (tempo > 1.12) throw new Error(`The voiceover runs ${secs.toFixed(1)}s, too long for a ${total}s reel. Shorten the script.`);
      const ms = Math.round(START * 1000);
      await runFfmpeg(["-i", "vo.wav", "-af", `${STEREO}${tempo > 1.001 ? `,atempo=${tempo.toFixed(3)}` : ""},adelay=${ms}|${ms},apad,atrim=0:${total},highpass=f=90`,
        "-c:a", "pcm_f32le", "vop.wav"], dir);
      const gm = await gainTo("mus.wav", -20), gv = await gainTo("vop.wav", -15);
      await runFfmpeg(["-i", "mus.wav", "-i", "vop.wav", "-filter_complex",
        `[0:a]volume=${gm.toFixed(2)}dB[mus];[1:a]volume=${gv.toFixed(2)}dB,asplit[voa][vob];` +
        `[mus][voa]sidechaincompress=threshold=0.012:ratio=10:attack=15:release=450:makeup=1[duck];` +
        `[duck][vob]amix=inputs=2:normalize=0:duration=first,${STEREO}[a]`,
        "-map", "[a]", "-c:a", "pcm_f32le", "mix.wav"], dir);
      mixFile = "mix.wav";
    }
    const gf = musicFile || vo.length ? await gainTo(mixFile, -14) : 0;

    await runFfmpeg([
      ...(LOW_POWER ? ["-filter_complex_threads", "1"] : []),
      "-f", "concat", "-safe", "0", "-i", "clips.txt", "-i", mixFile,
      "-filter_complex", `[0:v]settb=AVTB,setsar=1,fps=${FPS},format=yuv420p[vout];[1:a]volume=${gf.toFixed(2)}dB,alimiter=limit=0.79:level=false,${STEREO}[aout]`,
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", LOW_POWER ? "veryfast" : "medium", "-crf", "18", "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p", "-r", String(FPS),
      ...(LOW_POWER ? ["-threads", "2", "-x264-params", "rc-lookahead=10"] : []),
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
      "-t", String(total), "-movflags", "+faststart", outPath,
    ], dir);

    // Cover = first slide (the hook / hero) for previews and the Instagram cover
    await runFfmpeg(["-ss", fit === "fit" ? "0.5" : "0.8", "-i", outPath, "-frames:v", "1", "-q:v", "2", cover], dir);
    return { path: outPath, cover, duration: total, slides: n, ...(voice ? { voice: voiceName(voice) } : {}) };
  } finally {
    if (process.env.REEL_KEEP_TMP) console.error(`kept ${dir}`);
    else await rm(dir, { recursive: true, force: true });
  }
}

// 2-3 variants for A/B testing: each pairs a different hook with a different track
export async function buildReelVariants(base: Omit<ReelOptions, "hook" | "music" | "outPath" | "voiceover">, hooks: (string | undefined)[], tracks: (string | undefined)[], outDir: string, name: string, max = 3, voiceovers: (string | undefined)[] = []) {
  const hs = hooks.length ? hooks : [undefined];
  const count = Math.min(max, Math.max(hs.length, tracks.length || 1, voiceovers.length));
  const results: (ReelResult & { variant: string; hook?: string; music?: string })[] = [];
  for (let i = 0; i < count; i++) {
    const variant = String.fromCharCode(65 + i);
    const hook = hs[i % hs.length], music = tracks.length ? tracks[i % tracks.length] : undefined;
    const voiceover = voiceovers.length ? voiceovers[i % voiceovers.length] : undefined;
    const file = count === 1 ? `${name}.mp4` : `${name}-${variant}.mp4`;
    const r = await buildReel({ ...base, hook, music, voiceover, outPath: path.join(outDir, file) });
    results.push({ ...r, variant, hook, music });
  }
  return results;
}

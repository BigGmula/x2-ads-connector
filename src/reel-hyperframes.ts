// HyperFrames look for designed reel slides: the same slides as the ffmpeg builder, with wipes, a real zoom into
// the print on the detail slide, camera moves and light sweeps. Picture only; buildReel still mixes the audio.
// HyperFrames drives Chrome frame by frame, so it needs Node 22+ and far more memory than the ffmpeg look.
import { spawn } from "node:child_process";
import { copyFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const W = 1080, H = 1920, FPS = 30;
const css = (c: string) => c.replace(/^0x/i, "#");
const n3 = (x: number) => Number(x.toFixed(3));

export type HfOptions = { slides: string[]; durations: number[]; transition: number; accent: string; highlight: string };

// Each slide stays on screen through the wipe that covers it, and the next one wipes in over the top
export function compositionHtml(o: HfOptions): string {
  const T = o.transition, n = o.slides.length;
  const starts = o.durations.map((_, i) => o.durations.slice(0, i).reduce((a, b) => a + b, 0));
  const total = o.durations.reduce((a, b) => a + b, 0);
  const detail = n >= 3 ? 2 : -1; // in a designed set, slide 3 is the close-up of the print
  const clips = o.slides.map((src, i) => {
    const start = Math.max(0, starts[i] - (i ? T : 0));
    const end = i === n - 1 ? total : starts[i + 1];
    return `<div id="s${i}" class="clip slide" style="z-index:${i + 1}" data-start="${n3(start)}" data-duration="${n3(end - start)}" data-track-index="${i}"><img id="i${i}" src="${src}" alt=""></div>`;
  }).join("\n");
  const tl: string[] = [];
  for (let i = 0; i < n; i++) {
    const s = starts[i], d = o.durations[i], img = `#i${i}`, e = i === n - 1 ? total : starts[i + 1];
    if (i) {
      const up = i % 2 === 1;
      tl.push(`tl.fromTo("#s${i}",{clipPath:"${up ? "inset(100% 0 0 0)" : "inset(0 0 100% 0)"}"},{clipPath:"inset(0% 0 0% 0)",duration:${T},ease:"power3.inOut"},${n3(s - T)});`);
      tl.push(`tl.fromTo("#bar",{y:${up ? H : -60},opacity:1},{y:${up ? -60 : H},duration:${T},ease:"power3.inOut",immediateRender:false},${n3(s - T)});tl.set("#bar",{opacity:0},${n3(s)});`);
    }
    const from = Math.max(0, s - (i ? T : 0));
    if (i === detail) {
      // Whole slide first so its headline reads, then push in on the print
      tl.push(`tl.fromTo("${img}",{scale:1},{scale:1.65,duration:${n3(Math.min(1.1, d * 0.5))},ease:"power2.inOut"},${n3(s + d * 0.3)});`);
    } else if (i === 0) {
      tl.push(`tl.fromTo("${img}",{scale:1.2},{scale:1,duration:0.7,ease:"power3.out"},0);tl.to("${img}",{scale:1.03,duration:${n3(e - 0.7)},ease:"none"},0.7);`);
    } else if (i === n - 1) {
      tl.push(`tl.fromTo("${img}",{scale:1.12},{scale:1,duration:0.8,ease:"back.out(1.6)"},${n3(from)});`);
    } else {
      // Slow drift, alternating in and out, so neighbours never move the same way
      const [a, b] = i % 2 ? [1.02, 1.09] : [1.09, 1.02];
      tl.push(`tl.fromTo("${img}",{scale:${a}},{scale:${b},duration:${n3(e - from)},ease:"none"},${n3(from)});`);
    }
    // A light sweep lands just after the slide settles
    tl.push(`tl.fromTo("#shine",{xPercent:-160,opacity:1},{xPercent:260,duration:0.7,ease:"power2.inOut",immediateRender:false},${n3(s + 0.35)});`);
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=${W}, height=${H}">
<script src="gsap.min.js"></script>
<style>
body{margin:0;background:#000}
#root{position:relative;width:${W}px;height:${H}px;overflow:hidden;background:#000}
.clip{position:absolute;inset:0;overflow:hidden}
.slide img{width:100%;height:100%;object-fit:cover;display:block;transform-origin:50% 50%}
#bar{position:absolute;left:0;top:0;width:100%;height:60px;z-index:50;opacity:0;background:${css(o.accent)};box-shadow:0 0 70px 20px ${css(o.highlight)}}
#shine{position:absolute;top:-10%;left:0;width:34%;height:120%;z-index:40;opacity:0;transform:skewX(-14deg);background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.28),rgba(255,255,255,0))}
</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${n3(total)}" data-width="${W}" data-height="${H}">
${clips}
<div id="bar" class="clip" style="inset:auto;left:0;top:0;right:0;height:60px" data-start="0" data-duration="${n3(total)}" data-track-index="20"></div>
<div id="shine" class="clip" style="inset:auto;top:-10%;left:0;width:34%;height:120%" data-start="0" data-duration="${n3(total)}" data-track-index="21"></div>
</div>
<script>
window.__timelines=window.__timelines||{};
const tl=gsap.timeline({paused:true});
${tl.join("\n")}
tl.set({}, {}, ${n3(total)});
window.__timelines.main=tl;
</script></body></html>`;
}

// Renders the silent picture into `out` (a file name inside `dir`, which already holds the slide files)
export async function renderHyperframes(dir: string, out: string, o: HfOptions, ffmpegBin: string, lowPower: boolean, timeoutMs = 15 * 60_000): Promise<void> {
  const require = createRequire(import.meta.url);
  await copyFile(require.resolve("gsap/dist/gsap.min.js"), path.join(dir, "gsap.min.js"));
  await writeFile(path.join(dir, "index.html"), compositionHtml(o));
  const bin = path.join(path.dirname(require.resolve("hyperframes/package.json")), "bin", "hyperframes.mjs");
  const args = [bin, "render", ".", "--output", out, "--fps", String(FPS), "--quiet", ...(lowPower ? ["--workers", "1", "--low-memory-mode"] : [])];
  await new Promise<void>((resolve, reject) => {
    const env = { ...process.env, PATH: `${path.dirname(ffmpegBin)}${path.delimiter}${process.env.PATH ?? ""}` };
    const p = spawn(process.execPath, args, { cwd: dir, env });
    let log = "";
    const keep = (d: Buffer) => { log = (log + d).slice(-4000); };
    p.stdout.on("data", keep); p.stderr.on("data", keep);
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("HyperFrames render timed out.")); }, timeoutMs);
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`HyperFrames render failed (exit ${code}): ${log.trim()}`)); });
  });
}

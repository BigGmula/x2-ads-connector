// Text-to-speech for reel voiceovers.
//  - elevenlabs: ElevenLabs (set ELEVENLABS_API_KEY; voices rotate, see VOICES), newest expressive model
//  - windows:    the built-in Windows voice, for testing timing and the mix locally (TTS_PROVIDER=windows)
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

// Hyper-natural female voices from the ElevenLabs library, picked for women's apparel ads (young women + moms).
// Reels rotate between them so the performance report shows which one sells; override with ELEVENLABS_VOICE_IDS.
export const VOICES: Record<string, string> = {
  zara: "jqcCZkN6Knx8BJ5TBdYR",    // warm, real-world conversationalist, 20s-30s
  brielle: "6u6JbqKdaQy89ENzLSju", // natural Gen Z, "un-clockable"
  lyan: "PStJ2DzQnh8zxG5PDf1s",    // genuine, casual DTC ad read
};
const DEFAULT_MODEL = "eleven_v4"; // newest, most human-sounding ElevenLabs model

// Voice IDs in rotation: ELEVENLABS_VOICE_IDS (comma-separated IDs or names above), else all of VOICES
export function voicePool(): string[] {
  const env = (process.env.ELEVENLABS_VOICE_IDS || process.env.ELEVENLABS_VOICE_ID || "").split(",").map((v) => v.trim()).filter(Boolean);
  return (env.length ? env : Object.keys(VOICES)).map((v) => VOICES[v.toLowerCase()] || v);
}
export const pickVoice = () => { const p = voicePool(); return p[Math.floor(Math.random() * p.length)]; };
export const voiceName = (id: string) => Object.keys(VOICES).find((k) => VOICES[k] === id) || id;
const RATE = 24000;

export function ttsProvider(): "elevenlabs" | "windows" | undefined {
  const p = (process.env.TTS_PROVIDER || (process.env.ELEVENLABS_API_KEY ? "elevenlabs" : "")).toLowerCase();
  return p === "elevenlabs" || p === "windows" ? p : undefined;
}

// Length of a PCM .wav in seconds (reads the fmt byte rate and the data chunk size)
export function wavSeconds(buf: Buffer): number {
  const byteRate = buf.readUInt32LE(28);
  for (let i = 12; i + 8 <= buf.length; ) {
    const id = buf.toString("ascii", i, i + 4), size = buf.readUInt32LE(i + 4);
    if (id === "data") return Math.min(size, buf.length - i - 8) / byteRate;
    i += 8 + size + (size % 2);
  }
  throw new Error("Not a PCM wav file.");
}

// Wrap raw 16-bit mono PCM in a .wav header
function wav(pcm: Buffer, rate = RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export type SpeakContext = { previous?: string; next?: string };

async function elevenlabs(text: string, outFile: string, voice?: string, ctx: SpeakContext = {}) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set. See SETUP.md (Voiceovers).");
  const id = VOICES[(voice || "").toLowerCase()] || voice || voicePool()[0];
  const model = process.env.ELEVENLABS_MODEL || DEFAULT_MODEL;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(id)}?output_format=pcm_${RATE}`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/pcm" },
    body: JSON.stringify({
      text,
      model_id: model,
      previous_text: ctx.previous || undefined,
      next_text: ctx.next || undefined,
      // v3+ models are expressive by design and take stability 0 (creative), 0.5 (natural) or 1 (robust)
      voice_settings: /eleven_v[3-9]/.test(model)
        ? { stability: Number(process.env.ELEVENLABS_STABILITY || 0.5) }
        : { stability: 0.4, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true },
    }),
  });
  if (!res.ok) {
    const j: any = await res.json().catch(() => ({}));
    const msg = j.detail?.message || j.detail?.status || (typeof j.detail === "string" ? j.detail : "") || res.statusText;
    throw new Error(`ElevenLabs failed (${res.status}): ${msg}${res.status === 404 || /voice/i.test(msg) ? " (add the voice to My Voices in ElevenLabs first)" : ""}`);
  }
  await writeFile(outFile, wav(Buffer.from(await res.arrayBuffer())));
}

function windows(text: string, outFile: string) {
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer;` +
    ` $s.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Female); $s.Rate = 1;` +
    ` $s.SetOutputToWaveFile($env:TTS_OUT); $s.Speak($env:TTS_TEXT); $s.Dispose()`;
  return new Promise<void>((resolve, reject) => {
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { env: { ...process.env, TTS_OUT: outFile, TTS_TEXT: text } });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Windows voice failed: ${err.trim()}`))));
  });
}

// Speak one line into a .wav; returns its length in seconds
export async function speak(text: string, outFile: string, voice?: string, ctx?: SpeakContext): Promise<number> {
  const p = ttsProvider();
  if (!p) throw new Error("No voice is set up. Set ELEVENLABS_API_KEY (see SETUP.md, Voiceovers) or TTS_PROVIDER=windows for local tests.");
  if (p === "elevenlabs") await elevenlabs(text, outFile, voice, ctx);
  else await windows(text, outFile);
  return wavSeconds(await readFile(outFile));
}

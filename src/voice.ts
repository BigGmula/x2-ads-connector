// Text-to-speech for reel voiceovers.
//  - google:  Google Cloud Text-to-Speech (set GOOGLE_TTS_API_KEY; voice via GOOGLE_TTS_VOICE)
//  - windows: the built-in Windows voice, for testing timing and the mix locally (TTS_PROVIDER=windows)
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const DEFAULT_VOICE = "en-US-Chirp3-HD-Aoede"; // warm, natural female voice

export function ttsProvider(): "google" | "windows" | undefined {
  const p = (process.env.TTS_PROVIDER || (process.env.GOOGLE_TTS_API_KEY ? "google" : "")).toLowerCase();
  return p === "google" || p === "windows" ? p : undefined;
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

async function google(text: string, outFile: string, voice?: string) {
  const key = process.env.GOOGLE_TTS_API_KEY;
  if (!key) throw new Error("GOOGLE_TTS_API_KEY is not set. See SETUP.md (Voiceovers).");
  const name = voice || process.env.GOOGLE_TTS_VOICE || DEFAULT_VOICE;
  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: name.split("-").slice(0, 2).join("-"), name },
      audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 24000, speakingRate: Number(process.env.GOOGLE_TTS_RATE || 1.05) },
    }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.audioContent) throw new Error(`Google text-to-speech failed (${res.status}): ${j.error?.message || res.statusText}`);
  await writeFile(outFile, Buffer.from(j.audioContent, "base64"));
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
export async function speak(text: string, outFile: string, voice?: string): Promise<number> {
  const p = ttsProvider();
  if (!p) throw new Error("No voice is set up. Set GOOGLE_TTS_API_KEY (see SETUP.md, Voiceovers) or TTS_PROVIDER=windows for local tests.");
  if (p === "google") await google(text, outFile, voice);
  else await windows(text, outFile);
  return wavSeconds(await readFile(outFile));
}

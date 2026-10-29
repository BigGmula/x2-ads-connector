// Voiceover scripts: fill the angles in reels/voiceover-scripts.json for one product
import { readFile } from "node:fs/promises";

export type Platform = "instagram" | "facebook";
type Angle = { id: string; why: string; lines: string[] };
type ScriptFile = { cta_facebook: string; cta_instagram: string; angles: Angle[] };

const FILE = process.env.VOICEOVER_SCRIPTS_FILE || "reels/voiceover-scripts.json";
const load = async (): Promise<ScriptFile> => JSON.parse(await readFile(FILE, "utf8"));

export async function angleIds(): Promise<string[]> {
  return (await load()).angles.map((a) => a.id);
}

const ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function words(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : "");
  return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? " " + words(n % 100) : ""}`;
}

// "From $54.99" -> "starting at fifty-four ninety-nine"; "$54.99" -> "just fifty-four ninety-nine"
export function spokenPrice(label: string): string {
  const m = label.match(/\$(\d+)(?:\.(\d{2}))?/);
  if (!m) return "";
  const dollars = Number(m[1]), cents = Number(m[2] || 0);
  const said = cents ? `${words(dollars)} ${cents < 10 ? "oh " + words(cents) : words(cents)}` : `${words(dollars)} dollars`;
  return (/^\s*from/i.test(label) ? "starting at " : "just ") + said;
}

export type ScriptProduct = { town: string; title: string; price_label: string };

// Lines for one angle ("random" picks one); returns the angle used and its lines
export async function fillScript(p: ScriptProduct, angle: string, platform: Platform = "instagram") {
  const f = await load();
  const a = angle === "random" ? f.angles[Math.floor(Math.random() * f.angles.length)] : f.angles.find((x) => x.id === angle);
  if (!a) throw new Error(`Unknown voiceover angle "${angle}". Use one of: ${f.angles.map((x) => x.id).join(", ")}, or random.`);
  const team = p.title.match(/^(.*?)\s+(?:Women's|Men's|Youth|Unisex)\b/)?.[1] || p.town;
  const style = /collegiate/i.test(p.title) ? "collegiate script " : /heritage/i.test(p.title) ? "heritage script " : "";
  const garment = /crop hoodie/i.test(p.title) ? "crop hoodie" : /hoodie/i.test(p.title) ? "hoodie" : /tee|t-shirt/i.test(p.title) ? "tee" : "piece";
  const price = spokenPrice(p.price_label);
  const vars: Record<string, string> = {
    town: p.town, team, product: style + garment,
    Price: price ? price[0].toUpperCase() + price.slice(1) : "Shop now",
    cta: platform === "facebook" ? f.cta_facebook : f.cta_instagram,
  };
  return { angle: a.id, lines: a.lines.map((l) => l.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "")) };
}

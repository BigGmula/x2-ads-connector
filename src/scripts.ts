// Voiceover scripts: fill the angles in reels/voiceover-scripts.json for one product
import { readFile } from "node:fs/promises";

export type Platform = "instagram" | "facebook";
type Angle = { id: string; why: string; text: string };
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

// Said the way people say prices: "$54.99" -> "And it's under fifty-five bucks!",
// "From $54.99" -> "And it starts under fifty-five bucks!", "$60" -> "And it's just sixty bucks!"
export function spokenPrice(label: string): string {
  const m = label.match(/\$(\d+)(?:\.(\d{2}))?/);
  if (!m) return "";
  const dollars = Number(m[1]), cents = Number(m[2] || 0);
  const amount = cents >= 90 ? `under ${words(dollars + 1)} bucks` : cents ? `${words(dollars)} ${words(cents)}` : `just ${words(dollars)} bucks`;
  return /^\s*from/i.test(label) ? `And it starts ${amount.replace(/^just /, "at ")}!` : `And it's ${amount}!`;
}

export type ScriptProduct = { town: string; title: string; price_label: string };

// One continuous script for an angle ("random" picks one)
export async function fillScript(p: ScriptProduct, angle: string, platform: Platform = "instagram") {
  const f = await load();
  const a = angle === "random" ? f.angles[Math.floor(Math.random() * f.angles.length)] : f.angles.find((x) => x.id === angle);
  if (!a) throw new Error(`Unknown voiceover angle "${angle}". Use one of: ${f.angles.map((x) => x.id).join(", ")}, or random.`);
  const team = p.title.match(/^(.*?)\s+(?:Women's|Men's|Youth|Unisex)\b/)?.[1] || p.town;
  const style = /collegiate/i.test(p.title) ? "collegiate script " : /heritage/i.test(p.title) ? "heritage script " : "";
  const garment = /crop hoodie/i.test(p.title) ? "crop hoodie" : /hoodie/i.test(p.title) ? "hoodie" : /tee|t-shirt/i.test(p.title) ? "tee" : "piece";
  const vars: Record<string, string> = {
    town: p.town, team, product: style + garment, price: spokenPrice(p.price_label),
    cta: platform === "facebook" ? f.cta_facebook : f.cta_instagram,
  };
  const text = a.text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "").replace(/\s+/g, " ").trim();
  return { angle: a.id, text };
}

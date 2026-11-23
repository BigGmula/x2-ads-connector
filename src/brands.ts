// Brands this connector posts for (reels/brands.json): which Page, which voice, which closing card
import { readFile } from "node:fs/promises";
import type { Brand as Colors, ReelOptions } from "./reel.js";

export type BrandProfile = {
  id: string; name: string; match: string[]; page_id: string; site?: string; voice?: string; voice_name?: string;
  end_card?: ReelOptions["endCard"]; end_slide?: string; colors?: Partial<Colors>;
};

const FILE = process.env.BRANDS_FILE || "reels/brands.json";
export const loadBrands = async (): Promise<BrandProfile[]> => JSON.parse(await readFile(FILE, "utf8")).brands;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

// "wallvice", "Wall Vice", "@wallviceart" or the brand's Page ID -> that brand
export function matchBrand(brands: BrandProfile[], value?: string): BrandProfile | undefined {
  const v = norm(value || "");
  if (!v) return undefined;
  const exact = brands.find((b) => b.page_id === v || norm(b.id) === v || norm(b.name) === v);
  // A bare number is a Page ID: never guess a brand from digits that happen to appear in it
  return exact || (/^\d+$/.test(v) ? undefined : brands.find((b) => b.match.some((m) => v.includes(norm(m)))));
}

// A schedule cell or tool argument -> Facebook Page ID: a brand's Page, or a bare Page ID as given
export function pageIdFor(brands: BrandProfile[], value?: string): string | undefined {
  const v = (value || "").trim();
  return matchBrand(brands, v)?.page_id || (/^\d{8,}$/.test(v) ? v : undefined);
}

// A voiceover cell that reads as a sentence is the script itself; a single word is a script angle (town-callout...)
export const customScript = (v?: string) => (v && /\s/.test(v.trim()) ? v.trim() : undefined);

// What a brand adds to a reel build: its voice, closing-card colors and closing card (or a finished end slide)
export function brandLook(b?: BrandProfile): Pick<ReelOptions, "voice" | "brand" | "endCard"> & { endSlide?: string } {
  if (!b) return {};
  return { voice: b.voice, brand: b.colors, endCard: b.end_slide ? undefined : b.end_card, endSlide: b.end_slide };
}

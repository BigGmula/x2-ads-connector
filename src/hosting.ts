// Public hosting for finished reels: files are served by this app at <PUBLIC_URL>/media/<random name>.
// Meta fetches video_url server-side, so it must be a direct, public file URL (not a web page).
// Note: Render's disk is wiped on redeploy, so scheduled reels should be rebuilt right before publishing.
import express from "express";
import { randomBytes } from "node:crypto";
import { mkdir, rename, copyFile, rm, readdir, stat } from "node:fs/promises";
import path from "node:path";

export const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || "media");
const RETENTION_DAYS = Number(process.env.MEDIA_RETENTION_DAYS || 14);

export function publicBase(): string {
  // Render sets RENDER_EXTERNAL_URL automatically; PUBLIC_URL overrides it (e.g. a custom domain)
  const base = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  if (!base) throw new Error("PUBLIC_URL is not set, so finished reels can't get a public link. Set it to this server's https address.");
  return base.replace(/\/+$/, "");
}

// Move a finished file into the media folder under an unguessable name; returns its public URL
export async function hostFile(localPath: string): Promise<string> {
  await mkdir(MEDIA_DIR, { recursive: true });
  const name = `${randomBytes(12).toString("hex")}${path.extname(localPath).toLowerCase()}`;
  const dest = path.join(MEDIA_DIR, name);
  await rename(localPath, dest).catch(async () => { await copyFile(localPath, dest); await rm(localPath, { force: true }); });
  return `${publicBase()}/media/${name}`;
}

// Delete hosted files older than MEDIA_RETENTION_DAYS
export async function cleanupMedia(): Promise<number> {
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  let removed = 0;
  for (const f of await readdir(MEDIA_DIR).catch(() => [] as string[])) {
    const p = path.join(MEDIA_DIR, f);
    if ((await stat(p)).mtimeMs < cutoff) { await rm(p, { force: true }); removed++; }
  }
  return removed;
}

export function mediaRoutes(app: express.Express) {
  app.use("/media", express.static(MEDIA_DIR, { fallthrough: false, index: false, dotfiles: "deny", maxAge: "7d", immutable: true }));
  cleanupMedia().catch(() => {});
  setInterval(() => cleanupMedia().catch(() => {}), 6 * 3_600_000).unref();
}

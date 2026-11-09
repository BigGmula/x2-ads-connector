// Facebook won't take a comment on a post that is still scheduled, so the link comment for a
// scheduled post is queued here and posted by a sweeper once the post goes live.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type PendingComment = {
  post_id: string; page_id: string; message: string;
  due: number;          // unix ms when the post is scheduled to go live
  attempts: number; last_error?: string;
};

export type CommentDeps = {
  pageToken: (pageId: string) => Promise<string>;
  isPublished: (postId: string, pageToken: string) => Promise<boolean>;
  comment: (postId: string, pageToken: string, message: string) => Promise<unknown>;
};

const file = () => path.resolve(process.env.PENDING_COMMENTS_FILE || "data/pending-comments.json");
const GIVE_UP_MS = 24 * 3_600_000;

async function load(): Promise<PendingComment[]> {
  try { return JSON.parse(await readFile(file(), "utf8")); } catch { return []; }
}
async function save(list: PendingComment[]) {
  await mkdir(path.dirname(file()), { recursive: true });
  await writeFile(file(), JSON.stringify(list, null, 1));
}

let lock: Promise<unknown> = Promise.resolve();
const locked = <T>(fn: () => Promise<T>): Promise<T> => { const p = lock.then(fn, fn); lock = p.catch(() => {}); return p; };

export const queueComment = (c: Omit<PendingComment, "attempts">) =>
  locked(async () => {
    const list = (await load()).filter((x) => x.post_id !== c.post_id);
    list.push({ ...c, attempts: 0 });
    await save(list);
  });

export const pendingComments = () => load();

// One pass: comment on every queued post that is now live; keep the rest for the next pass
export const sweepComments = (deps: CommentDeps, now = Date.now()) =>
  locked(async () => {
    const list = await load();
    const keep: PendingComment[] = [];
    const done: { post_id: string; result: string }[] = [];
    for (const c of list) {
      if (now < c.due) { keep.push(c); continue; }
      try {
        const token = await deps.pageToken(c.page_id);
        if (!(await deps.isPublished(c.post_id, token))) {
          if (now - c.due > GIVE_UP_MS) { done.push({ post_id: c.post_id, result: "gave up: post never went live" }); continue; }
          keep.push(c); continue;
        }
        await deps.comment(c.post_id, token, c.message);
        done.push({ post_id: c.post_id, result: "posted" });
      } catch (e) {
        c.attempts++; c.last_error = (e as Error).message;
        if (c.attempts >= 10 || now - c.due > GIVE_UP_MS) { done.push({ post_id: c.post_id, result: `failed: ${c.last_error}` }); console.error("First comment failed for", c.post_id, c.last_error); }
        else keep.push(c);
      }
    }
    if (done.length || keep.length !== list.length) await save(keep);
    for (const d of done) console.log(`First comment on ${d.post_id}: ${d.result}`);
    return done;
  });

export function startCommentSweeper(deps: CommentDeps) {
  const run = () => sweepComments(deps).catch((e) => console.error("Comment sweeper:", (e as Error).message));
  setTimeout(run, 20_000).unref();
  setInterval(run, 60_000).unref();
}

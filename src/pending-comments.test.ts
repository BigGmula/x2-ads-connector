import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { queueComment, sweepComments, pendingComments } from "./pending-comments.js";

test("queued link comment posts only once the scheduled post is live", async () => {
  process.env.PENDING_COMMENTS_FILE = path.join(await mkdtemp(path.join(tmpdir(), "pc-")), "p.json");
  let live = false; const posted: string[] = [];
  const deps = { pageToken: async () => "t", isPublished: async () => live, comment: async (id: string, _t: string, m: string) => { posted.push(`${id}:${m}`); } };
  const due = Date.now() + 60_000;
  await queueComment({ post_id: "1_2", page_id: "1", message: "Shop here: https://47swagco.com/x", due });
  await sweepComments(deps, due - 1000); assert.equal(posted.length, 0);       // not due yet
  await sweepComments(deps, due + 1000); assert.equal(posted.length, 0);       // due, Facebook hasn't published it yet
  live = true;
  await sweepComments(deps, due + 2000); assert.deepEqual(posted, ["1_2:Shop here: https://47swagco.com/x"]);
  await sweepComments(deps, due + 3000); assert.equal(posted.length, 1);       // never twice
  assert.equal((await pendingComments()).length, 0);
});

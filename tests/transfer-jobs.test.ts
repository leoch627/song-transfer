import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../lib/task-store";
import { TransferQueue } from "../lib/transfer-queue";
import { runTransferStep } from "../lib/transfer-worker";
import { mergeTaskSnapshot } from "../lib/task-sync";
import { AppError } from "../lib/http";
import type { Match, Playlist } from "../lib/types";

function fixture(count = 205) {
  const dir = mkdtempSync(join(tmpdir(), "songshift-write-"));
  let now = 1000;
  let store = new TaskStore(join(dir, "tasks.sqlite"), () => now);
  const matches: Match[] = Array.from({ length: count }, (_, i) => {
    const source = {
      id: String(i),
      name: `歌曲 ${i}`,
      artists: ["歌手"],
      album: "专辑",
      durationMs: 200000,
    };
    const id = String(i).padStart(22, "0");
    const candidate = {
      ...source,
      id,
      uri: `spotify:track:${id}`,
      url: `https://open.spotify.com/track/${id}`,
      score: 100,
      confident: true,
      durationDiff: 0,
    };
    return {
      source,
      candidates: [candidate],
      selected: candidate,
      status: "matched",
      included: true,
    };
  });
  const playlist: Playlist = {
    id: "fixture",
    name: "101",
    creator: "test",
    total: count,
    missing: 0,
    songs: matches.map((m) => m.source),
  };
  const id = store.create("alice", playlist, matches);
  const remote = {
    id: "P".repeat(22),
    description: "",
    owner: { id: "spotify-alice" },
    snapshot_id: "0",
    uris: [] as string[],
    created: false,
  };
  let creates = 0,
    posts = 0,
    lostCreate = false,
    lostAdd = false,
    commit = true,
    rateLimit = false,
    deny = false,
    nullItem = false,
    opaqueSnapshots = false;
  let token = "one",
    user = "spotify-alice";
  const batches: number[] = [];
  const deps = {
    token: async () => token,
    request: async <T>(
      _token: string,
      endpoint: string,
      init?: RequestInit,
    ): Promise<T> => {
      if (deny) throw new AppError("授权过期", 401);
      const metadata = () => ({
        ...remote,
        items: { total: remote.uris.length },
      });
      if (endpoint === "/me") return { id: user } as T;
      if (endpoint === "/me/playlists" && init?.method === "POST") {
        creates++;
        // The request must already be durable before Spotify sees it.
        assert.equal(new TransferQueue(store).summary(id)!.verifying, true);
        remote.created = commit;
        remote.description = JSON.parse(String(init.body)).description;
        if (lostCreate) {
          lostCreate = false;
          throw new Error("Response lost");
        }
        return {
          ...metadata(),
          ...(opaqueSnapshots ? { snapshot_id: "create-response" } : {}),
        } as T;
      }
      if (endpoint.startsWith("/me/playlists?"))
        return {
          items: remote.created ? [metadata()] : [],
          offset: 0,
          total: remote.created ? 1 : 0,
          next: null,
        } as T;
      if (endpoint.endsWith("/items") && init?.method === "POST") {
        posts++;
        assert.equal(new TransferQueue(store).summary(id)!.verifying, true);
        if (rateLimit) {
          rateLimit = false;
          throw new AppError("slow down", 429, 120);
        }
        const uris = JSON.parse(String(init.body)).uris as string[];
        batches.push(uris.length);
        if (commit) {
          remote.uris.push(...uris);
          remote.snapshot_id = String(Number(remote.snapshot_id) + 1);
        }
        if (lostAdd) {
          lostAdd = false;
          throw new Error("Response lost");
        }
        return {
          snapshot_id: opaqueSnapshots
            ? `write-${remote.snapshot_id}`
            : remote.snapshot_id,
        } as T;
      }
      if (endpoint.includes("/items?")) {
        const offset = Number(
          new URL(`https://fixture${endpoint}`).searchParams.get("offset"),
        );
        const items = remote.uris
          .slice(offset, offset + 50)
          .map((uri) => ({ item: nullItem ? null : { uri } }));
        return {
          items,
          offset,
          total: remote.uris.length,
          next: offset + 50 < remote.uris.length ? "next" : null,
        } as T;
      }
      if (endpoint.startsWith(`/playlists/${remote.id}?`))
        return metadata() as T;
      throw new Error(`Unexpected request ${endpoint}`);
    },
  };
  return {
    id,
    matches,
    remote,
    batches,
    get store() {
      return store;
    },
    get queue() {
      return new TransferQueue(store);
    },
    get creates() {
      return creates;
    },
    get posts() {
      return posts;
    },
    step: () => runTransferStep(store, deps),
    async drain() {
      for (let i = 0; i < 50 && (await runTransferStep(store, deps)); i++);
    },
    advance(ms = 120001) {
      now += ms;
    },
    reopen() {
      store.close();
      store = new TaskStore(join(dir, "tasks.sqlite"), () => now);
    },
    loseCreate(committed = true) {
      lostCreate = true;
      commit = committed;
    },
    loseAdd(committed = true) {
      lostAdd = true;
      commit = committed;
    },
    limit() {
      rateLimit = true;
    },
    deny(value = true) {
      deny = value;
    },
    switchAccount() {
      token = "two";
      user = "spotify-bob";
    },
    nullItem() {
      nullItem = true;
    },
    opaqueSnapshots() {
      opaqueSnapshots = true;
    },
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("background write freezes selection, is idempotent across devices, and resumes from saved batch after restart", async () => {
  const f = fixture();
  try {
    f.queue.enqueue(f.id, "alice");
    assert.throws(() => f.queue.enqueue(f.id, "bob"));
    assert.throws(() => f.queue.retry(f.id, "bob"));
    assert.throws(() => f.store.control(f.id, "alice", "delete"));
    f.store.save(
      f.id,
      "alice",
      [{ index: 0, match: { ...f.matches[0], included: false } }],
      { name: "changed", isPublic: true, result: null, writeStarted: false },
    );
    assert.equal(f.store.get(f.id, "alice").workspace.name, "101");
    assert.equal(f.store.get(f.id, "alice").matches[0].included, true);
    await f.step(); // account identity
    await f.step(); // create
    assert.ok(f.store.get(f.id, "alice").workspace.result?.url);
    await f.step(); // batch 1
    assert.equal(f.queue.summary(f.id)?.added, 100);
    f.reopen();
    f.queue.enqueue(f.id, "alice");
    await f.drain();
    assert.equal(f.creates, 1);
    assert.deepEqual(f.batches, [100, 100, 5]);
    assert.deepEqual(
      f.remote.uris,
      f.matches.map((m) => m.selected!.uri),
    );
    assert.equal(f.queue.summary(f.id)?.status, "complete");
    assert.equal(f.store.get(f.id, "alice").workspace.result?.complete, true);
  } finally {
    f.close();
  }
});

test("AI activity rejects submission without setting the write guard, and server truth clears a stale browser warning", () => {
  const f = fixture(1);
  try {
    f.store.db
      .prepare("INSERT INTO ai_jobs(task_id,status) VALUES(?,'waiting')")
      .run(f.id);
    assert.throws(() => f.queue.enqueue(f.id, "alice"), /AI/);
    assert.equal(f.queue.summary(f.id), null);
    const remote = f.store.get(f.id, "alice");
    assert.equal(remote.workspace.writeStarted, false);
    const local = {
      matches: f.matches,
      workspace: { ...remote.workspace, writeStarted: true },
    };
    assert.equal(
      mergeTaskSnapshot(remote, local, remote).workspace.writeStarted,
      false,
    );
    f.store.db.prepare("DELETE FROM ai_jobs WHERE task_id=?").run(f.id);
    f.store.beginTransfer(f.id, "alice"); // legacy uncertain write
    assert.throws(() => f.queue.enqueue(f.id, "alice"), /已经开始/);
  } finally {
    f.close();
  }
});

test("429 keeps acknowledged progress and honors persisted Retry-After before retrying the rejected batch", async () => {
  const f = fixture();
  try {
    f.queue.enqueue(f.id, "alice");
    await f.step();
    await f.step();
    await f.step();
    f.limit();
    await f.step();
    assert.equal(f.queue.summary(f.id)?.status, "waiting");
    assert.equal(f.queue.summary(f.id)?.added, 100);
    assert.equal(f.queue.summary(f.id)?.verifying, false);
    f.reopen();
    assert.equal(await f.step(), false);
    f.advance(119999);
    assert.equal(await f.step(), false);
    f.advance(1);
    await f.drain();
    assert.equal(f.creates, 1);
    assert.equal(f.remote.uris.length, 205);
    assert.deepEqual(f.batches, [100, 100, 5]);
  } finally {
    f.close();
  }
});

test("lost create response is recovered by its unique marker without a second creation", async () => {
  const f = fixture(2);
  try {
    f.queue.enqueue(f.id, "alice");
    await f.step();
    f.loseCreate();
    await f.step();
    f.reopen();
    f.advance();
    await f.drain();
    assert.equal(f.creates, 1);
    assert.equal(f.queue.summary(f.id)?.status, "complete");
    assert.equal(f.remote.uris.length, 2);
  } finally {
    f.close();
  }
});

test("uncertain create without a matching marker stays blocked even after explicit retry", async () => {
  const f = fixture(2);
  try {
    f.queue.enqueue(f.id, "alice");
    await f.step();
    f.loseCreate(false);
    await f.step();
    f.advance();
    await f.drain();
    assert.equal(f.queue.summary(f.id)?.status, "blocked");
    f.queue.retry(f.id, "alice");
    await f.drain();
    assert.equal(f.creates, 1);
    assert.equal(f.posts, 0);
  } finally {
    f.close();
  }
});

test("lost append response reconciles exact ordered tracks across pages then continues without duplicates", async () => {
  const f = fixture();
  try {
    f.queue.enqueue(f.id, "alice");
    await f.step();
    await f.step();
    f.loseAdd();
    await f.step();
    assert.equal(f.queue.summary(f.id)?.added, 0);
    f.reopen();
    f.advance();
    await f.drain();
    assert.equal(f.queue.summary(f.id)?.status, "complete");
    assert.deepEqual(f.batches, [100, 100, 5]);
    assert.deepEqual(
      f.remote.uris,
      f.matches.map((m) => m.selected!.uri),
    );
  } finally {
    f.close();
  }
});

for (const failure of [
  "not committed",
  "wrong order",
  "unavailable track",
] as const) {
  test(`ambiguous append ${failure} cannot be replayed blindly`, async () => {
    const f = fixture(2);
    try {
      f.queue.enqueue(f.id, "alice");
      await f.step();
      await f.step();
      f.loseAdd(failure !== "not committed");
      await f.step();
      if (failure === "wrong order") f.remote.uris.reverse();
      if (failure === "unavailable track") f.nullItem();
      f.advance();
      await f.drain();
      assert.equal(f.queue.summary(f.id)?.status, "blocked");
      f.queue.retry(f.id, "alice");
      await f.drain();
      assert.equal(f.posts, 1);
      assert.equal(f.queue.summary(f.id)?.added, 0);
    } finally {
      f.close();
    }
  });
}

test("worker crash after Spotify commit keeps a lease and recovers after lease expiry", async () => {
  const f = fixture(2);
  try {
    f.queue.enqueue(f.id, "alice");
    await f.step();
    await f.step();
    const claim = f.queue.claim()!;
    claim.state.pending = "append";
    f.queue.save(claim);
    f.remote.uris = f.matches.map((m) => m.selected!.uri);
    f.remote.snapshot_id = "1";
    f.reopen();
    assert.equal(f.queue.claim(), null);
    f.advance();
    await f.drain();
    assert.equal(f.posts, 0);
    assert.equal(f.queue.summary(f.id)?.status, "complete");
    assert.throws(() => f.queue.save(claim), /交接/);
  } finally {
    f.close();
  }
});

test("auth expiry can resume but changing Spotify account cannot write to another account", async () => {
  const f = fixture(2);
  try {
    f.queue.enqueue(f.id, "alice");
    await f.step();
    await f.step();
    f.deny();
    await f.step();
    assert.equal(f.queue.summary(f.id)?.status, "needs_auth");
    f.deny(false);
    f.queue.retry(f.id, "alice");
    await f.drain();
    assert.equal(f.queue.summary(f.id)?.status, "complete");
  } finally {
    f.close();
  }
  const g = fixture(2);
  try {
    g.queue.enqueue(g.id, "alice");
    await g.step();
    await g.step();
    g.switchAccount();
    await g.step();
    assert.equal(g.queue.summary(g.id)?.status, "needs_auth");
    assert.equal(g.posts, 0);
    assert.equal(g.creates, 1);
  } finally {
    g.close();
  }
});

test("search quota cooldown does not postpone playlist writes", async () => {
  const f = fixture(2);
  try {
    f.store.cooldown(81569, "QUOTA_EXCEEDED");
    f.queue.enqueue(f.id, "alice");
    assert.equal(f.queue.summary(f.id)?.status, "queued");
    await f.drain();
    assert.equal(f.queue.summary(f.id)?.status, "complete");
    assert.equal(f.creates, 1);
    assert.equal(f.remote.uris.length, 2);
    // Search stays blocked until Spotify's own Retry-After.
    assert.ok(f.store.quota().resumeAt > 0);
    assert.throws(() => f.store.reserveSearch());
  } finally {
    f.close();
  }
});

test("write 429 postpones only writes, not searches", async () => {
  const f = fixture();
  try {
    f.queue.enqueue(f.id, "alice");
    await f.step();
    await f.step();
    f.limit();
    await f.step();
    assert.equal(f.queue.summary(f.id)?.status, "waiting");
    assert.equal(f.queue.resumeAt(), 1000 + 120000);
    assert.equal(f.store.quota().resumeAt, 0);
    assert.doesNotThrow(() => f.store.reserveSearch());
    // Writes stay paused until the write Retry-After.
    f.advance(1000);
    assert.equal(await f.step(), false);
  } finally {
    f.close();
  }
});

test("upgrade releases writes held only by the old shared search cooldown", async () => {
  const f = fixture(2);
  try {
    f.queue.enqueue(f.id, "alice");
    f.store.cooldown(81569, "QUOTA_EXCEEDED");
    f.store.db
      .prepare(
        "UPDATE transfer_jobs SET status='waiting',resume_at=?,error=? WHERE task_id=?",
      )
      .run(f.store.quota().resumeAt, "Spotify 暂时限流，到时自动开始后台写入。", f.id);
    f.store.db
      .prepare("DELETE FROM task_migrations WHERE name='separate-write-cooldown'")
      .run();
    f.reopen();
    assert.equal(f.queue.summary(f.id)?.status, "queued");
    assert.equal(f.queue.summary(f.id)?.resumeAt, 0);
    await f.drain();
    assert.equal(f.queue.summary(f.id)?.status, "complete");
    // Runs once: a later write wait survives restarts.
    f.store.db
      .prepare("UPDATE transfer_jobs SET status='waiting',resume_at=?,error=? WHERE task_id=?")
      .run(999999999, "Spotify 暂时限流，进度已保存，到时自动继续。", f.id);
    f.reopen();
    assert.equal(f.queue.summary(f.id)?.status, "waiting");
  } finally {
    f.close();
  }
});

test("write responses with snapshot IDs that differ from GET still complete", async () => {
  const f = fixture();
  try {
    f.opaqueSnapshots();
    f.queue.enqueue(f.id, "alice");
    await f.drain();
    assert.equal(f.queue.summary(f.id)?.status, "complete");
    assert.deepEqual(f.batches, [100, 100, 5]);
    assert.equal(f.creates, 1);
  } finally {
    f.close();
  }
});

test("external edit between batches is still detected via GET snapshots", async () => {
  const f = fixture();
  try {
    f.opaqueSnapshots();
    f.queue.enqueue(f.id, "alice");
    await f.step(); // /me
    await f.step(); // create
    await f.step(); // check + append batch 1
    await f.step(); // check adopts live snapshot + append batch 2
    f.remote.uris.reverse(); // reorder keeps the count but changes the snapshot
    f.remote.snapshot_id = "edited";
    await f.step();
    assert.equal(f.queue.summary(f.id)?.status, "blocked");
    assert.deepEqual(f.batches, [100, 100]);
  } finally {
    f.close();
  }
});

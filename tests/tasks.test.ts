import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAY, TaskStore } from "../lib/task-store";
import { runTaskStep } from "../lib/task-worker";
import { searchTrack, spotifyRequest } from "../lib/spotify";
import { makeMatch, scoreCandidate } from "../lib/matching";
import { AppError } from "../lib/http";
import {
  loginAccount,
  newWebSession,
  rateLimitAccount,
  registerAccount,
  sessionUser,
  sessionHash,
} from "../lib/accounts";
import type { Playlist, Song } from "../lib/types";
import { mergeTaskSnapshot } from "../lib/task-sync";

const song: Song = {
  id: "1",
  name: "晴天",
  artists: ["周杰伦"],
  album: "叶惠美",
  durationMs: 269000,
};
const playlist: Playlist = {
  id: "1",
  name: "测试歌单",
  creator: "测试",
  total: 2,
  missing: 0,
  songs: [song, { ...song, id: "2", name: "夜曲" }],
};
const candidate = (source: Song) =>
  scoreCandidate(source, {
    ...source,
    id: "a".repeat(22),
    uri: `spotify:track:${"a".repeat(22)}`,
    url: `https://open.spotify.com/track/${"a".repeat(22)}`,
  });

test("polling accepts remote edits while preserving only unsaved local changes", () => {
  const match = makeMatch(song, [candidate(song)]);
  const workspace = {
    name: "base",
    isPublic: false,
    writeStarted: false,
    result: null,
  };
  const baseline = { matches: [match], workspace };
  const remote = {
    matches: [{ ...match, included: false }],
    workspace: { ...workspace, name: "another device" },
  };
  assert.equal(
    mergeTaskSnapshot(remote, baseline, baseline).matches[0].included,
    false,
  );
  assert.equal(
    mergeTaskSnapshot(remote, baseline, baseline).workspace.name,
    "another device",
  );
  const local = {
    matches: [match],
    workspace: { ...workspace, name: "unsaved name" },
  };
  assert.equal(
    mergeTaskSnapshot(remote, local, baseline).workspace.name,
    "unsaved name",
  );
  assert.equal(
    mergeTaskSnapshot(
      { ...remote, workspace: { ...workspace, writeStarted: true } },
      local,
      baseline,
    ).workspace.writeStarted,
    true,
  );
});

test("task transfer reserves once across devices and client saves cannot remove its guard", () => {
  const store = new TaskStore(":memory:");
  try {
    const match = makeMatch(song, [candidate(song)]);
    const id = store.create("alice", { ...playlist, songs: [song], total: 1 }, [
      match,
    ]);
    assert.equal(store.beginTransfer(id, "alice").uris.length, 1);
    assert.throws(() => store.beginTransfer(id, "alice"));
    store.save(id, "alice", [], {
      name: "changed",
      isPublic: false,
      writeStarted: false,
      result: null,
    });
    assert.equal(store.get(id, "alice").workspace.writeStarted, true);
    store.finishTransfer(id, "alice", null, true);
    assert.doesNotThrow(() => store.beginTransfer(id, "alice"));
    const result = {
      id: "a",
      url: "https://open.spotify.com/playlist/a",
      added: 1,
      total: 1,
      complete: true,
    };
    store.finishTransfer(id, "alice", result);
    assert.deepEqual(store.get(id, "alice").workspace.result, result);
  } finally {
    store.close();
  }
});

test("rolling 24h budget is shared across connections, persistent, and exact at its boundary", () => {
  const dir = mkdtempSync(join(tmpdir(), "songshift-quota-"));
  let now = 1000;
  const a = new TaskStore(join(dir, "tasks.sqlite"), () => now),
    b = new TaskStore(join(dir, "tasks.sqlite"), () => now);
  try {
    for (let i = 0; i < 400; i++) (i % 2 ? a : b).reserveSearch();
    assert.equal(b.quota().remaining, 0);
    assert.throws(
      () => b.reserveSearch(),
      (e: unknown) =>
        e instanceof AppError &&
        e.status === 429 &&
        e.reason === "LOCAL_BUDGET",
    );
    now += DAY - 1;
    assert.throws(() => a.reserveSearch());
    now++;
    b.reserveSearch();
    assert.equal(a.quota().used, 1);
    a.cooldown(120, "QUOTA_EXCEEDED");
    assert.throws(() => b.reserveSearch());
    now += 120000;
    assert.doesNotThrow(() => b.reserveSearch());
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker persists partial search and resumes from the next query after quota reset", async () => {
  let now = 1000,
    requests = 0;
  const store = new TaskStore(":memory:", () => now, 1),
    original = global.fetch;
  const queries: string[] = [];
  global.fetch = async (input) => {
    requests++;
    queries.push(new URL(String(input)).searchParams.get("q")!);
    return Response.json({
      tracks: {
        items:
          requests === 1
            ? []
            : [
                {
                  id: "a".repeat(22),
                  name: song.name,
                  uri: `spotify:track:${"a".repeat(22)}`,
                  duration_ms: song.durationMs,
                  artists: song.artists.map((name) => ({ name })),
                  album: { name: song.album },
                  external_urls: {
                    spotify: "https://open.spotify.com/track/" + "a".repeat(22),
                  },
                },
              ],
      },
    });
  };
  try {
    const id = store.create(
      "alice",
      { ...playlist, songs: [song], total: 1 },
      [],
    );
    const deps = { token: async () => "test", search: searchTrack };
    await runTaskStep(store, deps);
    assert.equal(store.get(id, "alice").status, "waiting");
    assert.equal(requests, 1);
    assert.equal(await runTaskStep(store, deps), false);
    now += DAY + 1;
    await runTaskStep(store, deps);
    assert.equal(requests, 2);
    assert.notEqual(queries[0], queries[1]);
    assert.equal(store.get(id, "alice").status, "complete");
    const second = store.create(
      "alice",
      { ...playlist, songs: [{ ...song, id: "duplicate" }], total: 1 },
      [],
    );
    await runTaskStep(store, deps);
    assert.equal(requests, 2);
    assert.equal(store.get(second, "alice").completed, 1);
    assert.equal(store.get(second, "alice").matches[0].source.id, "duplicate");
  } finally {
    global.fetch = original;
    store.close();
  }
});

test("Spotify distinguishes account quota from short rate limits and respects Retry-After", async () => {
  const original = global.fetch;
  try {
    global.fetch = async () =>
      Response.json({ error: { reason: "QUOTA_EXCEEDED" } }, { status: 429 });
    await assert.rejects(
      () => spotifyRequest("test", "/search"),
      (e: unknown) =>
        e instanceof AppError &&
        e.retryAfter === 86400 &&
        e.reason === "QUOTA_EXCEEDED",
    );
    global.fetch = async () =>
      Response.json(
        { error: { reason: "QUOTA_EXCEEDED" } },
        { status: 429, headers: { "Retry-After": "3600" } },
      );
    await assert.rejects(
      () => spotifyRequest("test", "/search"),
      (e: unknown) => e instanceof AppError && e.retryAfter === 3600,
    );
    global.fetch = async () => new Response("Not JSON", { status: 429 });
    await assert.rejects(
      () => spotifyRequest("test", "/search"),
      (e: unknown) =>
        e instanceof AppError &&
        e.retryAfter === 30 &&
        e.reason === "RATE_LIMITED",
    );
  } finally {
    global.fetch = original;
  }
});

test("tasks isolate owners, preserve in-flight pauses, and recover a crashed worker lease", async () => {
  const dir = mkdtempSync(join(tmpdir(), "songshift-task-"));
  let now = 1000;
  let store = new TaskStore(join(dir, "tasks.sqlite"), () => now);
  try {
    const id = store.create("alice", playlist, [], "fixed-task-id");
    assert.equal(store.create("alice", playlist, [], id), id);
    assert.throws(() => store.get(id, "bob"));
    assert.throws(() => store.control(id, "bob", "delete"));
    const claim = store.claim()!;
    assert.equal(store.claim(), null);
    store.close();
    store = new TaskStore(join(dir, "tasks.sqlite"), () => now);
    assert.equal(store.claim(), null);
    now += 120001;
    const recovered = store.claim()!;
    assert.notEqual(recovered.lease, claim.lease);
    store.control(id, "alice", "pause");
    assert.equal(store.runnable(recovered), false);
    store.completeSong(recovered, 0, makeMatch(song, [candidate(song)]));
    store.finish(recovered, "queued");
    assert.equal(store.get(id, "alice").status, "paused");
    assert.equal(store.get(id, "alice").completed, 1);
    store.control(id, "alice", "resume");
    await runTaskStep(store, {
      token: async () => "test",
      search: async (_token, source, opts) => {
        opts.beforeRequest?.();
        return makeMatch(source, [candidate(source)]);
      },
    });
    assert.equal(store.get(id, "alice").status, "complete");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("429 sets a shared pause, auth failure stops only its task, credentials remain encrypted", async () => {
  const store = new TaskStore(":memory:", () => 1000);
  const old = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "test-secret-".repeat(5);
  try {
    store.saveAccount("alice", {
      accessToken: "private-access",
      refreshToken: "private-refresh",
      expiresAt: 999999,
    });
    const raw = store.db.prepare("SELECT credentials FROM task_accounts").get()!
      .credentials as string;
    assert.ok(!raw.includes("private-access"));
    assert.equal(store.account("alice")!.refreshToken, "private-refresh");
    const id = store.create("alice", playlist, []);
    await runTaskStep(store, {
      token: async () => "test",
      search: async () => {
        throw new AppError("quota", 429, 600, "QUOTA_EXCEEDED");
      },
    });
    assert.equal(store.get(id, "alice").resumeAt, 601000);
    assert.throws(() => store.reserveSearch());
    store.disconnect("alice");
    assert.equal(store.account("alice"), null);
    assert.equal(store.get(id, "alice").status, "needs_auth");
  } finally {
    if (old === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = old;
    store.close();
  }
});

test("accounts hash passwords, reject wrong credentials, expire/revoke sessions and throttle attempts", async () => {
  let now = 1000;
  const store = new TaskStore(":memory:", () => now);
  try {
    const alice = await registerAccount("Alice", "example-password-123", store);
    assert.equal(alice.username, "alice");
    const row = store.db
      .prepare("SELECT password_hash FROM users WHERE id=?")
      .get(alice.id)!;
    assert.ok(!(row.password_hash as string).includes("example-password"));
    await assert.rejects(() =>
      registerAccount("ALICE", "example-password-456", store),
    );
    await assert.rejects(() => loginAccount("alice", "wrong-password", store));
    assert.deepEqual(
      await loginAccount("ALICE", "example-password-123", store),
      alice,
    );
    const token = newWebSession(alice, store);
    assert.equal(sessionUser(token, store)!.id, alice.id);
    assert.equal(sessionUser("bad-token", store), null);
    store.db
      .prepare("DELETE FROM web_sessions WHERE token_hash=?")
      .run(sessionHash(token));
    assert.equal(sessionUser(token, store), null);
    const expired = newWebSession(alice, store);
    now += 30 * DAY;
    assert.equal(sessionUser(expired, store), null);
    for (let i = 0; i < 3; i++) rateLimitAccount("test", 3, 1000, store);
    assert.throws(() => rateLimitAccount("test", 3, 1000, store));
    now += 1000;
    assert.doesNotThrow(() => rateLimitAccount("test", 3, 1000, store));
  } finally {
    store.close();
  }
});

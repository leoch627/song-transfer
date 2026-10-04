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

test("searches exceed 400 while Spotify cooldown is shared, persistent, and exact at its boundary", () => {
  const dir = mkdtempSync(join(tmpdir(), "songshift-quota-"));
  let now = 1000;
  const a = new TaskStore(join(dir, "tasks.sqlite"), () => now),
    b = new TaskStore(join(dir, "tasks.sqlite"), () => now);
  try {
    for (let i = 0; i < 450; i++) (i % 2 ? a : b).reserveSearch();
    assert.equal(b.quota().used, 450);
    assert.equal(b.quota().limit, null);
    assert.equal(b.quota().remaining, null);
    assert.equal(b.quota().resumeAt, 0);
    a.cooldown(120, "QUOTA_EXCEEDED");
    assert.throws(
      () => b.reserveSearch(),
      (e: unknown) =>
        e instanceof AppError &&
        e.status === 429 &&
        e.reason === "QUOTA_EXCEEDED" &&
        e.retryAfter === 120,
    );
    const reopened = new TaskStore(join(dir, "tasks.sqlite"), () => now);
    assert.throws(() => reopened.reserveSearch());
    reopened.close();
    now += 120000 - 1;
    assert.throws(() => a.reserveSearch());
    now++;
    b.reserveSearch();
    assert.equal(a.quota().used, 451);
    now += DAY;
    assert.doesNotThrow(() => b.reserveSearch());
    assert.equal(a.quota().used, 1);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker saves progress across a 429 and restart, retries only the unfinished query", async () => {
  const dir = mkdtempSync(join(tmpdir(), "songshift-resume-"));
  let now = 1000,
    requests = 0;
  let store = new TaskStore(join(dir, "tasks.sqlite"), () => now);
  const original = global.fetch;
  const queries: string[] = [];
  global.fetch = async (input) => {
    requests++;
    queries.push(new URL(String(input)).searchParams.get("q")!);
    if (requests === 2)
      return Response.json(
        { error: { reason: "QUOTA_EXCEEDED" } },
        { status: 429, headers: { "Retry-After": "120" } },
      );
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
    assert.equal(requests, 2);
    assert.equal(store.get(id, "alice").resumeAt, now + 120000);
    store.close();
    store = new TaskStore(join(dir, "tasks.sqlite"), () => now);
    assert.equal(await runTaskStep(store, deps), false);
    now += 119999;
    assert.equal(await runTaskStep(store, deps), false);
    now++;
    await runTaskStep(store, deps);
    assert.equal(requests, 3);
    assert.notEqual(queries[0], queries[1]);
    assert.equal(queries[1], queries[2]);
    assert.equal(store.get(id, "alice").status, "complete");
    assert.equal(store.get(id, "alice").resumeAt, 0);
    const second = store.create(
      "alice",
      { ...playlist, songs: [{ ...song, id: "duplicate" }], total: 1 },
      [],
    );
    await runTaskStep(store, deps);
    assert.equal(requests, 3);
    assert.equal(store.get(second, "alice").completed, 1);
    assert.equal(store.get(second, "alice").matches[0].source.id, "duplicate");
  } finally {
    global.fetch = original;
    store.close();
    rmSync(dir, { recursive: true, force: true });
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
        e.retryAfter === 60 &&
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
        e.retryAfter === 60 &&
        e.reason === "RATE_LIMITED",
    );
    for (const [header, seconds] of [
      ["0", 1],
      ["0.5", 1],
      ["-5", 60],
      ["invalid", 60],
      ["Infinity", 60],
    ] as const) {
      global.fetch = async () =>
        new Response("", { status: 429, headers: { "Retry-After": header } });
      await assert.rejects(
        () => spotifyRequest("test", "/search"),
        (e: unknown) => e instanceof AppError && e.retryAfter === seconds,
      );
    }
    const deadline = new Date(Date.now() + 120000).toUTCString();
    global.fetch = async () =>
      new Response("", { status: 429, headers: { "Retry-After": deadline } });
    await assert.rejects(
      () => spotifyRequest("test", "/search"),
      (e: unknown) =>
        e instanceof AppError && e.retryAfter! >= 119 && e.retryAfter! <= 120,
    );
  } finally {
    global.fetch = original;
  }
});

for (const spotifyCooldown of [false, true]) {
  test(`upgrade preserves songs, checkpoints, manual choices and pauses; Spotify cooldown=${spotifyCooldown}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "songshift-upgrade-"));
    const path = join(dir, "tasks.sqlite");
    let now = 1000;
    let store = new TaskStore(path, () => now);
    try {
      const match = { ...makeMatch(song, [candidate(song)]), included: false };
      const id = store.create("alice", playlist, [match]);
      const claim = store.claim()!;
      const checkpoint = { nextQuery: 1, candidates: [] };
      store.checkpoint(claim, 1, checkpoint);
      store.finish(claim, "waiting", now + DAY, "old budget wait");
      const paused = store.create("alice", playlist, []);
      store.control(paused, "alice", "pause");
      const before = store.get(id, "alice");
      const songs = store.db
        .prepare("SELECT * FROM task_songs ORDER BY task_id, position")
        .all();
      for (let i = 0; i < 400; i++) store.reserveSearch();
      if (spotifyCooldown) store.cooldown(120, "QUOTA_EXCEEDED");
      // The previous release has all these tables except the migration marker.
      store.db.exec("DROP TABLE task_migrations");
      store.close();
      store = new TaskStore(path, () => now);
      const after = store.get(id, "alice");
      assert.equal(after.status, spotifyCooldown ? "waiting" : "queued");
      assert.equal(after.resumeAt, spotifyCooldown ? now + 120000 : 0);
      assert.equal(after.completed, 1);
      assert.deepEqual(after.matches, before.matches);
      assert.deepEqual(after.workspace, before.workspace);
      assert.deepEqual(after.playlist, before.playlist);
      assert.deepEqual(
        store.db
          .prepare("SELECT * FROM task_songs ORDER BY task_id, position")
          .all(),
        songs,
      );
      assert.equal(store.get(paused, "alice").status, "paused");
      assert.equal(store.quota().used, 400);
      if (spotifyCooldown) {
        assert.equal(store.claim(), null);
        now += 120000;
      }
      assert.doesNotThrow(() => store.reserveSearch());
      const resumed = store.claim()!;
      assert.equal(resumed.id, id);
      assert.equal(store.nextSong(resumed)!.index, 1);
      assert.deepEqual(store.nextSong(resumed)!.checkpoint, checkpoint);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

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

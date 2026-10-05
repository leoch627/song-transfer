import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getQqPlaylist } from "../lib/qq";
import {
  detectPlaylistProvider,
  parseQqPlaylistId,
  providerNames,
} from "../lib/playlist-source";
import { validatePlaylist } from "../lib/task-validation";
import { TaskStore } from "../lib/task-store";
import { makeMatch, matchesToCsv } from "../lib/matching";

const id = "7799808010";
const track = (n: number) => ({
  id: n,
  mid: `mid${n}`,
  name: `歌曲${n}（Live）`,
  singer: [{ name: "歌手甲" }, { name: "歌手乙" }],
  album: { name: "专辑", mid: "003album" },
  interval: 243,
});
const page = (tracks: unknown[], total: number, hasmore?: number) => ({
  code: 0,
  playlist: {
    code: 0,
    data: {
      code: 0,
      dirinfo: {
        id: Number(id),
        title: "公開歌單",
        songnum: total,
        host_nick: "收藏者",
        picurl: "http://y.qq.com/cover.jpg",
      },
      total_song_num: total,
      songlist: tracks,
      hasmore,
    },
  },
});

test("QQ public playlist links support web/mobile sharing and reject other resources or hosts", () => {
  for (const input of [
    id,
    `https://y.qq.com/n/ryqq/playlist/${id}`,
    `https://y.qq.com/n/ryqq_v2/playlist/${id}`,
    `http://y.qq.com/n/yqq/playsquare/${id}.html`,
    `分享「喜欢」 https://y.qq.com/n2/m/share/details/taoge.html?id=${id}&appshare=1`,
    `https://i.y.qq.com/n/m/detail/taoge/index.html?disstid=${id}`,
    `https://y.qq.com/music/playlist.html?dissid=${id}`,
    `https://y.qq.com/#/playlist?id=${id}`,
  ])
    assert.equal(parseQqPlaylistId(input), id, input);
  for (const input of [
    "0",
    "9007199254740992",
    `https://y.qq.com/song/${id}`,
    `https://y.qq.com.evil.test/n/ryqq/playlist/${id}`,
    `https://evil.test/playlist/${id}`,
    `https://y.qq.com@evil.test/playlist/${id}`,
    `https://u:p@y.qq.com/playlist/${id}`,
    `https://y.qq.com:8000/playlist/${id}`,
    "https://y.qq.com/playlist/123junk",
    "https://y.qq.com/?id=123",
  ])
    assert.equal(parseQqPlaylistId(input), null, input);
  assert.equal(
    detectPlaylistProvider(`https://y.qq.com/n/ryqq/playlist/${id}`),
    "qq",
  );
  assert.equal(
    detectPlaylistProvider("https://c6.y.qq.com/base/fcgi-bin/u?__=abc"),
    "qq",
  );
  assert.equal(
    detectPlaylistProvider("https://music.163.com/playlist?id=123"),
    "netease",
  );
  assert.equal(detectPlaylistProvider(id), null);
});

test("QQ paginates beyond 100 songs and keeps order, artist names, versions and durations", async (t) => {
  const offsets: number[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://u.y.qq.com/cgi-bin/musicu.fcg");
    const body = JSON.parse(String(init.body));
    assert.equal(body.playlist.param.disstid, Number(id));
    assert.equal(body.playlist.param.song_num, 100);
    const offset = body.playlist.param.song_begin;
    offsets.push(offset);
    return Response.json(
      page(
        Array.from({ length: Math.min(100, 205 - offset) }, (_, i) =>
          track(offset + i + 1),
        ),
        205,
        offset < 200 ? 1 : 0,
      ),
    );
  });
  const result = await getQqPlaylist(id);
  assert.deepEqual(offsets, [0, 100, 200]);
  assert.equal(result.provider, "qq");
  assert.equal(result.creator, "收藏者");
  assert.equal(result.total, 205);
  assert.equal(result.missing, 0);
  assert.deepEqual(
    result.songs.map((s) => s.id),
    Array.from({ length: 205 }, (_, i) => `qq:${i + 1}`),
  );
  assert.deepEqual(result.songs[0].artists, ["歌手甲", "歌手乙"]);
  assert.equal(result.songs[0].durationMs, 243000);
  assert.equal(result.songs[0].name, "歌曲1（Live）");
  assert.equal(result.cover, "https://y.qq.com/cover.jpg");
  assert.equal(validatePlaylist(result).songs.length, 205);
});

test("QQ missing metadata and duplicate entries are reported and do not change paging offsets", async (t) => {
  const offsets: number[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: RequestInit) => {
      const offset = JSON.parse(String(init.body)).playlist.param.song_begin;
      offsets.push(offset);
      return Response.json(
        offset === 0
          ? page([track(2), { id: 9 }, track(1)], 5)
          : page([track(1), track(3)], 5),
      );
    },
  );
  const result = await getQqPlaylist(id);
  assert.deepEqual(offsets, [0, 3]);
  assert.deepEqual(
    result.songs.map((s) => s.id),
    ["qq:2", "qq:1", "qq:3"],
  );
  assert.equal(result.missing, 2);
  assert.equal(result.total, 5);
});

test("QQ empty or inaccessible songs preserve advertised missing counts", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(page([], 8, 0)));
  const result = await getQqPlaylist(id);
  assert.equal(result.total, 8);
  assert.equal(result.missing, 8);
  assert.deepEqual(result.songs, []);
});

test("QQ private, malformed, rate limited and failed subsequent pages are errors, not empty success", async (t) => {
  let reply = Response.json({ code: 0, playlist: { code: 1000 } });
  const mocked = t.mock.method(globalThis, "fetch", async () => reply);
  await assert.rejects(getQqPlaylist(id), { status: 422 });
  reply = Response.json({ code: 0, playlist: { code: 0, data: { code: 0 } } });
  await assert.rejects(getQqPlaylist(id), { status: 502 });
  reply = Response.json({}, { status: 429, headers: { "Retry-After": "30" } });
  await assert.rejects(getQqPlaylist(id), { status: 429, retryAfter: 30 });
  let calls = 0;
  mocked.mock.mockImplementation(async () =>
    ++calls === 1
      ? Response.json(page([track(1)], 2, 1))
      : new Response("unavailable", { status: 503 }),
  );
  await assert.rejects(getQqPlaylist(id), { status: 502 });
  assert.equal(calls, 2);
});

test("QQ caps playlist size and detects repeated pages instead of looping or silently dropping songs", async (t) => {
  const mocked = t.mock.method(globalThis, "fetch", async () =>
    Response.json(page([track(1)], 10001, 1)),
  );
  await assert.rejects(getQqPlaylist(id), { status: 422 });
  mocked.mock.mockImplementation(async () =>
    Response.json(page([track(1)], 5, 1)),
  );
  await assert.rejects(getQqPlaylist(id), /分页重复/);
  assert.equal(mocked.mock.callCount(), 3);
});

test("QQ short shares resolve manually but never fetch arbitrary redirect destinations", async (t) => {
  const urls: string[] = [];
  const mocked = t.mock.method(
    globalThis,
    "fetch",
    async (url: URL | string, init: RequestInit) => {
      urls.push(String(url));
      if (String(url).startsWith("https://c6.y.qq.com/")) {
        assert.equal(init.redirect, "manual");
        return new Response(null, {
          status: 302,
          headers: { Location: `https://y.qq.com/n/ryqq/playlist/${id}` },
        });
      }
      return Response.json(page([track(1)], 1, 0));
    },
  );
  const short = "http://c6.y.qq.com/base/fcgi-bin/u?__=abc";
  assert.equal((await getQqPlaylist(short)).songs.length, 1);
  assert.equal(urls.length, 2);
  for (const destination of [
    "http://127.0.0.1/",
    "https://evil.test/",
    "https://c6.y.qq.com/other",
    `https://user@y.qq.com/playlist/${id}`,
  ]) {
    mocked.mock.mockImplementation(
      async () =>
        new Response(null, { status: 302, headers: { Location: destination } }),
    );
    const before = mocked.mock.callCount();
    await assert.rejects(getQqPlaylist(short), { status: 400 });
    assert.equal(mocked.mock.callCount() - before, 1);
  }
});

test("QQ source and partial results survive database restart alongside unchanged legacy tasks", () => {
  const dir = mkdtempSync(join(tmpdir(), "songshift-qq-"));
  let store = new TaskStore(join(dir, "tasks.sqlite"));
  try {
    const song = {
      id: "qq:1",
      name: "晴天",
      artists: ["周杰伦"],
      album: "叶惠美",
      durationMs: 269000,
    };
    const base = {
      id,
      name: "喜欢",
      creator: "测试",
      total: 2,
      missing: 0,
      songs: [song, { ...song, id: "qq:2" }],
    };
    const match = makeMatch(song, []);
    const oldId = store.create("alice", base, [match]);
    const oldSnapshot = store.get(oldId, "alice");
    const qqId = store.create(
      "alice",
      validatePlaylist({ ...base, provider: "qq" }),
      [match],
    );
    store.close();
    store = new TaskStore(join(dir, "tasks.sqlite"));
    const saved = store.get(qqId, "alice");
    assert.equal(saved.playlist.provider, "qq");
    assert.equal(saved.matches[0].status, "missing");
    assert.equal(saved.matches[1].status, "pending");
    assert.deepEqual(store.get(oldId, "alice"), oldSnapshot);
    assert.equal(
      providerNames[oldSnapshot.playlist.provider || "netease"],
      "网易云音乐",
    );
    assert.ok(
      matchesToCsv(saved.matches, saved.playlist.provider).startsWith(
        "\uFEFFqq_name,qq_artist,",
      ),
    );
    assert.throws(() => validatePlaylist({ ...base, provider: "untrusted" }));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

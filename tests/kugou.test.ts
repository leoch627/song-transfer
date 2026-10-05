import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getKugouPlaylist } from "../lib/kugou";
import { detectPlaylistProvider, parseKugouPlaylistId } from "../lib/playlist-source";
import { validatePlaylist } from "../lib/task-validation";
import { TaskStore } from "../lib/task-store";
import { makeMatch, matchesToCsv } from "../lib/matching";

const id = "8944261", encoded = "gcid_3z9vj1r7z50z0af";
const gcid = "collection_3_520033052_175_0";
const html = `<script>var specialInfo = ${JSON.stringify({
  id: Number(id), name: '公開歌單 }; "', nickname: "收藏者", global_collection_id: gcid,
})}; var data = [{"songname":"only a preview"}];</script>`;
const track = (n: number) => ({
  hash: n.toString(16).padStart(32, "0").toUpperCase(), audio_id: n,
  name: `歌手甲、歌手乙 - 歌曲${n}（Live）`,
  singerinfo: [{ name: "歌手甲" }, { name: "歌手乙" }],
  albuminfo: { name: "專輯" }, timelen: 243000,
  trans_param: { union_cover: "http://imge.kugou.com/stdmusic/{size}/cover.jpg" },
});
const page = (tracks: unknown[], total: number, offset = 0) => ({
  status: 1, error_code: 0,
  data: { songs: tracks, count: total, begin_idx: offset,
    list_info: { name: "公開歌單", global_collection_id: gcid, is_pri: 0,
      pic: "http://imge.kugou.com/collection/{size}/cover.jpg", list_create_username: "收藏者" } },
});

test("Kugou accepts only playlist resources on official hosts", () => {
  for (const input of [id, `https://www.kugou.com/yy/special/single/${id}.html`,
    `https://m.kugou.com/plist/list/${id}/?json=true`,
    `分享歌单 https://www.kugou.com/yy/special/single/${id}.html`])
    assert.equal(parseKugouPlaylistId(input), id);
  for (const input of [encoded, `https://www.kugou.com/songlist/${encoded}/`,
    `http://m.kugou.com/songlist/${encoded}`])
    assert.equal(parseKugouPlaylistId(input), encoded);
  for (const input of ["0", "9007199254740992", "gcid_", "gcid_../x",
    `https://www.kugou.com.evil.test/songlist/${encoded}/`,
    `https://evil.test/yy/special/single/${id}.html`,
    `https://www.kugou.com@evil.test/songlist/${encoded}/`,
    `https://user:pass@www.kugou.com/songlist/${encoded}/`,
    `https://www.kugou.com:8000/songlist/${encoded}/`,
    `https://www.kugou.com/song/${id}.html`, `https://www.kugou.com/?id=${id}`])
    assert.equal(parseKugouPlaylistId(input), null, input);
  assert.equal(detectPlaylistProvider(`https://www.kugou.com/songlist/${encoded}/`), "kugou");
  assert.equal(detectPlaylistProvider(id), null);
});

test("Kugou reads beyond the HTML preview in order, retaining artists, versions and milliseconds", async (t) => {
  const offsets: number[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    assert.equal(init.redirect, "manual");
    if (url.hostname === "www.kugou.com") return new Response(html);
    assert.equal(url.hostname, "gateway.kugou.com");
    assert.equal(url.searchParams.get("global_collection_id"), gcid);
    assert.equal(url.searchParams.get("pagesize"), "100");
    const offset = Number(url.searchParams.get("begin_idx")); offsets.push(offset);
    return Response.json(page(Array.from({ length: Math.min(100, 283 - offset) }, (_, i) => track(offset + i + 1)), 283, offset));
  });
  const result = await getKugouPlaylist(encoded);
  assert.deepEqual(offsets, [0, 100, 200]);
  assert.equal(result.provider, "kugou");
  assert.equal(result.creator, "收藏者");
  assert.equal(result.total, 283);
  assert.equal(result.missing, 0);
  assert.deepEqual(result.songs.map((s) => s.id), Array.from({ length: 283 }, (_, i) => `kugou:${(i + 1).toString(16).padStart(32, "0")}`));
  assert.equal(result.songs[0].name, "歌曲1（Live）");
  assert.deepEqual(result.songs[0].artists, ["歌手甲", "歌手乙"]);
  assert.equal(result.songs[0].album, "專輯");
  assert.equal(result.songs[0].durationMs, 243000);
  assert.equal(result.songs[0].cover, "https://imge.kugou.com/stdmusic/300/cover.jpg");
  assert.equal(validatePlaylist(result).songs.length, 283);
});

test("Kugou counts unavailable and duplicate songs without breaking pagination, with duration fallback", async (t) => {
  const offsets: number[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    if (url.hostname === "www.kugou.com") return new Response(html);
    const offset = Number(url.searchParams.get("begin_idx")); offsets.push(offset);
    return Response.json(offset === 0
      ? page([track(2), { hash: track(9).hash }, track(1)], 6)
      : offset === 3 ? page([track(1), { audio_id: 3, songname: "原曲", singername: "原唱", duration: "213" }], 6, 3)
        : page([], 6, 5));
  });
  const result = await getKugouPlaylist(id);
  assert.deepEqual(offsets, [0, 3, 5]);
  assert.equal(result.total, 6);
  assert.equal(result.missing, 3);
  assert.equal(result.songs[0].name, "歌曲2（Live）");
  assert.equal(result.songs[2].id, "kugou:3");
  assert.equal(result.songs[2].durationMs, 213000);
  assert.deepEqual(result.songs[2].artists, ["原唱"]);
});

test("Kugou errors never masquerade as successful empty or truncated playlists", async (t) => {
  let reply: () => Response = () => Response.json({ status: 0, error_code: 20010 });
  const mock = t.mock.method(globalThis, "fetch", async (url: URL) =>
    url.hostname === "www.kugou.com" ? new Response(html) : reply());
  await assert.rejects(getKugouPlaylist(id), { status: 422 });
  reply = () => new Response("invalid json");
  await assert.rejects(getKugouPlaylist(id), { status: 502 });
  reply = () => Response.json({ status: 1, error_code: 0, data: {} });
  await assert.rejects(getKugouPlaylist(id), { status: 502 });
  reply = () => Response.json({ status: 1, error_code: 0, data: { count: "invalid", songs: [track(1)] } });
  await assert.rejects(getKugouPlaylist(id), { status: 502 });
  reply = () => new Response(null, { status: 429, headers: { "Retry-After": "30" } });
  await assert.rejects(getKugouPlaylist(id), { status: 429, retryAfter: 30 });
  let pages = 0;
  reply = () => ++pages === 1 ? Response.json(page([track(1)], 3)) : new Response(null, { status: 503 });
  await assert.rejects(getKugouPlaylist(id), { status: 502 });
  assert.equal(pages, 2);
  mock.mock.mockImplementation(async () => new Response("<script>throw 'do not execute me'</script>"));
  await assert.rejects(getKugouPlaylist(id), /公开歌单资料/);
});

test("Kugou rejects oversized playlists and repeated pages, but reports genuinely missing songs", async (t) => {
  let response = () => page([track(1)], 10001);
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    if (url.hostname === "www.kugou.com") return new Response(html);
    const result = response();
    result.data.begin_idx = Number(url.searchParams.get("begin_idx"));
    return Response.json(result);
  });
  await assert.rejects(getKugouPlaylist(id), { status: 422 });
  response = () => page([track(1)], 3);
  await assert.rejects(getKugouPlaylist(id), /分页重复/);
  response = () => page([], 8);
  const result = await getKugouPlaylist(id);
  assert.equal(result.total, 8);
  assert.equal(result.missing, 8);
  assert.deepEqual(result.songs, []);
});

test("Kugou follows only validated playlist redirects and rejects private or mismatched results", async (t) => {
  let location = `https://www.kugou.com/yy/special/single/${id}.html`;
  const mock = t.mock.method(globalThis, "fetch", async (url: URL) => {
    if (url.pathname.startsWith("/songlist/")) return new Response(null, { status: 302, headers: { Location: location } });
    if (url.hostname === "www.kugou.com") return new Response(html);
    return Response.json(page([track(1)], 1));
  });
  assert.equal((await getKugouPlaylist(encoded)).songs.length, 1);
  for (location of ["http://127.0.0.1/", "https://evil.test/", "https://user@www.kugou.com/songlist/gcid_a/"]) {
    const before = mock.mock.callCount();
    await assert.rejects(getKugouPlaylist(encoded), { status: 422 });
    assert.equal(mock.mock.callCount() - before, 1);
  }
  for (const detail of [{ is_pri: 1 }, { global_collection_id: "collection_3_999_1_0" }]) {
    mock.mock.mockImplementation(async (url: URL) => {
      if (url.hostname === "www.kugou.com") return new Response(html);
      const result = page([track(1)], 1); Object.assign(result.data.list_info, detail);
      return Response.json(result);
    });
    await assert.rejects(getKugouPlaylist(id), { status: 422 });
  }
});

test("Kugou source and progress persist across restarts alongside untouched QQ and legacy tasks", () => {
  const dir = mkdtempSync(join(tmpdir(), "songshift-kugou-"));
  let store = new TaskStore(join(dir, "tasks.sqlite"));
  try {
    const song = { id: "kugou:1", name: "晴天", artists: ["周杰伦"], album: "叶惠美", durationMs: 269000 };
    const base = { id, name: "喜欢", creator: "测试", total: 2, missing: 0, songs: [song, { ...song, id: "kugou:2" }] };
    const match = makeMatch(song, []);
    const legacyId = store.create("alice", base, [match]);
    const qqId = store.create("alice", { ...base, provider: "qq" }, [match]);
    const legacy = store.get(legacyId, "alice"), qq = store.get(qqId, "alice");
    const taskId = store.create("alice", validatePlaylist({ ...base, provider: "kugou" }), [match]);
    store.close(); store = new TaskStore(join(dir, "tasks.sqlite"));
    const saved = store.get(taskId, "alice");
    assert.equal(saved.playlist.provider, "kugou");
    assert.equal(saved.matches[0].status, "missing");
    assert.equal(saved.matches[1].status, "pending");
    assert.deepEqual(store.get(legacyId, "alice"), legacy);
    assert.deepEqual(store.get(qqId, "alice"), qq);
    assert.ok(matchesToCsv(saved.matches, saved.playlist.provider).startsWith("\uFEFFkugou_name,kugou_artist,"));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseSearch, searchAndReviewSong } from "../lib/ai-search-agent";
import { TaskStore } from "../lib/task-store";
import { AiTaskQueue } from "../lib/ai-task-queue";
import { makeMatch, scoreCandidate } from "../lib/matching";
import { AppError } from "../lib/http";
import type { AiSearchCheckpoint, AiReview, ArtistResearch, Candidate, Song } from "../lib/types";

const source: Song = { id: "source", name: "后来", artists: ["刘若英"], album: "我等你", durationMs: 240000 };
const track = (i: number, artists = source.artists) => scoreCandidate(source, {
  ...source, id: String(i).padStart(22, "0"), artists,
  uri: `spotify:track:${String(i).padStart(22, "0")}`, url: `https://open.spotify.com/track/${String(i).padStart(22, "0")}`,
});
const evidence: ArtistResearch = { summary: "官方页面证实别名", originalArtist: "刘若英", queries: [{ title: "後來", artist: "Rene Liu" }], sources: [{ url: "https://label.example/song", title: "发行资料" }], searchedAt: 1000 };
const advice = (c?: Candidate): AiReview => ({ decision: c ? "match" : "skip", candidateId: c?.id || null, confidence: "high", reason: "已核对实际搜索候选", matchKind: c ? "same_recording" : "no_match", model: "test" });
const fresh = (): AiSearchCheckpoint => ({ version: 1, candidates: [], searches: [], rounds: 0 });

test("AI function tools support both APIs, expose only metadata, and reject invented operations or invalid arguments", async (t) => {
  const previous = { ...process.env };
  process.env.AI_BASE_URL = "https://relay.example/v1"; process.env.AI_API_KEY = "relay-secret";
  let style = "chat_completions", name = "search_spotify", args = JSON.stringify({ query: 'track:"後來" artist:"Rene Liu"', reason: "尝试已核实艺名" });
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.parallel_tool_calls, false);
    assert.equal(body.tool_choice, "required");
    assert.equal(body.store, false);
    assert.ok(!JSON.stringify(body).includes("relay-secret"));
    return Response.json(style === "responses" ? { status: "completed", output: [{ type: "function_call", name, arguments: args }] }
      : { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ type: "function", function: { name, arguments: args } }] } }] });
  });
  try {
    for (style of ["chat_completions", "responses"]) {
      process.env.AI_API_STYLE = style;
      args = JSON.stringify({ query: 'track:"後來" artist:"Rene Liu"', reason: "尝试已核实艺名" });
      assert.equal((await chooseSearch(source, fresh()))?.query, 'track:"後來" artist:"Rene Liu"');
      name = "delete_playlist";
      await assert.rejects(chooseSearch(source, fresh()), /有效的 Spotify 搜索操作/);
      name = "finish_search";
      await assert.rejects(chooseSearch(source, fresh()));
      name = "search_spotify"; args = JSON.stringify({ query: "\n", reason: "bad" });
      await assert.rejects(chooseSearch(source, fresh()), /搜索参数无效/);
      args = JSON.stringify({ query: "后来", reason: "检索" });
    }
  } finally {
    for (const key of ["AI_BASE_URL", "AI_API_KEY", "AI_API_STYLE"]) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});

test("AI adapts queries to actual results, reviews the complete pool and retains a chosen result beyond the first five", async () => {
  const store = new TaskStore(":memory:");
  const wrong = Array.from({ length: 10 }, (_, i) => track(i + 1, [`同名翻唱${i}`]));
  const right = track(20);
  let searched = 0, checkpoint: AiSearchCheckpoint | undefined;
  try {
    const result = await searchAndReviewSong(source, [], { store, token: "spotify-secret", onProgress: (s) => { checkpoint = s; } }, {
      choose: async (_s, state) => {
        assert.ok(!JSON.stringify(state).includes("spotify-secret"));
        if (!state.searches.length) return { query: "后来", reason: "先搜歌名" };
        if (state.searches.length === 1) { assert.equal(state.candidates.length, 10); return { query: "后来 刘若英", reason: "首轮全是其他歌手，加入原歌手" }; }
        assert.equal(state.candidates.length, 11); return null;
      },
      search: async (_t, _s, q) => { searched++; return q === "后来" ? wrong : [right]; },
      research: async () => evidence,
      review: async (_s, candidates) => { assert.equal(candidates.length, 11); return advice(right); },
    });
    assert.equal(searched, 2); assert.equal(result.candidateId, right.id);
    assert.equal(result.candidates?.[0].id, right.id);
    assert.equal(result.excludedCandidates?.length, 6);
    assert.equal(result.spotifySearches?.length, 2);
    assert.equal(checkpoint?.finished, true);
  } finally { store.close(); }
});

test("Spotify 429 checkpoints survive restart and retry only the interrupted query without setting AI cooldown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "songshift-agent-"));
  let now = 1000, store = new TaskStore(join(dir, "tasks.sqlite"), () => now);
  const queries: string[] = [];
  let limited = true;
  const deps = {
    choose: async (_s: Song, state: AiSearchCheckpoint) => state.searches.length >= 2 ? null : { query: state.searches.length ? "后来 刘若英" : "后来", reason: "查找原曲" },
    search: async (_t: string, _s: Song, query: string) => { queries.push(query); if (query.includes("刘") && limited) throw new AppError("限流", 429, 10, "RATE_LIMITED"); return [track(queries.length)]; },
    research: async () => evidence,
    review: async (_s: Song, c: Candidate[]) => advice(c[0]),
  };
  try {
    const id = store.create("alice", { id: "p", name: "歌单", creator: "", total: 1, missing: 0, songs: [source] }, [makeMatch(source, [])]);
    let queue = new AiTaskQueue(store); queue.start(id, "alice"); let claim = queue.claim(3)!;
    await assert.rejects(async () => { try {
      await searchAndReviewSong(source, [], { store, token: "token", onProgress: (s) => queue.checkpoint(claim, s) }, deps);
    } catch (error) { queue.fail(claim, error); throw error; } }, { reason: "SPOTIFY_SEARCH_RATE_LIMITED" });
    assert.equal(queue.summary(id)?.status, "waiting");
    assert.equal(queue.summary(id)?.searching[0].completed, 1);
    assert.equal(store.db.prepare("SELECT * FROM ai_cooldown").all().length, 0);
    assert.equal(store.get(id, "alice").matches[0].aiReview, undefined);
    assert.equal(queue.claim(3), null);
    store.close(); now += 10001; limited = false;
    store = new TaskStore(join(dir, "tasks.sqlite"), () => now); queue = new AiTaskQueue(store); claim = queue.claim(3)!;
    assert.equal(claim.checkpoint?.pending?.query, "后来 刘若英");
    const result = await searchAndReviewSong(source, [], { store, token: "token", checkpoint: claim.checkpoint, onProgress: (s) => queue.checkpoint(claim, s) }, deps);
    queue.complete(claim, result);
    assert.deepEqual(queries, ["后来", "后来 刘若英", "后来 刘若英"]);
    assert.equal(queue.summary(id)?.status, "complete");
    assert.equal(store.get(id, "alice").matches[0].aiReview?.spotifySearches?.length, 2);
    assert.throws(() => queue.checkpoint(claim, fresh()), /接管/);
    queue.start(id, "alice", [0]);
    assert.equal(queue.claim(3)?.checkpoint, undefined);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("AI search cannot invent aliases or original singers when web evidence is absent, but still searches", async () => {
  const old = process.env.AI_WEB_SEARCH; process.env.AI_WEB_SEARCH = "1";
  const store = new TaskStore(":memory:"); let count = 0;
  try {
    const result = await searchAndReviewSong(source, [], { store, token: "token" }, {
      choose: async (_s, c) => c.searches.length ? null : { query: "后来", reason: "找原曲" },
      search: async () => { count++; return [track(1, ["Cover Singer"])]; },
      research: async () => { throw new AppError("缺少来源", 502, undefined, "AI_RESEARCH_NO_SOURCES"); },
      review: async () => advice(track(1, ["Cover Singer"])),
    });
    assert.equal(count, 1); assert.equal(result.decision, "uncertain"); assert.equal(result.candidateId, null);
    assert.match(result.searchWarning || "", /可核验来源/);
  } finally { store.close(); if (old === undefined) delete process.env.AI_WEB_SEARCH; else process.env.AI_WEB_SEARCH = old; }
});

test("queries are deduplicated and unique searches have a bounded budget", async () => {
  const store = new TaskStore(":memory:");
  try {
    let searches = 0;
    const deps = { choose: async () => ({ query: " 后来 ", reason: "检索" }), search: async () => { searches++; return []; }, research: async () => evidence, review: async () => advice() };
    await searchAndReviewSong(source, [], { store, token: "t" }, deps);
    assert.equal(searches, 1);
    searches = 0;
    const result = await searchAndReviewSong(source, [], { store, token: "t" }, { ...deps, choose: async (_s, c) => ({ query: `后来 ${c.rounds}`, reason: "不同搜索" }) });
    assert.equal(searches, 6); assert.equal(result.spotifySearches?.length, 6);
  } finally { store.close(); }
});

test("forced web research searches the clean original title and verified aliases before accepting an old exclusion", async () => {
  const old = process.env.AI_WEB_SEARCH; process.env.AI_WEB_SEARCH = "1";
  const store = new TaskStore(":memory:");
  const song = { ...source, name: "Go Again (feat. ELYSA)", artists: ["King CAAN", "ELYSA"], album: "Go Again", durationMs: 179160 };
  const correct = scoreCandidate(song, { ...song, name: "Go Again", id: "g".repeat(22), uri: `spotify:track:${"g".repeat(22)}`, url: `https://open.spotify.com/track/${"g".repeat(22)}` });
  const queries: string[] = [];
  let researchCount = 0, checkpoint: AiSearchCheckpoint | undefined;
  const deps = {
    research: async () => { researchCount++; return { ...evidence, queries: [{ title: "Go Again", artist: "King CAAN" }, { title: "Go Again", artist: "ELYSA" }] }; },
    choose: async () => null,
    search: async (_t: string, _s: Song, q: string) => { queries.push(q); if (q.includes('artist:"ELYSA"') && queries.length === 2) throw new AppError("限流", 429, 1); return [correct]; },
    review: async (_s: Song, candidates: Candidate[]) => { assert.ok(candidates.some(c=>c.id===correct.id)); return advice(correct); },
  };
  try {
    await assert.rejects(searchAndReviewSong(song, [], { store, token: "t", forceSearch: true, onProgress: s=>{checkpoint=s;} }, deps), { status: 429 });
    assert.equal(checkpoint?.pending?.query, 'track:"Go Again" artist:"ELYSA"');
    store.db.exec("DELETE FROM search_cooldown");
    const review = await searchAndReviewSong(song, [], { store, token: "t", forceSearch: true, checkpoint }, deps);
    assert.equal(researchCount, 1);
    assert.deepEqual(queries, ['track:"Go Again" artist:"King CAAN"', 'track:"Go Again" artist:"ELYSA"', 'track:"Go Again" artist:"ELYSA"']);
    assert.equal(review.candidateId, correct.id);
    assert.equal(review.spotifySearches?.length, 2);
  } finally { store.close(); if (old === undefined) delete process.env.AI_WEB_SEARCH; else process.env.AI_WEB_SEARCH = old; }
});

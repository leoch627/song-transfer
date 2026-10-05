import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyAiReview,
  makeMatch,
  matchesToCsv,
  needsAiReview,
  parsePlaylistId,
  scoreCandidate,
} from "../lib/matching";
import { seal, unseal } from "../lib/crypto";
import { validateReview, reviewWithAi } from "../lib/ai";
import { transferPlaylist, searchTrack } from "../lib/spotify";
import { getPlaylist } from "../lib/netease";
import type { Song } from "../lib/types";

const source: Song = {
  id: "123",
  name: "晴天",
  artists: ["周杰伦"],
  album: "叶惠美",
  durationMs: 269000,
};
const candidate = {
  ...source,
  id: "0".repeat(22),
  uri: `spotify:track:${"0".repeat(22)}`,
  url: `https://open.spotify.com/track/${"0".repeat(22)}`,
};

test("playlist links are restricted to NetEase and playlist routes", () => {
  for (const input of [
    "13586645289",
    "https://music.163.com/#/playlist?id=13586645289",
    "分享歌单 https://y.music.163.com/m/playlist?id=13586645289&userid=1",
    "https://music.163.com/playlist/13586645289",
  ])
    assert.equal(parsePlaylistId(input), "13586645289");
  for (const input of [
    "0",
    "https://evil.test/playlist?id=1",
    "https://music.163.com.evil.test/playlist?id=1",
    "https://music.163.com/song?id=1",
    "https://163cn.tv/abc",
    "garbage123",
  ])
    assert.equal(parsePlaylistId(input), null);
});
test("different artists and durations need review, while incompatible live versions are excluded", () => {
  assert.equal(
    makeMatch(source, [scoreCandidate(source, candidate)]).included,
    true,
  );
  for (const replacement of [
    { artists: ["其他歌手"] },
    { name: "晴天 (Live)" },
    { name: "晴天（现场版）" },
    { durationMs: 299000 },
  ]) {
    const result = makeMatch(source, [
      scoreCandidate(source, { ...candidate, ...replacement }),
    ]);
    assert.equal(result.status, replacement.name ? "missing" : "review");
    assert.equal(result.included, false);
  }
  assert.equal(makeMatch(source, []).status, "missing");
});
test("AI cannot choose fabricated or incompatible candidates and preserves manual choices", () => {
  const track = scoreCandidate(source, { ...candidate, name: "晴天 (Live)" });
  const match = makeMatch(source, [track]);
  assert.equal(needsAiReview(match), true);
  const good = {
    decision: "match",
    candidateId: track.id,
    confidence: "high",
    reason: "根据提供的元数据判断。",
  };
  const advice = validateReview(good, [track], "gpt-5.6-luna");
  const after = applyAiReview(match, advice);
  assert.equal(after.included, false);
  assert.equal(after.status, "review");
  assert.equal(needsAiReview(after), true);
  assert.throws(() =>
    validateReview({ ...good, candidateId: "invented" }, [track], "test"),
  );
  assert.throws(() =>
    validateReview({ ...good, decision: "skip" }, [track], "test"),
  );
  const safe = makeMatch(source, [scoreCandidate(source, candidate)]);
  assert.equal(
    applyAiReview(safe, { ...advice, decision: "uncertain", candidateId: null })
      .included,
    false,
  );
  assert.equal(
    applyAiReview(
      { ...safe, confirmedByUser: true },
      { ...advice, decision: "skip", candidateId: null },
    ).included,
    true,
  );
});
test("CSV handles Chinese, quotes, commas and formula injection", () => {
  const csv = matchesToCsv([
    makeMatch({ ...source, name: '=HYPERLINK("url"),中文' }, []),
  ]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes(`"'=HYPERLINK(""url""),中文"`));
  assert.ok(csv.includes("ai_reason"));
});
test("encrypted sessions reject tampering, wrong secrets and expiration", () => {
  const secret = "a".repeat(32);
  const token = seal({ token: "private" }, secret, 60);
  assert.deepEqual(unseal(token, secret), { token: "private" });
  assert.equal(unseal(token, "b".repeat(32)), null);
  assert.equal(
    unseal(token.slice(0, 10) + "XX" + token.slice(12), secret),
    null,
  );
  assert.equal(unseal(seal({ token: "private" }, secret, -1), secret), null);
});
test("playlist transfer batches 100 and reports partial success without retries", async (t) => {
  const batches: string[][] = [];
  let calls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: RequestInit) => {
      calls++;
      if (calls === 1)
        return Response.json({
          id: "target",
          external_urls: {
            spotify: "https://open.spotify.com/playlist/target",
          },
        });
      const body = JSON.parse(String(init.body));
      batches.push(body.uris);
      return calls === 3
        ? Response.json({}, { status: 429, headers: { "retry-after": "60" } })
        : Response.json({ snapshot_id: "ok" });
    },
  );
  const uris = Array.from({ length: 205 }, (_, i) => String(i));
  const result = await transferPlaylist("token", "test", uris, false);
  assert.equal(result.complete, false);
  assert.equal(result.added, 100);
  assert.equal(result.total, 205);
  assert.equal(calls, 3);
  assert.deepEqual(batches[0], uris.slice(0, 100));
  assert.deepEqual(batches[1], uris.slice(100, 200));
  assert.ok(result.url);
  assert.match(result.error!, /60/);
});
test("Spotify network and quota errors are not misreported as missing songs", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({}, { status: 429, headers: { "retry-after": "12" } }),
  );
  await assert.rejects(searchTrack("token", source), {
    status: 429,
    retryAfter: 12,
  });
});
test("NetEase preserves playlist order and reports unreadable songs", async (t) => {
  let call = 0;
  t.mock.method(globalThis, "fetch", async () => {
    call++;
    return Response.json(
      call === 1
        ? {
            code: 200,
            playlist: {
              name: "test",
              trackCount: 3,
              trackIds: [{ id: 1 }, { id: 2 }, { id: 3 }],
              tracks: [],
              creator: { nickname: "me" },
            },
          }
        : {
            code: 200,
            songs: [
              { id: 3, name: "third", artists: [] },
              { id: 1, name: "first", artists: [] },
            ],
          },
    );
  });
  const playlist = await getPlaylist("123");
  assert.deepEqual(
    playlist.songs.map((s) => s.id),
    ["1", "3"],
  );
  assert.equal(playlist.missing, 1);
});
test("relay receives only song metadata and uses the configured Luna model", async (t) => {
  const previous = {
    base: process.env.AI_BASE_URL,
    key: process.env.AI_API_KEY,
    model: process.env.AI_MODEL,
    style: process.env.AI_API_STYLE,
  };
  process.env.AI_BASE_URL = "https://relay.example/v1";
  process.env.AI_API_KEY = "test-key";
  process.env.AI_MODEL = "gpt-5.6-luna";
  const track = scoreCandidate(source, candidate);
  const answer = {
    decision: "match",
    candidateId: track.id,
    confidence: "high",
    reason: "歌手、歌名和时长一致。",
  };
  try {
    for (const style of ["chat_completions", "responses"]) {
      process.env.AI_API_STYLE = style;
      const spy = t.mock.method(
        globalThis,
        "fetch",
        async (url: string, init: RequestInit) => {
          assert.equal(
            url,
            `https://relay.example/v1/${style === "responses" ? "responses" : "chat/completions"}`,
          );
          const body = JSON.parse(String(init.body));
          assert.equal(body.model, "gpt-5.6-luna");
          assert.equal(body.store, false);
          const input = JSON.parse(
            style === "responses" ? body.input : body.messages[1].content,
          );
          assert.deepEqual(Object.keys(input.source), [
            "id",
            "title",
            "artists",
            "album",
            "durationMs",
          ]);
          assert.ok(!JSON.stringify(input).includes("spotify:track:"));
          return Response.json(
            style === "responses"
              ? {
                  status: "completed",
                  output: [
                    {
                      type: "message",
                      content: [
                        { type: "output_text", text: JSON.stringify(answer) },
                      ],
                    },
                  ],
                }
              : {
                  choices: [
                    {
                      finish_reason: "stop",
                      message: { content: JSON.stringify(answer) },
                    },
                  ],
                },
          );
        },
      );
      const result = await reviewWithAi(source, [track]);
      assert.equal(result.candidateId, track.id);
      spy.mock.restore();
    }
  } finally {
    for (const [key, value] of Object.entries({
      AI_BASE_URL: previous.base,
      AI_API_KEY: previous.key,
      AI_MODEL: previous.model,
      AI_API_STYLE: previous.style,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { needsArtistResearch, parseResearch } from "../lib/ai-research";
import { reviewSong } from "../lib/ai-review-service";
import {
  applyAiReview,
  makeMatch,
  needsAiReview,
  scoreCandidate,
} from "../lib/matching";
import { TaskStore } from "../lib/task-store";
import { AppError } from "../lib/http";
import { validateMatch } from "../lib/task-validation";
import type { AiReview, ArtistResearch, Song } from "../lib/types";

const source: Song = {
  id: "one",
  name: "後來",
  artists: ["歌手甲"],
  album: "原專輯",
  durationMs: 240000,
};
const track = (id: string, artist = "歌手甲") =>
  scoreCandidate(source, {
    ...source,
    id: id.repeat(22),
    artists: [artist],
    uri: `spotify:track:${id.repeat(22)}`,
    url: `https://open.spotify.com/track/${id.repeat(22)}`,
  });
const research: ArtistResearch = {
  summary: "官方唱片资料确认原唱；歌名另有简体写法。",
  originalArtist: "歌手甲",
  queries: [{ title: "后来", artist: "歌手甲" }],
  sources: [{ title: "唱片资料", url: "https://label.example/song" }],
  searchedAt: 1000,
};
const advice: AiReview = {
  decision: "match",
  candidateId: "a".repeat(22),
  confidence: "high",
  reason: "资料一致",
  model: "test",
  reviewedAt: 2000,
};

test("artist aliases require web research; simplified/traditional titles normalize equally", () => {
  assert.equal(needsArtistResearch(source, [track("a")]), false);
  assert.equal(needsArtistResearch(source, [track("b", "Singer A")]), true);
  assert.equal(
    needsArtistResearch(source, [{ ...track("a"), name: "后来" }]),
    false,
  );
  assert.equal(needsArtistResearch(source, []), true);
  assert.equal(needsAiReview(makeMatch(source, [])), true);
});

test("research requires an actual web call and source URLs from the tool, not invented citations", () => {
  const message = {
    type: "message",
    content: [{ type: "output_text", text: JSON.stringify(research) }],
  };
  assert.throws(() =>
    parseResearch({ status: "completed", output: [message] }),
  );
  const call = {
    type: "web_search_call",
    status: "completed",
    action: { sources: [{ url: "https://label.example/song" }] },
  };
  assert.deepEqual(
    parseResearch({ status: "completed", output: [call, message] }).sources,
    research.sources,
  );
  assert.throws(() =>
    parseResearch({
      status: "completed",
      output: [
        { ...call, action: { sources: [{ url: "https://other.example/" }] } },
        message,
      ],
    }),
  );
  const poison = {
    ...research,
    sources: [{ title: "bad", url: "javascript:alert(1)" }],
  };
  assert.throws(() =>
    parseResearch({
      status: "completed",
      output: [
        call,
        {
          ...message,
          content: [{ type: "output_text", text: JSON.stringify(poison) }],
        },
      ],
    }),
  );
});

test("verified alternate spelling searches Spotify; cooldown retains evidence without making another search", async () => {
  const previous = process.env.AI_WEB_SEARCH;
  process.env.AI_WEB_SEARCH = "1";
  const store = new TaskStore(":memory:", () => 1000);
  let searches = 0;
  const deps = {
    research: async () => research,
    search: async (_token: string, _source: Song, query: string) => {
      searches++;
      assert.match(query, /后来/);
      return [track("a")];
    },
    review: async (
      _source: Song,
      candidates: ReturnType<typeof track>[],
      evidence?: ArtistResearch,
    ) => {
      assert.deepEqual(evidence, research);
      return {
        ...advice,
        candidateId:
          candidates.find((c) => c.artists[0] === source.artists[0])?.id ||
          candidates[0].id,
        research: evidence,
      };
    },
  };
  try {
    const result = await reviewSong(
      source,
      [track("b", "翻唱者")],
      { store, token: "test", canExpand: true },
      deps,
    );
    assert.equal(searches, 1);
    assert.equal(result.candidateId, track("a").id);
    assert.equal(store.quota().used, 1);
    store.cooldown(120, "QUOTA_EXCEEDED");
    const limited = await reviewSong(
      source,
      [track("b", "翻唱者")],
      { store, token: "test", canExpand: true },
      deps,
    );
    assert.equal(searches, 1);
    assert.ok(limited.searchWarning);
    assert.deepEqual(limited.research, research);
    assert.equal(store.quota().used, 1);
    await assert.rejects(() =>
      reviewSong(
        source,
        [track("b")],
        { forceSearch: true },
        {
          ...deps,
          research: async () => {
            throw new AppError("search failed", 502);
          },
        },
      ),
    );
  } finally {
    store.close();
    if (previous === undefined) delete process.env.AI_WEB_SEARCH;
    else process.env.AI_WEB_SEARCH = previous;
  }
});

test("verified original singer alternative is selected, persists with accurate totals and respects manual choices", () => {
  const store = new TaskStore(":memory:");
  try {
    const original = track("b", "翻唱者");
    const match = makeMatch(source, [original]);
    const id = store.create(
      "alice",
      {
        id: "p",
        name: "test",
        creator: "",
        total: 1,
        missing: 0,
        songs: [source],
      },
      [match],
    );
    const result = {
      ...advice,
      matchKind: "original_alternative" as const,
      research,
      candidates: [track("a")],
    };
    const saved = store.saveAiReview(id, "alice", 0, result);
    assert.ok(saved.excludedCandidates.some((c) => c.id === original.id));
    let task = store.get(id, "alice");
    assert.equal(task.aiReviewed, 1);
    assert.equal(task.aiMatched, 1);
    assert.equal(task.matches[0].included, true);
    assert.equal(task.matches[0].selected?.id, track("a").id);
    assert.equal(task.matches[0].aiSelected, true);
    assert.equal(task.matches[0].aiReview?.matchKind, "original_alternative");
    assert.deepEqual(
      task.matches[0].aiReview?.research?.sources,
      research.sources,
    );
    const incoming = {
      ...task.matches[0],
      selected: original,
      confirmedByUser: true,
      included: true,
    };
    store.save(id, "alice", [{ index: 0, match: incoming }]);
    store.saveAiReview(id, "alice", 0, {
      ...result,
      decision: "skip",
      candidateId: null,
    });
    task = store.get(id, "alice");
    assert.equal(task.aiSkipped, 1);
    assert.equal(task.aiMatched, 0);
    assert.equal(task.matches[0].selected?.id, original.id);
    assert.equal(task.matches[0].included, true);
    assert.throws(() => store.saveAiReview(id, "bob", 0, result));
    const validated = validateMatch(
      {
        ...task.matches[0],
        aiReview: {
          ...advice,
          research: {
            ...research,
            sources: [{ url: "javascript:alert(1)", title: "bad" }],
          },
        },
      },
      source,
    )!;
    assert.deepEqual(validated.aiReview?.research?.sources, []);
    assert.equal(
      applyAiReview(makeMatch(source, [track("a")]), result).included,
      true,
    );
  } finally {
    store.close();
  }
});

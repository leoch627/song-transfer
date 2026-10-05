import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyAiReview,
  excludedVersion,
  excludedCandidateDetails,
  makeMatch,
  needsAiReview,
  normalize,
  scoreCandidate,
  visibleCandidates,
  uniqueCandidateRecordings,
} from "../lib/matching";
import { validateMatch, validateSavedMatch } from "../lib/task-validation";
import { TaskStore } from "../lib/task-store";
import type { AiReview, Match, Song } from "../lib/types";

const source: Song = {
  id: "406730159",
  name: "泪海",
  artists: ["许茹芸"],
  album: "经典老歌",
  durationMs: 300333,
};
function candidate(
  id: string,
  name: string,
  artist: string,
  durationMs: number,
) {
  return scoreCandidate(source, {
    ...source,
    id: id.repeat(22),
    name,
    artists: [artist],
    album: "月來月愛你",
    durationMs,
    uri: `spotify:track:${id.repeat(22)}`,
    url: `https://open.spotify.com/track/${id.repeat(22)}`,
  });
}
const smoke = candidate("a", "泪海（烟嗓版）", "半吨兄弟", 257288);
const cover = candidate("b", "泪海", "曾一鸣", 242634);
const original = candidate("c", "淚海", "Valen Hsu", 299826);
const advice: AiReview = {
  decision: "match",
  candidateId: original.id,
  confidence: "high",
  reason:
    "联网资料确认 Valen Hsu 为许茹芸的英文艺名，歌名简繁体相同，时长相差 0.5 秒。",
  model: "test",
  reviewedAt: 2000,
  matchKind: "same_recording",
  research: {
    summary: "官方资料确认艺名。",
    originalArtist: "许茹芸",
    queries: [{ title: "淚海", artist: "Valen Hsu" }],
    sources: [{ title: "唱片资料", url: "https://label.example/album" }],
    searchedAt: 1000,
  },
};
const legacy: Match = {
  source,
  candidates: [smoke, cover, original],
  selected: smoke,
  included: false,
  status: "review",
  aiReview: advice,
};

test("equivalent releases are reviewed once and old duplicate uncertainty is eligible for another review", () => {
  const duplicate = {
    ...original,
    id: "d".repeat(22),
    cover: "https://example.com/different-cover.jpg",
  };
  const remaster = {
    ...original,
    id: "r".repeat(22),
    name: "淚海 (Remastered)",
  };
  const shorter = {
    ...original,
    id: "s".repeat(22),
    durationMs: original.durationMs - 1000,
  };
  assert.deepEqual(
    uniqueCandidateRecordings([
      original,
      duplicate,
      cover,
      remaster,
      shorter,
    ]).map((c) => c.id),
    [original.id, cover.id, remaster.id, shorter.id],
  );
  assert.equal(
    uniqueCandidateRecordings([original, { ...duplicate, album: "" }]).length,
    2,
  );
  const match = applyAiReview(
    { ...legacy, candidates: [original, duplicate] },
    { ...advice, decision: "uncertain", candidateId: null },
  );
  assert.equal(needsAiReview(match), true);
  assert.equal(
    needsAiReview({
      ...match,
      aiReview: { ...match.aiReview!, reviewVersion: 2 },
    }),
    false,
  );
  assert.equal(needsAiReview({ ...match, confirmedByUser: true }), false);
  assert.equal(
    applyAiReview(match, { ...advice, reviewVersion: 2 }).selected?.id,
    original.id,
  );
});

test("excluded candidates remain inspectable through re-review and stale browser saves without changing the chosen song", () => {
  const store = new TaskStore(":memory:");
  try {
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
      [legacy],
    );
    const result = store.saveAiReview(id, "alice", 0, {
      ...advice,
      candidates: [original],
    });
    const saved = store.get(id, "alice").matches[0];
    const excluded = excludedCandidateDetails(saved);
    assert.deepEqual(
      new Set(excluded.map(({ candidate }) => candidate.id)),
      new Set([smoke.id, cover.id]),
    );
    assert.match(
      excluded.find(({ candidate }) => candidate.id === smoke.id)!.reason,
      /版本标签/,
    );
    assert.match(
      excluded.find(({ candidate }) => candidate.id === cover.id)!.reason,
      /此前复核/,
    );
    assert.equal(saved.selected?.id, original.id);
    assert.equal(saved.included, true);
    assert.deepEqual(result.excludedCandidates, saved.excludedCandidates);
    const stale = validateSavedMatch(
      { ...legacy, excludedCandidates: [candidate("x", "fake", "fake", 1)] },
      saved,
    )!;
    store.save(id, "alice", [{ index: 0, match: stale }]);
    assert.deepEqual(
      store.get(id, "alice").matches[0].excludedCandidates,
      saved.excludedCandidates,
    );
    store.saveAiReview(id, "alice", 0, { ...advice, candidates: [original] });
    assert.deepEqual(
      store.get(id, "alice").matches[0].excludedCandidates,
      saved.excludedCandidates,
    );

    const skipped = applyAiReview(legacy, {
      ...advice,
      candidateId: null,
      decision: "skip",
    });
    assert.equal(visibleCandidates(skipped).length, 0);
    assert.equal(excludedCandidateDetails(skipped).length, 3);
    assert.equal(
      excludedCandidateDetails(skipped).find(
        ({ candidate }) => candidate.id === cover.id,
      )!.reason,
      "AI 本轮未采纳此候选，具体依据见上方复核说明。",
    );
  } finally {
    store.close();
  }
});

test("泪海 selects the web-verified original singer directly and hides covers", () => {
  assert.equal(normalize("淚海"), normalize("泪海"));
  const ranked = makeMatch(source, legacy.candidates);
  assert.equal(ranked.selected?.id, original.id);
  assert.ok(original.score > smoke.score);
  const result = applyAiReview(legacy, advice);
  assert.equal(result.selected?.id, original.id);
  assert.equal(result.included, true);
  assert.equal(result.status, "matched");
  assert.equal(result.aiSelected, true);
  assert.deepEqual(
    visibleCandidates(result).map((c) => c.id),
    [original.id],
  );
  assert.equal(needsAiReview(result), false);
  assert.equal(validateMatch(result, source)?.selected?.id, original.id);
  assert.equal(validateMatch(result, source)?.aiSelected, true);
});

test("aliases need web evidence and smoke covers cannot be selected even with high AI confidence", () => {
  for (const review of [
    { ...advice, research: undefined },
    { ...advice, confidence: "medium" as const },
    { ...advice, candidateId: smoke.id },
    { ...advice, decision: "skip" as const, candidateId: null },
    { ...advice, decision: "uncertain" as const, candidateId: null },
  ]) {
    const result = applyAiReview(legacy, review);
    assert.equal(result.selected, null);
    assert.equal(result.included, false);
    assert.equal(result.aiSelected, false);
    assert.ok(!visibleCandidates(result).some((c) => c.id === smoke.id));
  }
  assert.equal(
    needsAiReview(applyAiReview(legacy, { ...advice, research: undefined })),
    true,
  );
  assert.equal(
    excludedVersion(source, { ...smoke, name: "泪海", album: "煙嗓翻唱合集" }),
    true,
  );
  assert.equal(makeMatch(source, [smoke]).selected, null);
  // A source that actually requests a live version can still match that version.
  const live = { ...source, name: "泪海 (Live)" };
  assert.equal(
    excludedVersion(live, { ...original, name: "淚海 (Live)" }),
    false,
  );
});

test("same-artist matches can be auto-selected without alias research, but original alternatives need evidence", () => {
  const sameArtist = { ...original, artists: source.artists };
  const match = makeMatch(source, [sameArtist]);
  assert.equal(
    applyAiReview(match, { ...advice, research: undefined }).included,
    true,
  );
  assert.equal(
    applyAiReview(match, {
      ...advice,
      matchKind: "original_alternative",
      research: undefined,
    }).included,
    false,
  );
  assert.equal(
    applyAiReview(match, { ...advice, matchKind: "original_alternative" })
      .included,
    true,
  );
});

test("stale browser saves preserve the server choice and evidence, including equal review timestamps", () => {
  const saved = applyAiReview(legacy, advice);
  for (const incoming of [
    { ...legacy, aiReview: undefined },
    { ...legacy, aiReview: { ...advice, research: undefined } },
    // Removed stale candidates are ignored, and cannot introduce a new candidate.
    { ...legacy, candidates: [candidate("x", "other", "other", 1)] },
  ]) {
    const result = validateSavedMatch(incoming, saved)!;
    assert.equal(result.selected?.id, original.id);
    assert.equal(result.included, true);
    assert.deepEqual(result.aiReview, advice);
  }
  assert.throws(() =>
    validateSavedMatch(
      {
        ...saved,
        confirmedByUser: true,
        selected: candidate("x", "other", "other", 1),
      },
      saved,
    ),
  );
  for (const selected of [null, cover]) {
    const manual = {
      ...saved,
      selected,
      confirmedByUser: true,
      included: !!selected,
    };
    const result = validateSavedMatch(manual, saved)!;
    assert.equal(result.selected?.id, selected?.id);
    assert.equal(result.included, !!selected);
    assert.equal(result.aiSelected, false);
    assert.equal(applyAiReview(result, advice).selected?.id, selected?.id);
  }
  const unchecked = validateSavedMatch(
    { ...saved, confirmedByUser: true, included: false },
    saved,
  )!;
  assert.equal(applyAiReview(unchecked, advice).included, false);
});

test("upgrade applies saved AI choices once while retaining jobs, search checkpoints, reviews and manual selections", () => {
  const dir = mkdtempSync(join(tmpdir(), "songtransfer-auto-selection-"));
  const path = join(dir, "tasks.sqlite");
  let store = new TaskStore(path, () => 3000);
  try {
    const manual = {
      ...legacy,
      selected: cover,
      confirmedByUser: true,
      included: true,
      status: "matched" as const,
    };
    const playlist = {
      id: "p",
      name: "我的歌单",
      creator: "",
      total: 3,
      missing: 0,
      songs: [
        source,
        { ...source, id: "manual" },
        { ...source, id: "pending" },
      ],
    };
    const id = store.create("alice", playlist, [
      legacy,
      { ...manual, source: playlist.songs[1] },
    ]);
    const claim = store.claim()!;
    store.checkpoint(claim, 2, { nextQuery: 1, candidates: [original] });
    store.reserveSearch();
    store.cooldown(120, "QUOTA_EXCEEDED");
    store.finish(claim, "waiting", 123000, "Spotify 限流");
    const transferring = store.create(
      "alice",
      { ...playlist, songs: [source], total: 1 },
      [{ ...legacy, included: true, status: "matched" }],
    );
    store.beginTransfer(transferring, "alice");
    const before = store.get(id, "alice");
    const written = store.get(transferring, "alice");
    const rows = store.db
      .prepare(
        "SELECT task_id,position,source,checkpoint FROM task_songs ORDER BY task_id,position",
      )
      .all();
    const quota = store.quota();
    store.db
      .prepare("DELETE FROM task_migrations WHERE name=?")
      .run("ai-auto-selection-v1");
    store.close();
    store = new TaskStore(path, () => 4000);
    const after = store.get(id, "alice");
    assert.equal(after.matches[0].selected?.id, original.id);
    assert.equal(after.matches[0].aiSelected, true);
    assert.equal(after.matches[1].selected?.id, cover.id);
    assert.equal(after.matches[1].confirmedByUser, true);
    assert.equal(after.matches[1].included, true);
    assert.equal(after.matches[2].status, "pending");
    for (const key of [
      "id",
      "status",
      "resumeAt",
      "completed",
      "aiReviewed",
      "aiMatched",
      "playlist",
      "workspace",
    ] as const)
      assert.deepEqual(after[key], before[key], key);
    assert.deepEqual(
      after.matches.map((m) => m.aiReview),
      before.matches.map((m) => m.aiReview),
    );
    assert.deepEqual(
      after.matches[0].candidates.map((c) => c.id).sort(),
      legacy.candidates.map((c) => c.id).sort(),
    );
    assert.deepEqual(
      store.db
        .prepare(
          "SELECT task_id,position,source,checkpoint FROM task_songs ORDER BY task_id,position",
        )
        .all(),
      rows,
    );
    assert.deepEqual(store.quota(), quota);
    assert.deepEqual(store.get(transferring, "alice"), written);
    assert.deepEqual(store.applySavedAiSelections(), {
      updated: 0,
      selected: 0,
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

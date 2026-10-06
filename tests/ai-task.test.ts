import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "../lib/task-store";
import { AiTaskQueue } from "../lib/ai-task-queue";
import { runAiTaskStep } from "../lib/ai-task-worker";
import { makeMatch, scoreCandidate } from "../lib/matching";
import { AppError } from "../lib/http";
import type { AiReviewResponse, Song } from "../lib/types";

const source: Song = {
  id: "source",
  name: "晴天",
  artists: ["周杰伦"],
  album: "叶惠美",
  durationMs: 269000,
};
function create(store: TaskStore, count = 4) {
  const songs = Array.from({ length: count }, (_, i) => ({
    ...source,
    id: String(i),
  }));
  return store.create(
    "alice",
    {
      id: "playlist",
      name: "喜欢",
      creator: "测试",
      total: count,
      missing: 0,
      songs,
    },
    songs.map((s) => makeMatch(s, [])),
  );
}
const result: AiReviewResponse = {
  decision: "skip",
  candidateId: null,
  confidence: "high",
  reason: "无合适版本",
  model: "test",
  reviewedAt: 2000,
  reviewVersion: 2,
};

test("AI queues persist across restarts, cap concurrent leases across processes and never redo completed items", () => {
  const dir = mkdtempSync(join(tmpdir(), "songshift-ai-worker-"));
  let now = 1000;
  let store = new TaskStore(join(dir, "tasks.sqlite"), () => now);
  try {
    const id = create(store),
      queue = new AiTaskQueue(store);
    queue.start(id, "alice");
    const first = queue.claim(3)!,
      second = queue.claim(3)!,
      third = queue.claim(3)!;
    assert.equal(queue.claim(3), null);
    queue.complete(first, result);
    const fourth = queue.claim(3)!;
    assert.deepEqual(
      [first.index, second.index, third.index, fourth.index],
      [0, 1, 2, 3],
    );
    assert.equal(queue.summary(id)?.completed, 1);
    store.close();
    store = new TaskStore(join(dir, "tasks.sqlite"), () => now);
    const restarted = new AiTaskQueue(store);
    assert.equal(restarted.claim(3), null);
    now += 120001;
    const reclaimed = restarted.claim(3)!;
    assert.equal(reclaimed.index, second.index);
    assert.throws(() => restarted.complete(second, result), /接管/);
    assert.equal(store.get(id, "alice").matches[1].aiReview, undefined);
    restarted.complete(reclaimed, result);
    restarted.complete(restarted.claim(3)!, result);
    restarted.complete(restarted.claim(3)!, result);
    assert.equal(restarted.summary(id)?.status, "complete");
    assert.equal(restarted.summary(id)?.completed, 4);
    assert.equal(restarted.claim(3), null);
    assert.equal(store.get(id, "alice").aiReviewed, 4);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AI pause drains work, resume does not duplicate claims and manual selections survive in-flight results", () => {
  const store = new TaskStore(":memory:");
  try {
    const id = create(store),
      queue = new AiTaskQueue(store);
    queue.start(id, "alice");
    const first = queue.claim(3)!;
    queue.pause(id, "alice");
    assert.equal(queue.claim(3), null);
    const candidate = scoreCandidate(first.match.source, {
      ...first.match.source,
      id: "a".repeat(22),
      uri: `spotify:track:${"a".repeat(22)}`,
      url: `https://open.spotify.com/track/${"a".repeat(22)}`,
    });
    const manual = {
      ...makeMatch(first.match.source, [candidate]),
      confirmedByUser: true,
    };
    store.save(id, "alice", [{ index: first.index, match: manual }]);
    queue.complete(first, result);
    assert.equal(queue.summary(id)?.status, "paused");
    assert.equal(
      store.get(id, "alice").matches[first.index].selected?.id,
      candidate.id,
    );
    queue.start(id, "alice");
    const next = queue.claim(3)!;
    assert.equal(next.index, 1);
    queue.pause(id, "alice");
    queue.start(id, "alice");
    assert.equal(queue.claim(3)?.index, 2);
    assert.equal(queue.summary(id)?.completed, 1);
  } finally {
    store.close();
  }
});

test("AI rate-limit deadline persists, blocks all task claims and automatically resumes at the boundary", () => {
  let now = 1000;
  const store = new TaskStore(":memory:", () => now);
  try {
    const id = create(store),
      other = create(store),
      queue = new AiTaskQueue(store);
    queue.start(id, "alice");
    const item = queue.claim(3)!;
    queue.fail(item, new AppError("限流", 429, 17, "AI_RATE_LIMITED"));
    queue.start(other, "alice");
    assert.equal(queue.summary(id)?.resumeAt, 18000);
    assert.equal(queue.summary(other)?.status, "waiting");
    now = 17999;
    assert.equal(queue.claim(3), null);
    now = 18000;
    assert.ok(queue.claim(3));
    assert.equal(store.quota().resumeAt, 0);
  } finally {
    store.close();
  }
});

test("AI worker saves results without browser requests and errors preserve completed checkpoints", async () => {
  const store = new TaskStore(":memory:");
  try {
    const id = create(store, 2),
      queue = new AiTaskQueue(store);
    queue.start(id, "alice");
    const dependencies = {
      token: async () => "token",
      review: async () => result,
    };
    assert.equal(await runAiTaskStep(store, dependencies), true);
    assert.equal(queue.summary(id)?.completed, 1);
    await runAiTaskStep(store, {
      ...dependencies,
      review: async () => {
        throw new Error("network");
      },
    });
    assert.equal(queue.summary(id)?.status, "failed");
    assert.equal(queue.summary(id)?.completed, 1);
    assert.equal(await runAiTaskStep(store, dependencies), false);
    queue.start(id, "alice");
    await runAiTaskStep(store, dependencies);
    assert.equal(queue.summary(id)?.status, "complete");
    assert.equal(store.get(id, "alice").aiReviewed, 2);
  } finally {
    store.close();
  }
});

test("AI tasks are owner-scoped, disconnect pauses reviews and deletion discards late results", () => {
  const store = new TaskStore(":memory:");
  try {
    const id = create(store),
      queue = new AiTaskQueue(store);
    assert.throws(() => queue.start(id, "bob"), { status: 404 });
    queue.start(id, "alice");
    assert.throws(() => queue.pause(id, "bob"), { status: 404 });
    const item = queue.claim(3)!;
    store.disconnect("alice");
    assert.equal(queue.summary(id)?.status, "needs_auth");
    assert.equal(queue.claim(3), null);
    store.control(id, "alice", "delete");
    assert.throws(() => queue.complete(item, result), { status: 404 });
    assert.doesNotThrow(() => queue.fail(item, new Error()));
    assert.equal(queue.summary(id), null);
  } finally {
    store.close();
  }
});

test("transfer waits for AI jobs and manual changes made after selection remain protected", () => {
  const store = new TaskStore(":memory:");
  try {
    const id = create(store, 1),
      queue = new AiTaskQueue(store);
    const match = store.get(id, "alice").matches[0];
    const candidate = scoreCandidate(match.source, {
      ...match.source,
      id: "b".repeat(22),
      uri: `spotify:track:${"b".repeat(22)}`,
      url: `https://open.spotify.com/track/${"b".repeat(22)}`,
    });
    store.save(id, "alice", [
      { index: 0, match: makeMatch(match.source, [candidate]) },
    ]);
    queue.start(id, "alice", [0], true);
    const item = queue.claim(3)!;
    assert.equal(item.forceSearch, true);
    assert.throws(() => store.beginTransfer(id, "alice"), /AI/);
    queue.pause(id, "alice");
    assert.throws(() => store.beginTransfer(id, "alice"), /AI/);
    queue.complete(item, {
      ...result,
      decision: "match",
      candidateId: candidate.id,
      matchKind: "same_recording",
    });
    assert.equal(store.beginTransfer(id, "alice").uris.length, 1);
    assert.throws(() => queue.start(id, "alice", [0]), { status: 409 });
  } finally {
    store.close();
  }
});

test("evidence failures do not block other songs, preserve old results and persist until explicit retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "songshift-evidence-"));
  let store = new TaskStore(join(dir, "tasks.sqlite"));
  try {
    const id = create(store, 3);
    store.saveAiReview(id, "alice", 0, result);
    const previous = store.get(id, "alice").matches[0];
    let queue = new AiTaskQueue(store);
    queue.start(id, "alice", [0, 1, 2], true);
    const completed = queue.claim(3)!, blocked = queue.claim(3)!;
    queue.complete(blocked, result);
    // Failure of an older review must not overwrite that saved review.
    queue.fail(completed, new AppError("没有来源", 502, undefined, "AI_RESEARCH_NO_SOURCES"));
    assert.deepEqual(store.get(id, "alice").matches[0], previous);
    assert.equal(queue.summary(id)?.status, "running");
    assert.deepEqual(queue.summary(id)?.blocked.map((s) => ({ ...s })), [{ index: 0, name: "晴天", error: "没有来源" }]);
    await runAiTaskStep(store, { token: async () => "token", review: async () => result });
    assert.equal(queue.summary(id)?.status, "complete");
    assert.equal(queue.summary(id)?.completed, 2);
    assert.equal(queue.claim(3), null);
    store.close(); store = new TaskStore(join(dir, "tasks.sqlite")); queue = new AiTaskQueue(store);
    assert.equal(queue.summary(id)?.blocked.length, 1);
    assert.equal(queue.claim(3), null);
    queue.start(id, "alice");
    const retry = queue.claim(3)!;
    assert.equal(retry.index, 0);
    assert.equal(queue.summary(id)?.blocked.length, 0);
    assert.equal(queue.summary(id)?.completed, 2);
    queue.complete(retry, result);
    assert.equal(queue.summary(id)?.status, "complete");
    assert.equal(queue.summary(id)?.completed, 3);
    assert.equal(queue.claim(3), null);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("evidence failures preserve a user's pause and cannot erase a concurrent rate limit", () => {
  const store = new TaskStore(":memory:");
  try {
    const id = create(store, 3), queue = new AiTaskQueue(store);
    queue.start(id, "alice");
    const first = queue.claim(3)!, second = queue.claim(3)!;
    queue.fail(first, new AppError("限流", 429, 30));
    const until = queue.summary(id)?.resumeAt;
    queue.fail(second, new AppError("没有来源", 502, undefined, "AI_RESEARCH_NO_SOURCES"));
    assert.equal(queue.summary(id)?.status, "waiting");
    assert.equal(queue.summary(id)?.resumeAt, until);
    queue.pause(id, "alice");
    assert.equal(queue.claim(3), null);
    queue.start(id, "alice", [second.index], true);
    assert.equal(queue.summary(id)?.status, "waiting");
    assert.equal(queue.summary(id)?.blocked.length, 0);
  } finally { store.close(); }
});

test("legacy AI queue schema upgrades without changing pending songs, completed reviews or failure status", () => {
  const dir = mkdtempSync(join(tmpdir(), "songshift-ai-schema-"));
  let store = new TaskStore(join(dir, "tasks.sqlite"));
  try {
    const id = create(store, 2), queue = new AiTaskQueue(store);
    queue.start(id, "alice");
    queue.complete(queue.claim(3)!, result);
    queue.fail(queue.claim(3)!, new AppError("没有来源", 502));
    const saved = store.get(id, "alice");
    store.db.exec("ALTER TABLE ai_job_songs DROP COLUMN error; ALTER TABLE ai_job_songs DROP COLUMN search_checkpoint");
    const before = store.db.prepare("SELECT * FROM ai_job_songs").all();
    store.close(); store = new TaskStore(join(dir, "tasks.sqlite"));
    assert.deepEqual(store.db.prepare("SELECT task_id,position,state,force_search,lease,lease_until FROM ai_job_songs").all(), before);
    assert.deepEqual(store.get(id, "alice"), saved);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

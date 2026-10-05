import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import {
  boundedConcurrency,
  runConcurrentBatch,
  type BatchProgress,
} from "../lib/ai-batch";
import { callAi } from "../lib/ai-relay";
import { aiStatus } from "../lib/ai";
import { AppError } from "../lib/http";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("parallel reviews stay bounded and report out-of-order successes exactly once", async () => {
  const items = Array.from({ length: 7 }, (_, i) => i);
  const gates = items.map(() => deferred<void>());
  const started: number[] = [],
    saved: number[] = [],
    snapshots: BatchProgress[] = [];
  const batch = runConcurrentBatch(
    items,
    async (i) => {
      started.push(i);
      await gates[i].promise;
      saved.push(i);
    },
    {
      concurrency: 3,
      shouldStop: () => false,
      onProgress: (s) => snapshots.push(s),
    },
  );
  assert.deepEqual(started, [0, 1, 2]);
  gates[1].resolve();
  await flush();
  assert.deepEqual(saved, [1]);
  assert.deepEqual(started, [0, 1, 2, 3]);
  gates[2].resolve();
  await flush();
  assert.deepEqual(saved, [1, 2]);
  for (const gate of gates) gate.resolve();
  assert.equal(await batch, 7);
  assert.equal(new Set(saved).size, 7);
  assert.ok(snapshots.every((s) => s.active.length <= 3));
  assert.deepEqual(
    snapshots.map((s) => s.done),
    snapshots.map((s) => s.done).sort((a, b) => a - b),
  );
  assert.equal(snapshots.at(-1)!.active.length, 0);
});

test("pause drains in-flight reviews and leaves unstarted songs for continuation", async () => {
  let paused = false;
  const gates = Array.from({ length: 6 }, () => deferred<void>());
  const started: number[] = [],
    saved: number[] = [];
  const batch = runConcurrentBatch(
    gates,
    async (gate, i) => {
      started.push(i);
      await gate.promise;
      saved.push(i);
    },
    { concurrency: 3, shouldStop: () => paused, onProgress: () => {} },
  );
  paused = true;
  gates[2].resolve();
  gates[0].resolve();
  gates[1].resolve();
  assert.equal(await batch, 3);
  assert.deepEqual(started, [0, 1, 2]);
  assert.deepEqual(saved.sort(), [0, 1, 2]);
});

test("a failed request stops new work but still saves and counts other in-flight results", async () => {
  const gates = Array.from({ length: 6 }, () => deferred<void>());
  const started: number[] = [],
    saved: number[] = [],
    snapshots: BatchProgress[] = [];
  let settled = false;
  const error = new Error("429");
  const batch = runConcurrentBatch(
    gates,
    async (gate, i) => {
      started.push(i);
      await gate.promise;
      saved.push(i);
    },
    {
      concurrency: 3,
      shouldStop: () => false,
      onProgress: (s) => snapshots.push(s),
    },
  );
  const rejected = assert.rejects(batch, (e) => {
    settled = true;
    return e === error;
  });
  gates[1].reject(error);
  await flush();
  assert.equal(settled, false);
  assert.deepEqual(started, [0, 1, 2]);
  gates[0].resolve();
  gates[2].resolve();
  await rejected;
  assert.deepEqual(saved, [0, 2]);
  assert.equal(snapshots.at(-1)!.done, 2);
  assert.equal(snapshots.at(-1)!.active.length, 0);
  assert.equal(snapshots.at(-1)!.failed, true);
});

test("relay enforces shared concurrency and Retry-After across queued requests", async (t) => {
  const prior = {
    AI_BASE_URL: process.env.AI_BASE_URL,
    AI_API_KEY: process.env.AI_API_KEY,
    AI_REVIEW_CONCURRENCY: process.env.AI_REVIEW_CONCURRENCY,
    AI_MODEL: process.env.AI_MODEL,
  };
  process.env.AI_BASE_URL = "https://relay.example/v1";
  process.env.AI_API_KEY = "test";
  process.env.AI_REVIEW_CONCURRENCY = "3";
  delete process.env.AI_MODEL;
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const gates: ReturnType<typeof deferred<Response>>[] = [];
  let active = 0,
    maxActive = 0;
  t.mock.method(globalThis, "fetch", async () => {
    active++;
    maxActive = Math.max(active, maxActive);
    const gate = deferred<Response>();
    gates.push(gate);
    try {
      return await gate.promise;
    } finally {
      active--;
    }
  });
  try {
    assert.equal(aiStatus().model, "gpt-6-luna");
    assert.equal(aiStatus().concurrency, 3);
    const calls = Array.from({ length: 6 }, () => callAi({}, "responses"));
    await flush();
    assert.equal(gates.length, 3);
    gates[0].resolve(Response.json({ ok: true }));
    await flush();
    assert.equal(gates.length, 4);
    for (let i = 1; i < 6; i++) {
      gates[i].resolve(Response.json({ ok: true }));
      await flush();
    }
    await Promise.all(calls);
    assert.equal(maxActive, 3);

    const limited = Promise.allSettled(
      Array.from({ length: 6 }, () => callAi({}, "responses")),
    );
    await flush();
    assert.equal(gates.length, 9);
    gates[6].resolve(
      Response.json({}, { status: 429, headers: { "Retry-After": "30" } }),
    );
    await flush();
    gates[7].resolve(Response.json({ ok: true }));
    gates[8].resolve(Response.json({ ok: true }));
    const results = await limited;
    assert.equal(gates.length, 9); // queued calls must not hit the upstream during cooldown
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
    for (const result of results)
      if (result.status === "rejected") {
        assert.ok(result.reason instanceof AppError);
        assert.equal(result.reason.status, 429);
        assert.equal(result.reason.retryAfter, 30);
      }
    now += 30000;
    const recovered = callAi({}, "responses");
    await flush();
    assert.equal(gates.length, 10);
    gates[9].resolve(Response.json({ ok: true }));
    await recovered;
    assert.equal(boundedConcurrency(100), 5);
    assert.equal(boundedConcurrency("invalid"), 3);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

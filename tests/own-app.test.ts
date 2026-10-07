import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../lib/task-store";
import { requestSpotifyToken, taskAccessToken } from "../lib/task-session";

const OWN = "0123456789abcdef0123456789abcdef";

function withStore<T>(fn: (store: TaskStore) => Promise<T> | T) {
  const dir = mkdtempSync(join(tmpdir(), "songshift-ownapp-"));
  const store = new TaskStore(join(dir, "tasks.sqlite"));
  const secret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "s".repeat(40);
  process.env.SPOTIFY_CLIENT_ID = "default-app-client-id";
  return Promise.resolve(fn(store)).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    if (secret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = secret;
  });
}

function mockTokenEndpoint() {
  const original = globalThis.fetch;
  const clientIds: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    clientIds.push(new URLSearchParams(String(init?.body)).get("client_id")!);
    return new Response(
      JSON.stringify({ access_token: "fresh", expires_in: 3600 }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { clientIds, restore: () => (globalThis.fetch = original) };
}

test("a user's own Spotify app is stored per owner and can be cleared", () =>
  withStore((store) => {
    assert.equal(store.spotifyClientId("alice"), "");
    store.setSpotifyClientId("alice", OWN);
    assert.equal(store.spotifyClientId("alice"), OWN);
    assert.equal(store.spotifyClientId("bob"), "");
    store.setSpotifyClientId("alice", "");
    assert.equal(store.spotifyClientId("alice"), "");
  }));

test("token requests use the given Client ID, else the site default", async () => {
  const mock = mockTokenEndpoint();
  try {
    await withStore(async () => {
      await requestSpotifyToken({ grant_type: "refresh_token", refresh_token: "r" }, OWN);
      await requestSpotifyToken({ grant_type: "refresh_token", refresh_token: "r" });
    });
    assert.deepEqual(mock.clientIds, [OWN, "default-app-client-id"]);
  } finally {
    mock.restore();
  }
});

test("background refresh keeps using the Spotify app the session was authorised with", async () => {
  const mock = mockTokenEndpoint();
  try {
    await withStore(async (store) => {
      store.saveAccount("alice", {
        accessToken: "old",
        refreshToken: "refresh",
        expiresAt: 0,
        clientId: OWN,
      });
      store.saveAccount("bob", {
        accessToken: "old",
        refreshToken: "refresh",
        expiresAt: 0,
      });
      assert.equal(await taskAccessToken("alice", store), "fresh");
      assert.equal(await taskAccessToken("bob", store), "fresh");
    });
    assert.deepEqual(mock.clientIds, [OWN, "default-app-client-id"]);
  } finally {
    mock.restore();
  }
});

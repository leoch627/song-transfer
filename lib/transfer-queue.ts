import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "./http";
import type { TaskStore } from "./task-store";
import type { TransferJobSummary } from "./task-types";

export type TransferState = {
  name: string;
  isPublic: boolean;
  uris: string[];
  marker: string;
  playlistId: string;
  spotifyUser: string;
  tokenHash: string;
  snapshot: string;
  added: number;
  pending: "" | "create" | "append";
  scanOffset: number;
  foundId: string;
  verification: { offset: number; total: number; snapshot: string } | null;
};
type JobRow = {
  task_id: string;
  status: TransferJobSummary["status"];
  data: string;
  resume_at: number;
  error: string;
  lease: string;
  lease_until: number;
};
export type TransferClaim = {
  id: string;
  owner: string;
  lease: string;
  state: TransferState;
};
const active = "('queued','running','waiting')";

export class TransferQueue {
  constructor(readonly store: TaskStore) {}
  static initialize(db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS transfer_jobs (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      status TEXT NOT NULL, data TEXT NOT NULL, resume_at INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '', lease TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0
    );
    -- Spotify enforces a separate daily quota on /search (QUOTA_EXCEEDED with a
    -- Retry-After of many hours) while playlist writes keep working, so playlist
    -- writes track their own 429 wait instead of sharing search_cooldown.
    CREATE TABLE IF NOT EXISTS write_cooldown (id INTEGER PRIMARY KEY CHECK(id=1), until_at INTEGER NOT NULL, reason TEXT NOT NULL);`);
  }
  /** Earliest time playlist writes may resume after a write 429 (0 = now). */
  resumeAt() {
    const row = this.store.db
      .prepare("SELECT until_at FROM write_cooldown WHERE id=1")
      .get() as { until_at: number } | undefined;
    return row && row.until_at > this.store.now() ? row.until_at : 0;
  }
  cooldown(seconds: number, reason: string) {
    this.store.db
      .prepare(
        `INSERT INTO write_cooldown VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET
      until_at=MAX(until_at,excluded.until_at),reason=excluded.reason`,
      )
      .run(this.store.now() + Math.max(1, seconds) * 1000, reason);
  }
  summary(id: string): TransferJobSummary | null {
    const row = this.store.db
      .prepare("SELECT * FROM transfer_jobs WHERE task_id=?")
      .get(id) as JobRow | undefined;
    if (!row) return null;
    const state = JSON.parse(row.data) as TransferState;
    return {
      status: row.status,
      added: state.added,
      total: state.uris.length,
      url: state.playlistId
        ? `https://open.spotify.com/playlist/${state.playlistId}`
        : "",
      verifying: !!state.pending,
      resumeAt: row.resume_at,
      error: row.error,
    };
  }
  enqueue(id: string, owner: string) {
    return this.store.transaction(() => {
      this.store.owned(id, owner);
      // A lost HTTP response or a double click returns the same durable job.
      const existing = this.summary(id);
      if (existing) return existing;
      const input = this.store.transferInput(id, owner);
      const state: TransferState = {
        ...input,
        marker: `SongShift transfer ${randomUUID()}`,
        playlistId: "",
        spotifyUser: "",
        tokenHash: "",
        snapshot: "",
        added: 0,
        pending: "",
        scanOffset: 0,
        foundId: "",
        verification: null,
      };
      const resumeAt = this.resumeAt();
      this.store.db
        .prepare(
          "INSERT INTO transfer_jobs(task_id,status,data,resume_at,error) VALUES(?,?,?,?,?)",
        )
        .run(
          id,
          resumeAt ? "waiting" : "queued",
          JSON.stringify(state),
          resumeAt,
          resumeAt ? "Spotify 暂时限流，到时自动开始后台写入。" : "",
        );
      this.store.db
        .prepare(
          "UPDATE tasks SET workspace=json_set(workspace,'$.writeStarted',json('true')),updated_at=MAX(updated_at+1,?) WHERE id=?",
        )
        .run(this.store.now(), id);
      return this.summary(id)!;
    });
  }
  retry(id: string, owner: string) {
    this.store.transaction(() => {
      this.store.owned(id, owner);
      const row = this.store.db
        .prepare("SELECT * FROM transfer_jobs WHERE task_id=?")
        .get(id) as JobRow | undefined;
      if (!row) throw new AppError("没有可继续的后台写入任务。", 409);
      if (!["blocked", "failed", "needs_auth"].includes(row.status)) return;
      if (row.lease_until > this.store.now())
        throw new AppError("上一轮请求仍在处理，请稍后重试。", 409);
      const state = JSON.parse(row.data) as TransferState;
      // Uncertain writes stay pending: retry only re-reads Spotify, never re-sends them.
      state.scanOffset = 0;
      state.foundId = "";
      state.verification = null;
      this.store.db
        .prepare(
          "UPDATE transfer_jobs SET status='queued',data=?,resume_at=0,error='' WHERE task_id=?",
        )
        .run(JSON.stringify(state), id);
      this.touch(id);
    });
  }
  touch(id: string) {
    this.store.db
      .prepare("UPDATE tasks SET updated_at=MAX(updated_at+1,?) WHERE id=?")
      .run(this.store.now(), id);
  }
  claim(): TransferClaim | null {
    return this.store.transaction(() => {
      const now = this.store.now(),
        cooldown = this.resumeAt();
      if (cooldown > now) {
        const waiting = this.store.db
          .prepare(
            `SELECT task_id FROM transfer_jobs WHERE status IN ${active} AND resume_at<? AND lease_until<=?`,
          )
          .all(cooldown, now) as { task_id: string }[];
        for (const row of waiting) {
          this.store.db
            .prepare(
              "UPDATE transfer_jobs SET status='waiting',resume_at=?,error='Spotify 暂时限流，进度已保存，到时自动继续。' WHERE task_id=?",
            )
            .run(cooldown, row.task_id);
          this.touch(row.task_id);
        }
        return null;
      }
      const row = this.store.db
        .prepare(
          `SELECT j.*,t.owner FROM transfer_jobs j JOIN tasks t ON t.id=j.task_id
        WHERE j.status IN ${active} AND j.resume_at<=? AND j.lease_until<=? ORDER BY t.updated_at LIMIT 1`,
        )
        .get(now, now) as (JobRow & { owner: string }) | undefined;
      if (!row) return null;
      const lease = randomUUID();
      this.store.db
        .prepare(
          "UPDATE transfer_jobs SET status='running',lease=?,lease_until=?,resume_at=0,error='' WHERE task_id=?",
        )
        .run(lease, now + 120000, row.task_id);
      this.touch(row.task_id);
      return {
        id: row.task_id,
        owner: row.owner,
        lease,
        state: JSON.parse(row.data),
      };
    });
  }
  check(claim: TransferClaim) {
    if (
      !this.store.db
        .prepare(
          "SELECT 1 FROM transfer_jobs WHERE task_id=? AND lease=? AND lease_until>? AND status='running'",
        )
        .get(claim.id, claim.lease, this.store.now())
    )
      throw new AppError("后台写入已交接。", 409, undefined, "LEASE_LOST");
  }
  save(
    claim: TransferClaim,
    status: TransferJobSummary["status"] = "running",
    error = "",
    resumeAt = 0,
  ) {
    this.store.transaction(() => {
      this.check(claim);
      const { state } = claim;
      this.store.db
        .prepare(
          `UPDATE transfer_jobs SET data=?,status=?,error=?,resume_at=?,
        lease=CASE WHEN ?='running' THEN lease ELSE '' END,
        lease_until=CASE WHEN ?='running' THEN lease_until ELSE 0 END WHERE task_id=? AND lease=?`,
        )
        .run(
          JSON.stringify(state),
          status,
          error,
          resumeAt,
          status,
          status,
          claim.id,
          claim.lease,
        );
      const result = state.playlistId
        ? {
            id: state.playlistId,
            url: `https://open.spotify.com/playlist/${state.playlistId}`,
            added: state.added,
            total: state.uris.length,
            complete: status === "complete",
            ...(error ? { error } : {}),
          }
        : null;
      this.store.db
        .prepare(
          "UPDATE tasks SET workspace=json_set(workspace,'$.result',json(?)),updated_at=MAX(updated_at+1,?) WHERE id=?",
        )
        .run(JSON.stringify(result), this.store.now(), claim.id);
    });
  }
}

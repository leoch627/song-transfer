import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { TaskStore } from "./task-store";
import type { AiJobSummary } from "./task-types";
import type { AiReviewResponse, AiSearchCheckpoint, Match } from "./types";
import { AppError } from "./http";
import { needsAiReview } from "./matching";

export type AiClaim = {
  taskId: string;
  owner: string;
  index: number;
  lease: string;
  match: Match;
  forceSearch: boolean;
  checkpoint?: AiSearchCheckpoint;
};
const LEASE_MS = 120000;

export class AiTaskQueue {
  constructor(readonly store: TaskStore) {}
  static initialize(db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS ai_jobs (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      status TEXT NOT NULL, resume_at INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS ai_job_songs (
      task_id TEXT NOT NULL REFERENCES ai_jobs(task_id) ON DELETE CASCADE,
      position INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', force_search INTEGER NOT NULL DEFAULT 0,
      lease TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(task_id,position));
      CREATE TABLE IF NOT EXISTS ai_cooldown (id INTEGER PRIMARY KEY CHECK(id=1), until_at INTEGER NOT NULL);`);
    db.exec("BEGIN IMMEDIATE");
    try {
      const columns = db.prepare("PRAGMA table_info(ai_job_songs)").all() as { name: string }[];
      if (!columns.some((c) => c.name === "error"))
        db.exec("ALTER TABLE ai_job_songs ADD COLUMN error TEXT NOT NULL DEFAULT ''");
      if (!columns.some((c) => c.name === "search_checkpoint"))
        db.exec("ALTER TABLE ai_job_songs ADD COLUMN search_checkpoint TEXT");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  summary(id: string): AiJobSummary | null {
    const db = this.store.db;
    const row = db
      .prepare("SELECT status,resume_at,error FROM ai_jobs WHERE task_id=?")
      .get(id) as
      | { status: AiJobSummary["status"]; resume_at: number; error: string }
      | undefined;
    if (!row) return null;
    const counts = db
      .prepare(
        "SELECT COUNT(*) AS total,COALESCE(SUM(state='done'),0) AS completed FROM ai_job_songs WHERE task_id=?",
      )
      .get(id) as { total: number; completed: number };
    const active = db
      .prepare(
        `SELECT json_extract(s.source,'$.name') AS name FROM ai_job_songs j
      JOIN task_songs s ON s.task_id=j.task_id AND s.position=j.position
      WHERE j.task_id=? AND j.state='running' AND j.lease_until>? ORDER BY j.position`,
      )
      .all(id, this.store.now()) as { name: string }[];
    const blocked = db.prepare(`SELECT j.position AS 'index', json_extract(s.source,'$.name') AS name,j.error
      FROM ai_job_songs j JOIN task_songs s ON s.task_id=j.task_id AND s.position=j.position
      WHERE j.task_id=? AND j.state='blocked' ORDER BY j.position`).all(id) as AiJobSummary["blocked"];
    const searching = db.prepare(`SELECT j.position AS 'index',json_extract(s.source,'$.name') AS name,
      json_array_length(json_extract(j.search_checkpoint,'$.searches')) AS completed,
      json_extract(j.search_checkpoint,'$.pending.query') AS query
      FROM ai_job_songs j JOIN task_songs s ON s.task_id=j.task_id AND s.position=j.position
      WHERE j.task_id=? AND j.state IN ('pending','running') AND j.search_checkpoint IS NOT NULL
      ORDER BY j.position LIMIT 5`).all(id) as AiJobSummary["searching"];
    return {
      status: row.status,
      ...counts,
      current: active.map((s) => s.name),
      resumeAt: row.resume_at,
      error: row.error,
      blocked,
      searching,
    };
  }
  touch(id: string) {
    this.store.db
      .prepare("UPDATE tasks SET updated_at=MAX(updated_at+1,?) WHERE id=?")
      .run(this.store.now(), id);
  }
  start(id: string, owner: string, indices?: number[], forceSearch = false, all = false) {
    return this.store.transaction(() => {
      const task = this.store.get(id, owner);
      if (task.workspace.writeStarted)
        throw new AppError("任务已开始迁移，不能再复核。", 409);
      if (all && task.completed !== task.total)
        throw new AppError("请等基础匹配完成，再联网复核全部歌曲。", 409);
      const positions =
        (all ? task.matches.map((_, index) => index) : indices) ??
        task.matches.flatMap((m, i) => (needsAiReview(m) ? [i] : []));
      if (
        positions.some(
          (i) =>
            !Number.isInteger(i) ||
            !task.matches[i] ||
            task.matches[i].status === "pending",
        )
      )
        throw new AppError("请选择已匹配的有效歌曲。", 400);
      const db = this.store.db;
      const old = this.summary(id);
      if (all && old && (old.current.length || ["queued", "running", "waiting"].includes(old.status)))
        throw new AppError("请先暂停当前复核，等待在途结果保存后再全量联网复核。", 409);
      if (!positions.length && (!old || old.completed === old.total))
        throw new AppError("没有待复核的歌曲。", 400);
      // A finished batch starts a fresh counter; paused/failed batches retain checkpoints.
      // Explicit selections must not resume songs from a previously paused batch.
      // Completed reviews remain in task_songs until each replacement succeeds.
      if (all || (indices && old && !old.current.length && !["queued", "running", "waiting"].includes(old.status)) ||
          (old?.status === "complete" && !old.blocked.length))
        db.prepare("DELETE FROM ai_jobs WHERE task_id=?").run(id);
      db.prepare(
        `INSERT INTO ai_jobs(task_id,status) VALUES(?,'queued') ON CONFLICT(task_id)
        DO UPDATE SET status='queued',resume_at=0,error=''`,
      ).run(id);
      const insert =
        db.prepare(`INSERT INTO ai_job_songs(task_id,position,force_search) VALUES(?,?,?)
        ON CONFLICT(task_id,position) DO UPDATE SET state='pending',force_search=excluded.force_search,error='',search_checkpoint=NULL
        WHERE ai_job_songs.state IN ('done','blocked') AND ?=1`);
      for (const index of new Set(positions))
        insert.run(id, index, Number(forceSearch || all), Number(!!indices || all));
      // Only an explicit user resume retries evidence-blocked songs. Normal claims skip them.
      if (!indices)
        db.prepare("UPDATE ai_job_songs SET state='pending',error='',search_checkpoint=NULL WHERE task_id=? AND state='blocked'").run(id);
      const cooldown = db
        .prepare("SELECT until_at FROM ai_cooldown WHERE id=1")
        .get() as { until_at: number } | undefined;
      if (cooldown && cooldown.until_at > this.store.now())
        db.prepare(
          "UPDATE ai_jobs SET status='waiting',resume_at=?,error='AI 暂时限流，到时自动继续。' WHERE task_id=?",
        ).run(cooldown.until_at, id);
      this.touch(id);
      return this.summary(id);
    });
  }
  pause(id: string, owner: string) {
    this.store.transaction(() => {
      this.store.get(id, owner);
      this.store.db
        .prepare(
          "UPDATE ai_jobs SET status='paused',error='',resume_at=0 WHERE task_id=? AND status!='complete'",
        )
        .run(id);
      this.touch(id);
    });
  }
  claim(limit: number): AiClaim | null {
    return this.store.transaction(() => {
      const db = this.store.db,
        now = this.store.now();
      const cooldown = db
        .prepare("SELECT until_at FROM ai_cooldown WHERE id=1")
        .get() as { until_at: number } | undefined;
      if (cooldown && cooldown.until_at > now) return null;
      const active = db
        .prepare(
          "SELECT COUNT(*) AS n FROM ai_job_songs WHERE state='running' AND lease_until>?",
        )
        .get(now) as { n: number };
      if (active.n >= limit) return null;
      const item = db
        .prepare(
          `SELECT j.task_id AS taskId,j.position AS idx,t.owner,s.match,j.force_search AS forceSearch,j.search_checkpoint AS checkpoint
        FROM ai_job_songs j JOIN ai_jobs a ON a.task_id=j.task_id JOIN tasks t ON t.id=j.task_id
        JOIN task_songs s ON s.task_id=j.task_id AND s.position=j.position
        WHERE a.status IN ('queued','running','waiting') AND a.resume_at<=? AND j.state IN ('pending','running') AND j.lease_until<=?
        AND COALESCE(json_extract(t.workspace,'$.writeStarted'),0)=0
        ORDER BY t.updated_at,j.position LIMIT 1`,
        )
        .get(now, now) as
        | {
            taskId: string;
            idx: number;
            owner: string;
            match: string;
            forceSearch: number;
            checkpoint: string | null;
          }
        | undefined;
      if (!item) return null;
      const lease = randomUUID();
      db.prepare(
        "UPDATE ai_job_songs SET state='running',lease=?,lease_until=?,error='' WHERE task_id=? AND position=?",
      ).run(lease, now + LEASE_MS, item.taskId, item.idx);
      db.prepare(
        "UPDATE ai_jobs SET status='running',resume_at=0,error='' WHERE task_id=?",
      ).run(item.taskId);
      this.touch(item.taskId);
      return {
        taskId: item.taskId,
        owner: item.owner,
        index: item.idx,
        lease,
        match: JSON.parse(item.match),
        forceSearch: !!item.forceSearch,
        checkpoint: item.checkpoint ? JSON.parse(item.checkpoint) : undefined,
      };
    });
  }
  renew(item: AiClaim) {
    this.store.db
      .prepare(
        "UPDATE ai_job_songs SET lease_until=? WHERE task_id=? AND position=? AND lease=? AND state='running'",
      )
      .run(this.store.now() + LEASE_MS, item.taskId, item.index, item.lease);
  }
  checkpoint(item: AiClaim, progress: AiSearchCheckpoint) {
    this.store.transaction(() => {
      const saved = this.store.db.prepare(`UPDATE ai_job_songs SET search_checkpoint=?
        WHERE task_id=? AND position=? AND lease=? AND state='running'`).run(JSON.stringify(progress), item.taskId, item.index, item.lease);
      if (!saved.changes) throw new AppError("复核任务已被其他工作进程接管。", 409);
      this.touch(item.taskId);
    });
  }
  complete(item: AiClaim, result: AiReviewResponse) {
    // Result and queue checkpoint share one transaction, including manual-choice preservation.
    this.store.saveAiReview(item.taskId, item.owner, item.index, result, () => {
      const db = this.store.db;
      const saved = db
        .prepare(
          "UPDATE ai_job_songs SET state='done',lease='',lease_until=0,error='' WHERE task_id=? AND position=? AND lease=? AND state='running'",
        )
        .run(item.taskId, item.index, item.lease);
      if (!saved.changes)
        throw new AppError("复核任务已被其他工作进程接管。", 409);
      this.finishIfDrained(item.taskId);
      this.touch(item.taskId);
    }, true);
  }
  private finishIfDrained(id: string) {
    this.store.db.prepare(`UPDATE ai_jobs SET status='complete',error='',resume_at=0 WHERE task_id=?
      AND NOT EXISTS (SELECT 1 FROM ai_job_songs WHERE task_id=? AND state IN ('pending','running'))`).run(id, id);
  }
  fail(item: AiClaim, error: unknown) {
    this.store.transaction(() => {
      const db = this.store.db;
      const known = error instanceof AppError;
      const noEvidence = known && error.reason === "AI_RESEARCH_NO_SOURCES";
      const released = db
        .prepare(
          "UPDATE ai_job_songs SET state=?,lease='',lease_until=0,error=? WHERE task_id=? AND position=? AND lease=? AND state='running'",
        )
        .run(noEvidence ? "blocked" : "pending", known ? error.message : "AI 请求未完成，请重试。", item.taskId, item.index, item.lease);
      if (!released.changes) return;
      if (noEvidence) {
        // Preserve the song's existing result/manual selection; a failed research is not a review.
        this.finishIfDrained(item.taskId);
        this.touch(item.taskId);
        return;
      }
      const wait = known && error.status === 429;
      const resume = wait
        ? this.store.now() + (error.retryAfter || 60) * 1000
        : 0;
      if (wait && error.reason !== "SPOTIFY_SEARCH_RATE_LIMITED")
        db.prepare(
          `INSERT INTO ai_cooldown VALUES(1,?) ON CONFLICT(id) DO UPDATE SET until_at=MAX(until_at,excluded.until_at)`,
        ).run(resume);
      db.prepare(
        `UPDATE ai_jobs SET status=?,resume_at=MAX(resume_at,?),error=? WHERE task_id=? AND status!='paused'`,
      ).run(
        wait
          ? "waiting"
          : known && error.status === 401
            ? "needs_auth"
            : "failed",
        resume,
        `《${item.match.source.name}》：${known
          ? error.message
          : "AI 请求未完成，已保存进度，点击继续复核可重试。"}`,
        item.taskId,
      );
      this.touch(item.taskId);
    });
  }
}

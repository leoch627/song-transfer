import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AppError } from "./http";
import { seal, unseal } from "./crypto";
import type { Session } from "./auth";
import type { AiReviewResponse, Match, Playlist, Song } from "./types";
import { applyAiReview, reconcileMatch } from "./matching";
import type {
  QuotaStatus,
  TaskSummary,
  TaskWorkspace,
  TransferTask,
} from "./task-types";
import type { SearchCheckpoint, TransferResult } from "./spotify";
import { AiTaskQueue } from "./ai-task-queue";

export const DAY = 86400000;
type Row = {
  id: string;
  owner: string;
  playlist: string;
  workspace: string;
  status: TaskSummary["status"];
  resume_at: number;
  error: string;
  created_at: number;
  updated_at: number;
  lease: string;
  lease_until: number;
};
export type ClaimedTask = { id: string; owner: string; lease: string };
export const songKey = (song: Song) =>
  createHash("sha256")
    .update(
      JSON.stringify([song.name, song.artists, song.album, song.durationMs]),
    )
    .digest("hex");

export class TaskStore {
  db: DatabaseSync;
  constructor(
    path: string,
    readonly now: () => number = Date.now,
  ) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, playlist TEXT NOT NULL,
        workspace TEXT NOT NULL, status TEXT NOT NULL, resume_at INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        lease TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(owner);
      CREATE TABLE IF NOT EXISTS task_songs (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, source TEXT NOT NULL, match TEXT, checkpoint TEXT,
        PRIMARY KEY (task_id, position));
      CREATE TABLE IF NOT EXISTS search_cache (owner TEXT NOT NULL, song_key TEXT NOT NULL, match TEXT NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY(owner,song_key));
      CREATE TABLE IF NOT EXISTS search_usage (at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS search_usage_at ON search_usage(at);
      CREATE TABLE IF NOT EXISTS search_cooldown (id INTEGER PRIMARY KEY CHECK(id=1), until_at INTEGER NOT NULL, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_accounts (owner TEXT PRIMARY KEY, credentials TEXT NOT NULL,
        refresh_lease TEXT NOT NULL DEFAULT '', refresh_until INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS web_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_attempts (scope TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS auth_attempts_scope ON auth_attempts(scope,at);
      CREATE TABLE IF NOT EXISTS task_migrations (name TEXT PRIMARY KEY);`);
    AiTaskQueue.initialize(this.db);
    this.transaction(() => {
      const migration = this.db
        .prepare("INSERT OR IGNORE INTO task_migrations(name) VALUES(?)")
        .run("spotify-managed-search-limits");
      if (!migration.changes) return;
      // Old waiting tasks combined a local daily budget with Spotify's cooldown.
      // Release only the local wait; all song data and real cooldowns stay intact.
      const { resumeAt } = this.quota();
      this.db
        .prepare(
          `UPDATE tasks SET status=?,resume_at=?,error=?,updated_at=?
          WHERE status='waiting'`,
        )
        .run(
          resumeAt ? "waiting" : "queued",
          resumeAt,
          resumeAt ? "Spotify 暂时限流，到时自动重试。" : "",
          this.now(),
        );
    });
    this.applySavedAiSelections();
  }
  applySavedAiSelections() {
    return this.transaction(() => {
      const migrated = this.db
        .prepare("INSERT OR IGNORE INTO task_migrations(name) VALUES(?)")
        .run("ai-auto-selection-v1");
      if (!migrated.changes) return { updated: 0, selected: 0 };
      const rows = this.db
        .prepare(
          `SELECT s.task_id,s.position,s.match FROM task_songs s JOIN tasks t ON t.id=s.task_id
        WHERE s.match IS NOT NULL AND COALESCE(json_extract(t.workspace,'$.writeStarted'),0)=0`,
        )
        .all() as { task_id: string; position: number; match: string }[];
      let updated = 0,
        selected = 0;
      for (const row of rows) {
        const match = reconcileMatch(JSON.parse(row.match));
        if (JSON.stringify(match) === row.match) continue;
        this.db
          .prepare(
            "UPDATE task_songs SET match=? WHERE task_id=? AND position=?",
          )
          .run(JSON.stringify(match), row.task_id, row.position);
        this.db
          .prepare("UPDATE tasks SET updated_at=? WHERE id=?")
          .run(this.now(), row.task_id);
        updated++;
        if (match.aiSelected) selected++;
      }
      return { updated, selected };
    });
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  quota(): QuotaStatus {
    const now = this.now();
    const usage = this.db
      .prepare("SELECT COUNT(*) AS used FROM search_usage WHERE at > ?")
      .get(now - DAY) as { used: number };
    const cooldown = this.db
      .prepare("SELECT until_at, reason FROM search_cooldown WHERE id=1")
      .get() as { until_at: number; reason: string } | undefined;
    const resumeAt =
      cooldown && cooldown.until_at > now ? cooldown.until_at : 0;
    return {
      limit: null,
      used: usage.used,
      remaining: null,
      resumeAt,
      reason: resumeAt ? cooldown!.reason : "",
    };
  }
  reserveSearch() {
    this.transaction(() => {
      const q = this.quota();
      if (q.resumeAt > this.now())
        throw new AppError(
          "Spotify 暂时限流，任务会在等待结束后自动重试。",
          429,
          Math.max(1, Math.ceil((q.resumeAt - this.now()) / 1000)),
          q.reason,
        );
      this.db
        .prepare("DELETE FROM search_usage WHERE at <= ?")
        .run(this.now() - DAY);
      this.db.prepare("INSERT INTO search_usage(at) VALUES(?)").run(this.now());
    });
  }
  cooldown(seconds: number, reason: string) {
    this.db
      .prepare(
        `INSERT INTO search_cooldown VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET
      until_at=MAX(until_at,excluded.until_at),reason=excluded.reason`,
      )
      .run(this.now() + Math.max(1, seconds) * 1000, reason);
  }
  saveAccount(owner: string, session: Session) {
    const secret = process.env.SESSION_SECRET;
    if (!secret || secret.length < 32)
      throw new AppError("会话密钥未配置。", 503);
    this.db
      .prepare(
        `INSERT INTO task_accounts(owner,credentials) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET
      credentials=excluded.credentials,refresh_lease='',refresh_until=0`,
      )
      .run(owner, seal(session, secret, 30 * 86400));
  }
  account(owner: string) {
    const row = this.db
      .prepare("SELECT credentials FROM task_accounts WHERE owner=?")
      .get(owner) as { credentials: string } | undefined;
    return row
      ? unseal<Session>(row.credentials, process.env.SESSION_SECRET || "")
      : null;
  }
  acquireRefresh(owner: string) {
    const lease = randomUUID();
    const result = this.db
      .prepare(
        "UPDATE task_accounts SET refresh_lease=?,refresh_until=? WHERE owner=? AND refresh_until<=?",
      )
      .run(lease, this.now() + 30000, owner, this.now());
    return result.changes ? lease : null;
  }
  finishRefresh(owner: string, lease: string, session: Session) {
    return (
      this.db
        .prepare(
          "UPDATE task_accounts SET credentials=?,refresh_lease='',refresh_until=0 WHERE owner=? AND refresh_lease=?",
        )
        .run(
          seal(session, process.env.SESSION_SECRET!, 30 * 86400),
          owner,
          lease,
        ).changes > 0
    );
  }
  releaseRefresh(owner: string, lease: string) {
    this.db
      .prepare(
        "UPDATE task_accounts SET refresh_until=0,refresh_lease='' WHERE owner=? AND refresh_lease=?",
      )
      .run(owner, lease);
  }
  disconnect(owner: string) {
    this.transaction(() => {
      this.db.prepare("DELETE FROM task_accounts WHERE owner=?").run(owner);
      this.db
        .prepare(
          "UPDATE tasks SET updated_at=MAX(updated_at+1,?) WHERE owner=? AND id IN (SELECT task_id FROM ai_jobs WHERE status IN ('queued','running','waiting'))",
        )
        .run(this.now(), owner);
      this.db
        .prepare(
          `UPDATE ai_jobs SET status='needs_auth',error='Spotify 已断开，请重新连接后继续复核。'
        WHERE task_id IN (SELECT id FROM tasks WHERE owner=?) AND status IN ('queued','running','waiting')`,
        )
        .run(owner);
      this.db
        .prepare(
          "UPDATE tasks SET status='needs_auth',error='Spotify 已断开，请重新连接后继续。',updated_at=? WHERE owner=? AND status IN ('running','queued','waiting')",
        )
        .run(this.now(), owner);
    });
  }
  create(
    owner: string,
    playlist: Playlist,
    matches: (Match | null)[],
    id: string = randomUUID(),
  ) {
    return this.transaction(() => {
      if (
        this.db
          .prepare("SELECT id FROM tasks WHERE id=? AND owner=?")
          .get(id, owner)
      )
        return id;
      const active = this.db
        .prepare("SELECT COUNT(*) AS n FROM tasks WHERE owner=?")
        .get(owner) as { n: number };
      if (active.n >= 20)
        throw new AppError("最多保存 20 个任务，请先删除不再需要的任务。", 409);
      const now = this.now();
      const { songs, ...metadata } = playlist;
      this.db
        .prepare(
          "INSERT INTO tasks(id,owner,playlist,workspace,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id,
          owner,
          JSON.stringify(metadata),
          JSON.stringify({
            name: playlist.name,
            isPublic: false,
            result: null,
            writeStarted: false,
          }),
          "queued",
          now,
          now,
        );
      const insert = this.db.prepare(
        "INSERT INTO task_songs(task_id,position,source,match) VALUES(?,?,?,?)",
      );
      songs.forEach((source, i) =>
        insert.run(
          id,
          i,
          JSON.stringify(source),
          matches[i] ? JSON.stringify(matches[i]) : null,
        ),
      );
      return id;
    });
  }
  owned(id: string, owner: string): Row {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id=? AND owner=?")
      .get(id, owner) as Row | undefined;
    if (!row) throw new AppError("任务不存在或无权访问。", 404);
    return row;
  }
  summary(row: Row): TaskSummary {
    const counts = this.db
      .prepare(
        `SELECT COUNT(*) AS total, COUNT(match) AS completed,
        COUNT(json_extract(match,'$.aiReview.decision')) AS aiReviewed,
        COALESCE(SUM(json_extract(match,'$.aiReview.decision')='match'),0) AS aiMatched,
        COALESCE(SUM(json_extract(match,'$.aiReview.decision')='skip'),0) AS aiSkipped,
        COALESCE(SUM(json_extract(match,'$.aiReview.decision')='uncertain'),0) AS aiUncertain
        FROM task_songs WHERE task_id=?`,
      )
      .get(row.id) as Pick<
      TaskSummary,
      | "total"
      | "completed"
      | "aiReviewed"
      | "aiMatched"
      | "aiSkipped"
      | "aiUncertain"
    >;
    return {
      id: row.id,
      aiJob: new AiTaskQueue(this).summary(row.id),
      name: JSON.parse(row.workspace).name,
      status: row.status,
      ...counts,
      resumeAt: row.resume_at,
      error: row.error,
      updatedAt: row.updated_at,
    };
  }
  list(owner: string) {
    return (
      this.db
        .prepare("SELECT * FROM tasks WHERE owner=? ORDER BY created_at DESC")
        .all(owner) as Row[]
    ).map((row) => this.summary(row));
  }
  get(id: string, owner: string): TransferTask {
    const row = this.owned(id, owner);
    const songs = this.db
      .prepare(
        "SELECT source,match FROM task_songs WHERE task_id=? ORDER BY position",
      )
      .all(id) as { source: string; match: string | null }[];
    return {
      ...this.summary(row),
      playlist: {
        ...JSON.parse(row.playlist),
        songs: songs.map((s) => JSON.parse(s.source)),
      },
      matches: songs.map((s) =>
        s.match
          ? JSON.parse(s.match)
          : {
              source: JSON.parse(s.source),
              candidates: [],
              selected: null,
              status: "pending",
              included: false,
            },
      ),
      workspace: JSON.parse(row.workspace),
    };
  }
  control(id: string, owner: string, action: "pause" | "resume" | "delete") {
    this.transaction(() => {
      this.owned(id, owner);
      if (action === "delete") {
        this.db
          .prepare("DELETE FROM tasks WHERE id=? AND owner=?")
          .run(id, owner);
        return;
      }
      const status = action === "pause" ? "paused" : "queued";
      // Keep an in-flight worker's lease until it returns, so resume cannot race it.
      this.db
        .prepare(
          "UPDATE tasks SET status=?,error='',resume_at=0,updated_at=? WHERE id=?",
        )
        .run(status, this.now(), id);
    });
  }
  save(
    id: string,
    owner: string,
    updates: { index: number; match: Match }[],
    workspace?: TaskWorkspace,
  ) {
    this.transaction(() => {
      const original = JSON.parse(
        this.owned(id, owner).workspace,
      ) as TaskWorkspace;
      for (const { index, match } of updates)
        this.db
          .prepare(
            "UPDATE task_songs SET match=? WHERE task_id=? AND position=? AND match IS NOT NULL",
          )
          .run(JSON.stringify(match), id, index);
      if (workspace)
        this.db
          .prepare("UPDATE tasks SET workspace=?,updated_at=? WHERE id=?")
          .run(
            JSON.stringify({
              ...workspace,
              result: original.result,
              writeStarted: original.writeStarted,
            }),
            this.now(),
            id,
          );
      else if (updates.length)
        this.db
          .prepare("UPDATE tasks SET updated_at=? WHERE id=?")
          .run(this.now(), id);
    });
  }
  saveAiReview(
    id: string,
    owner: string,
    index: number,
    result: AiReviewResponse,
    afterSave?: () => void,
  ) {
    return this.transaction(() => {
      const task = this.get(id, owner);
      const match = task.matches[index];
      if (task.workspace.writeStarted || !match || match.status === "pending")
        throw new AppError(
          "歌曲尚未匹配或任务已开始迁移，复核结果未应用。",
          409,
        );
      const { candidates: incoming, ...review } = result;
      delete review.excludedCandidates;
      const candidates = [...(incoming || match.candidates)];
      // Preserve a manual selection made while the network request was in flight.
      if (
        match.confirmedByUser &&
        match.selected &&
        !candidates.some((c) => c.id === match.selected!.id)
      ) {
        if (candidates.length >= 5)
          candidates.splice(
            candidates.findLastIndex((c) => c.id !== review.candidateId),
            1,
          );
        candidates.push(match.selected);
      }
      // Keep candidates removed by filtering or supplemental searches inspectable.
      const archive = new Map<string, Match["candidates"][number]>();
      for (const candidate of [
        ...(match.excludedCandidates || []),
        ...match.candidates,
      ])
        if (!candidates.some((c) => c.id === candidate.id))
          archive.set(candidate.id, candidate);
      const excludedCandidates = [...archive.values()];
      const updated = applyAiReview(
        { ...match, candidates, excludedCandidates },
        review,
      );
      this.db
        .prepare("UPDATE task_songs SET match=? WHERE task_id=? AND position=?")
        .run(JSON.stringify(updated), id, index);
      this.db
        .prepare("UPDATE tasks SET updated_at=? WHERE id=?")
        .run(this.now(), id);
      afterSave?.();
      return { ...review, candidates, excludedCandidates };
    });
  }
  beginTransfer(id: string, owner: string) {
    return this.transaction(() => {
      const task = this.get(id, owner);
      if (task.workspace.writeStarted)
        throw new AppError(
          "这个任务已经开始迁移，请先检查已保存结果和 Spotify 歌单，避免重复写入。",
          409,
        );
      if (task.completed !== task.total)
        throw new AppError("请等待全部歌曲匹配完成。", 409);
      if (
        task.aiJob &&
        (task.aiJob.current.length ||
          ["queued", "running", "waiting"].includes(task.aiJob.status))
      )
        throw new AppError(
          "请等待 AI 复核完成，或暂停复核并等待在途结果保存后再迁移。",
          409,
        );
      const uris = task.matches
        .filter((m) => m.included && m.selected && m.status === "matched")
        .map((m) => m.selected!.uri);
      if (!uris.length || !task.workspace.name.trim())
        throw new AppError("请填写歌单名称并选择歌曲。");
      this.db
        .prepare("UPDATE tasks SET workspace=?,updated_at=? WHERE id=?")
        .run(
          JSON.stringify({ ...task.workspace, writeStarted: true }),
          this.now(),
          id,
        );
      return {
        name: task.workspace.name,
        isPublic: task.workspace.isPublic,
        uris,
      };
    });
  }
  finishTransfer(
    id: string,
    owner: string,
    result: TransferResult | null,
    knownNotWritten = false,
  ) {
    this.transaction(() => {
      const workspace = JSON.parse(
        this.owned(id, owner).workspace,
      ) as TaskWorkspace;
      this.db
        .prepare("UPDATE tasks SET workspace=?,updated_at=? WHERE id=?")
        .run(
          JSON.stringify({
            ...workspace,
            result,
            writeStarted: !knownNotWritten,
          }),
          this.now(),
          id,
        );
    });
  }
  claim(): ClaimedTask | null {
    return this.transaction(() => {
      const now = this.now();
      const row = this.db
        .prepare(
          `SELECT * FROM tasks WHERE status IN ('queued','running','waiting') AND
        resume_at<=? AND lease_until<=? ORDER BY updated_at,created_at LIMIT 1`,
        )
        .get(now, now) as Row | undefined;
      if (!row) return null;
      const lease = randomUUID();
      this.db
        .prepare(
          "UPDATE tasks SET status='running',resume_at=0,error='',lease=?,lease_until=?,updated_at=? WHERE id=?",
        )
        .run(lease, now + 120000, now, row.id);
      return { id: row.id, owner: row.owner, lease };
    });
  }
  runnable(task: ClaimedTask) {
    return !!this.db
      .prepare(
        "SELECT id FROM tasks WHERE id=? AND lease=? AND status IN ('running','queued')",
      )
      .get(task.id, task.lease);
  }
  nextSong(task: ClaimedTask) {
    const row = this.db
      .prepare(
        "SELECT position,source,checkpoint FROM task_songs WHERE task_id=? AND match IS NULL ORDER BY position LIMIT 1",
      )
      .get(task.id) as
      | { position: number; source: string; checkpoint: string | null }
      | undefined;
    return row
      ? {
          index: row.position,
          source: JSON.parse(row.source) as Song,
          checkpoint: row.checkpoint
            ? (JSON.parse(row.checkpoint) as SearchCheckpoint)
            : undefined,
        }
      : null;
  }
  checkpoint(task: ClaimedTask, index: number, value: SearchCheckpoint) {
    this.db
      .prepare(
        "UPDATE task_songs SET checkpoint=? WHERE task_id=? AND position=? AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND lease=?)",
      )
      .run(JSON.stringify(value), task.id, index, task.id, task.lease);
  }
  cached(owner: string, source: Song): Match | null {
    const row = this.db
      .prepare(
        "SELECT match FROM search_cache WHERE owner=? AND song_key=? AND updated_at>?",
      )
      .get(owner, songKey(source), this.now() - 30 * DAY) as
      | { match: string }
      | undefined;
    return row ? reconcileMatch({ ...JSON.parse(row.match), source }) : null;
  }
  completeSong(task: ClaimedTask, index: number, match: Match) {
    this.transaction(() => {
      const exists = this.db
        .prepare("SELECT id FROM tasks WHERE id=? AND lease=?")
        .get(task.id, task.lease);
      if (!exists) return;
      this.db
        .prepare(
          "UPDATE task_songs SET match=?,checkpoint=NULL WHERE task_id=? AND position=?",
        )
        .run(JSON.stringify(match), task.id, index);
      this.db
        .prepare(
          "INSERT INTO search_cache VALUES(?,?,?,?) ON CONFLICT(owner,song_key) DO UPDATE SET match=excluded.match,updated_at=excluded.updated_at",
        )
        .run(
          task.owner,
          songKey(match.source),
          JSON.stringify(match),
          this.now(),
        );
      this.db
        .prepare("DELETE FROM search_cache WHERE updated_at<=?")
        .run(this.now() - 30 * DAY);
    });
  }
  finish(
    task: ClaimedTask,
    status: TaskSummary["status"],
    resumeAt = 0,
    error = "",
  ) {
    this.db
      .prepare(
        `UPDATE tasks SET status=CASE WHEN status IN ('running','queued') THEN ? ELSE status END,
      resume_at=CASE WHEN status IN ('running','queued') THEN ? ELSE resume_at END,
      error=CASE WHEN status IN ('running','queued') THEN ? ELSE error END,
      lease='',lease_until=0,updated_at=? WHERE id=? AND lease=?`,
      )
      .run(status, resumeAt, error, this.now(), task.id, task.lease);
  }
  close() {
    this.db.close();
  }
}

let instance: TaskStore | undefined;
export function taskStore() {
  return (instance ||= new TaskStore(
    resolve(process.env.SONGTRANSFER_DATA_DIR || "data", "tasks.sqlite"),
  ));
}

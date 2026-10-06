import type { Match, Playlist } from "./types";
import type { TransferResult } from "./spotify";

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "needs_auth"
  | "failed"
  | "complete";
export type QuotaStatus = {
  limit: null;
  used: number;
  remaining: null;
  resumeAt: number;
  reason: string;
};
export type TaskSummary = {
  aiJob?: AiJobSummary | null;
  id: string;
  name: string;
  status: TaskStatus;
  total: number;
  completed: number;
  aiReviewed: number;
  aiMatched: number;
  aiSkipped: number;
  aiUncertain: number;
  resumeAt: number;
  error: string;
  updatedAt: number;
};
export type AiJobSummary = {
  searching: { index: number; name: string; completed: number; query: string | null }[];
  blocked: { index: number; name: string; error: string }[];
  status:
    | "queued"
    | "running"
    | "waiting"
    | "paused"
    | "failed"
    | "needs_auth"
    | "complete";
  total: number;
  completed: number;
  current: string[];
  resumeAt: number;
  error: string;
};
export const aiJobLabels: Record<AiJobSummary["status"], string> = {
  queued: "等待处理",
  running: "后台复核中",
  waiting: "等待限流恢复",
  paused: "已暂停",
  failed: "处理暂停",
  needs_auth: "请重新连接 Spotify",
  complete: "本轮完成",
};
export type TaskWorkspace = {
  name: string;
  isPublic: boolean;
  result: TransferResult | null;
  writeStarted: boolean;
};
export type TransferTask = TaskSummary & {
  playlist: Playlist;
  matches: Match[];
  workspace: TaskWorkspace;
};
export const taskLabels: Record<TaskStatus, string> = {
  queued: "等待处理",
  running: "后台匹配中",
  waiting: "等待额度恢复",
  paused: "已暂停",
  needs_auth: "需要重新连接 Spotify",
  failed: "处理暂停，请重试",
  complete: "匹配完成",
};

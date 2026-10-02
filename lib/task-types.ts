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
  limit: number;
  used: number;
  remaining: number;
  resumeAt: number;
  reason: string;
};
export type TaskSummary = {
  id: string;
  name: string;
  status: TaskStatus;
  total: number;
  completed: number;
  resumeAt: number;
  error: string;
  updatedAt: number;
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

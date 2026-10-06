"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Match, Playlist } from "@/lib/types";
import { mergeTaskSnapshot } from "@/lib/task-sync";
import type {
  QuotaStatus,
  TaskSummary,
  TaskWorkspace,
  TransferTask,
} from "@/lib/task-types";

type Options = {
  hydrated: boolean;
  accountId: string | null;
  id: string | null;
  playlist: Playlist | null;
  matches: Match[];
  workspace: TaskWorkspace;
  setId: (id: string | null) => void;
  onLoad: (task: TransferTask, merge: boolean) => void;
  onError: (error: unknown) => void;
};
type TaskResponse = { task: TransferTask; quota: QuotaStatus };
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "任务暂时无法同步，请稍后重试。");
  return data;
}

export function useTaskQueue(options: Options) {
  const state = useRef(options);
  useEffect(() => {
    state.current = options;
  });
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [task, setTask] = useState<TransferTask | null>(null);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [syncError, setSyncError] = useState("");
  const baseline = useRef<{
    id: string;
    matches: Match[];
    workspace: TaskWorkspace;
  } | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const loading = useRef(false);

  const save = useCallback(async (override?: Partial<TaskWorkspace>) => {
    const current = state.current;
    if (!current.id || baseline.current?.id !== current.id) return;
    const id = current.id,
      matches = current.matches,
      workspace = { ...current.workspace, ...override };
    const run = async () => {
      const previous = baseline.current;
      if (previous?.id !== id) return;
      const updates = matches.flatMap((match, index) =>
        match.status !== "pending" &&
        previous.matches[index]?.status !== "pending" &&
        JSON.stringify(match) !== JSON.stringify(previous.matches[index])
          ? [{ index, match }]
          : [],
      );
      if (
        !updates.length &&
        JSON.stringify(workspace) === JSON.stringify(previous.workspace)
      )
        return;
      await request(`/api/tasks/${id}`, {
        action: "save",
        updates,
        workspace:
          JSON.stringify(workspace) !== JSON.stringify(previous.workspace)
            ? workspace
            : undefined,
      });
      if (baseline.current?.id === id) {
        const next = [...baseline.current.matches];
        for (const { index, match } of updates) next[index] = match;
        baseline.current = { id, matches: next, workspace };
      }
      setSyncError("");
    };
    const promise = saveChain.current.catch(() => {}).then(run);
    saveChain.current = promise;
    try {
      await promise;
    } catch (error) {
      setSyncError("修改尚未同步到服务器，已保留在此浏览器。请点击重试保存。");
      throw error;
    }
  }, []);

  const load = useCallback(async (id: string, merge: boolean) => {
    const data = await request<TaskResponse>(`/api/tasks/${id}`);
    if (merge && state.current.id !== id) return data.task;
    const snapshot = merge
      ? mergeTaskSnapshot(
          data.task,
          {
            matches: state.current.matches,
            workspace: state.current.workspace,
          },
          baseline.current?.id === id ? baseline.current : null,
        )
      : data.task;
    baseline.current = {
      id,
      matches: data.task.matches,
      workspace: data.task.workspace,
    };
    setTask(data.task);
    setQuota(data.quota);
    state.current.onLoad({ ...data.task, ...snapshot }, merge);
    return data.task;
  }, []);

  useEffect(() => {
    if (!options.hydrated) return;
    let cancelled = false,
      inFlight = false;
    const refresh = async () => {
      if (inFlight || loading.current) return;
      inFlight = true;
      try {
        const data = await request<{
          tasks: TaskSummary[];
          quota: QuotaStatus;
        }>("/api/tasks");
        if (cancelled) return;
        setTasks(data.tasks);
        setQuota(data.quota);
        const current = state.current.id;
        const summary = data.tasks.find((t) => t.id === current);
        if (
          current &&
          summary &&
          (!task || task.id !== current || summary.updatedAt !== task.updatedAt)
        ) {
          await save();
          if (!cancelled && state.current.id === current)
            await load(current, true);
        }
      } catch (error) {
        if (!cancelled)
          setSyncError(
            error instanceof Error ? error.message : "任务同步失败，请重试。",
          );
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [options.hydrated, options.id, options.accountId, task, load, save]);

  useEffect(() => {
    if (!options.hydrated || !options.id) return;
    const timer = setTimeout(() => {
      void save().catch(() => {});
    }, 700);
    return () => clearTimeout(timer);
  }, [options.hydrated, options.id, options.matches, options.workspace, save]);

  async function start() {
    if (pending || !state.current.playlist) return;
    setPending(true);
    loading.current = true;
    try {
      if (state.current.id) {
        await save();
        await request(`/api/tasks/${state.current.id}`, { action: "resume" });
        await load(state.current.id, true);
        return state.current.id;
      } else {
        const draftKey = `songshift-draft-${state.current.accountId}-${state.current.playlist!.provider || "netease"}-${state.current.playlist!.id}`;
        let requestId = crypto.randomUUID();
        try {
          requestId = localStorage.getItem(draftKey) || requestId;
          localStorage.setItem(draftKey, requestId);
        } catch {}
        const data = await request<TaskResponse>("/api/tasks", {
          playlist: state.current.playlist,
          matches: state.current.matches,
          requestId,
        });
        state.current.setId(data.task.id);
        baseline.current = {
          id: data.task.id,
          matches: data.task.matches,
          workspace: data.task.workspace,
        };
        setTask(data.task);
        setQuota(data.quota);
        state.current.onLoad(data.task, true);
        try {
          localStorage.removeItem(draftKey);
        } catch {}
        return data.task.id;
      }
    } catch (error) {
      state.current.onError(error);
    } finally {
      setPending(false);
      loading.current = false;
    }
  }
  async function pause() {
    if (!state.current.id || pending) return;
    setPending(true);
    try {
      await save();
      await request(`/api/tasks/${state.current.id}`, { action: "pause" });
      await load(state.current.id, true);
    } catch (error) {
      state.current.onError(error);
    } finally {
      setPending(false);
    }
  }
  async function reviewAi(
    action: "start" | "pause" | "all",
    indices?: number[],
    webSearch = false,
  ) {
    if (pending) return;
    const id = state.current.id || (action !== "pause" ? await start() : null);
    if (!id) return;
    setPending(true);
    try {
      await save();
      await request(`/api/tasks/${id}/ai`, { action, indices, webSearch });
      await load(id, true);
    } catch (error) {
      state.current.onError(error);
    } finally {
      setPending(false);
    }
  }
  async function open(id: string) {
    if (pending) return;
    setPending(true);
    loading.current = true;
    try {
      await save();
      await load(id, false);
      state.current.setId(id);
      setSyncError("");
    } catch (error) {
      state.current.onError(error);
    } finally {
      setPending(false);
      loading.current = false;
    }
  }
  async function write(action?: "retry") {
    const id = state.current.id;
    if (!id) throw new Error("请先创建后台任务并完成匹配。");
    setPending(true);
    try {
      await save();
      await request("/api/spotify/transfer", { taskId: id, action });
    } finally {
      // The enqueue response can be lost even though the durable job exists.
      // Both accepted and rejected submissions reconcile with server truth.
      try { await load(id, true); } finally { setPending(false); }
    }
  }
  async function remove(id: string) {
    if (pending) return;
    setPending(true);
    try {
      await request(`/api/tasks/${id}`, { action: "delete" });
      setTasks((old) => old.filter((t) => t.id !== id));
      if (state.current.id === id) {
        state.current.setId(null);
        setTask(null);
        baseline.current = null;
      }
    } catch (error) {
      state.current.onError(error);
    } finally {
      setPending(false);
    }
  }
  return {
    tasks,
    task: options.id === task?.id ? task : null,
    quota,
    pending,
    syncError,
    start,
    pause,
    reviewAi,
    open,
    remove,
    save,
    write,
  };
}

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Disc3,
  ExternalLink,
  FileMusic,
  Headphones,
  History,
  Info,
  Link2,
  ListMusic,
  LoaderCircle,
  LockKeyhole,
  Menu,
  Music2,
  Pause,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Unplug,
  X,
} from "lucide-react";
import { demoMatch, demoPlaylist } from "@/lib/demo";
import { boundedConcurrency, runConcurrentBatch } from "@/lib/ai-batch";
import {
  applyAiReview,
  matchesToCsv,
  needsAiReview,
  needsOriginalResearch,
  needsArtistResearch,
  visibleCandidates,
  excludedCandidateDetails,
  reconcileMatch,
  parsePlaylistId,
} from "@/lib/matching";
import {
  detectPlaylistProvider,
  parseQqPlaylistId,
  parseKugouPlaylistId,
  providerNames,
  qqShortShareUrl,
} from "@/lib/playlist-source";
import type {
  PlaylistProvider,
  AiReview,
  AiReviewResponse,
  AiStatus,
  AuthStatus,
  Candidate,
  Match,
  Playlist,
} from "@/lib/types";
import type { TransferResult } from "@/lib/spotify";
import { useTaskQueue } from "./use-task-queue";
import { taskLabels, aiJobLabels, transferJobLabels, type TransferTask } from "@/lib/task-types";
import { TransferProgress } from "./transfer-progress";
import { AccountForm } from "./account-form";
import type { User } from "@/lib/accounts";

type Tab = "all" | Match["status"];
type AiFilter = "all" | "reviewed" | "pending" | AiReview["decision"];
const aiDecisionLabels = {
  match: "复核通过",
  skip: "已排除",
  uncertain: "仍不确定",
};
type Saved = {
  playlist: Playlist;
  matches: Match[];
  demo: boolean;
  name: string;
  result: TransferResult | null;
  writeStarted: boolean;
  taskId?: string | null;
  isPublic?: boolean;
  accountId?: string | null;
};
const initialAuth: AuthStatus = {
  configured: false,
  connected: false,
  redirectUri: "http://127.0.0.1:3002/api/auth/callback",
};
const labels = {
  pending: "等待匹配",
  matched: "已匹配",
  review: "待确认",
  missing: "未找到",
};
const SESSION_KEY = "songshift-workspace-v1";

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfter?: number,
  ) {
    super(message);
  }
}
async function api<T>(
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      data.error || "请求失败，请重试。",
      response.status,
      data.retryAfter,
    );
  return data;
}
function SpotifyMark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="12" />
      <g fill="none" stroke="var(--spotify-line, white)" strokeLinecap="round">
        <path d="M5.5 8.5c4.3-1.3 9.2-.9 13 1.4" strokeWidth="1.8" />
        <path d="M6.3 12c3.8-1 7.9-.6 11.1 1.1" strokeWidth="1.6" />
        <path d="M7.1 15.3c3.2-.7 6.3-.3 9.2 1" strokeWidth="1.4" />
      </g>
    </svg>
  );
}
function NeteaseMark() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M19.5 5.5c-6.4-1.1-12 3.9-12 10.6 0 5.9 4.1 10.1 9.4 10.1 5.5 0 9.2-3.9 9.2-8.9 0-4.6-3.2-7.7-7-7.7-3.5 0-5.9 2.3-5.9 5.4 0 2.4 1.6 3.9 3.5 3.9 1.8 0 3.2-1.2 3.2-3.1V3.7"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
function Cover({
  name,
  index = 0,
  url,
  large = false,
}: {
  name: string;
  index?: number;
  url?: string;
  large?: boolean;
}) {
  return (
    <div className={`cover cover-${index % 7} ${large ? "cover-large" : ""}`}>
      {/* Remote cover URLs come from the two music services; native images also tolerate unavailable artwork. */}
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={`${name}封面`}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      ) : (
        <>
          <span className="cover-orbit" />
          <span className="cover-letter">
            {large ? "SLOW\nDAYS" : name.slice(0, 1)}
          </span>
        </>
      )}
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export default function TransferApp() {
  const [auth, setAuth] = useState<AuthStatus>(initialAuth);
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [ai, setAi] = useState<AiStatus>({
    configured: false,
    model: "gpt-6-luna",
    concurrency: 3,
  });
  const [input, setInput] = useState("");
  const [provider, setProvider] = useState<PlaylistProvider>("netease");
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const sourceName = providerNames[playlist?.provider || "netease"];
  const inputSourceName = providerNames[provider];
  const [matches, setMatches] = useState<Match[]>([]);
  const [demo, setDemo] = useState(false);
  const [name, setName] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [busy, setBusy] = useState<"read" | "match" | "transfer" | "ai" | null>(
    null,
  );
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(50);
  const [message, setMessage] = useState<{
    kind: "error" | "info" | "success";
    text: string;
  } | null>(null);
  const [modal, setModal] = useState<
    "settings" | "help" | "confirm" | "history" | "account" | null
  >(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [result, setResult] = useState<TransferResult | null>(null);
  const [writeStarted, setWriteStarted] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [aiFilter, setAiFilter] = useState<AiFilter>("all");
  const [aiBatch, setAiBatch] = useState<{
    taskId: string | null;
    done: number;
    total: number;
    current: string;
    state: "running" | "pausing" | "paused" | "failed" | "complete";
  } | null>(null);
  const stop = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const working = useRef(false);
  const queue = useTaskQueue({
    hydrated,
    accountId: user?.id || null,
    id: taskId,
    playlist,
    matches,
    workspace: { name, isPublic, result, writeStarted },
    setId: setTaskId,
    onLoad: (task: TransferTask, merge: boolean) => {
      if (!merge) {
        setAiFilter("all");
        setAiBatch(null);
        setPlaylist(task.playlist);
        setProvider(task.playlist.provider || "netease");
        setMatches(task.matches);
        setDemo(false);
        setName(task.workspace.name);
        setIsPublic(task.workspace.isPublic);
        setResult(task.workspace.result);
        setWriteStarted(task.workspace.writeStarted);
        setTab("all");
        setQuery("");
        setVisibleCount(50);
        setModal(null);
      } else {
        setMatches(task.matches);
        setName(task.workspace.name);
        setIsPublic(task.workspace.isPublic);
        setWriteStarted(task.workspace.writeStarted);
        setResult(task.workspace.result);
      }
    },
    onError: (error) =>
      setMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "任务操作失败，请重试。",
      }),
  });

  useEffect(() => {
    let cancelled = false;
    api<AuthStatus>("/api/auth/status")
      .then(setAuth)
      .catch(() =>
        setMessage({
          kind: "error",
          text: "无法读取连接状态，请刷新页面重试。",
        }),
      )
      .finally(() => setAuthReady(true));
    api<AiStatus>("/api/ai/status")
      .then(setAi)
      .catch(() => {});
    api<{ user: User | null }>("/api/account")
      .then(({ user: account }) => {
        if (cancelled) return;
        setUser(account);
        try {
          const saved =
            localStorage.getItem(SESSION_KEY) ||
            sessionStorage.getItem(SESSION_KEY);
          if (saved) {
            const data: Saved = JSON.parse(saved);
            if (
              data.playlist &&
              Array.isArray(data.matches) &&
              (!data.accountId || data.accountId === account?.id)
            ) {
              setPlaylist(data.playlist);
              setProvider(data.playlist.provider || "netease");
              setMatches(
                data.writeStarted
                  ? data.matches
                  : data.matches.map(reconcileMatch),
              );
              setDemo(data.demo);
              setName(data.name);
              setResult(data.result);
              setWriteStarted(!!data.writeStarted);
              setTaskId(data.taskId || null);
              setIsPublic(!!data.isPublic);
            }
          }
        } catch {
          /* An unavailable browser store does not prevent using the app. */
        }
        const authResult = new URLSearchParams(window.location.search).get(
          "auth",
        );
        if (authResult) {
          const errors: Record<string, string> = {
            configuration: "请先完成 Spotify 应用配置。",
            invalid_state: "授权请求已过期或校验失败，请重新连接 Spotify。",
            denied: "你取消了授权，可以随时重新连接。",
            failed: "授权未完成，请检查 Client ID 和回调地址后重试。",
            site_login: "请先登录网站账号，再连接 Spotify。",
          };
          setMessage({
            kind: authResult === "success" ? "success" : "error",
            text:
              authResult === "success"
                ? "Spotify 已连接，可以开始匹配歌单了。"
                : errors[authResult] || "授权失败，请重试。",
          });
          window.history.replaceState({}, "", "/");
        }
        setHydrated(true);
      })
      .catch(() =>
        setMessage({
          kind: "error",
          text: "无法读取账号状态，请刷新页面重试。",
        }),
      );
    return () => {
      cancelled = true;
      stop.current = true;
      controller.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      if (playlist)
        localStorage.setItem(
          SESSION_KEY,
          JSON.stringify({
            playlist,
            matches,
            demo,
            name,
            result,
            writeStarted,
            taskId,
            isPublic,
            accountId: user?.id || null,
          } satisfies Saved),
        );
      else localStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* Server task storage remains available if the browser quota is exhausted. */
    }
  }, [
    hydrated,
    playlist,
    matches,
    demo,
    name,
    result,
    writeStarted,
    taskId,
    isPublic,
    user,
  ]);

  const completed = matches.filter((m) => m.status !== "pending").length;
  const selected = matches.filter((m) => m.included && m.selected);
  const counts = {
    all: matches.length,
    matched: matches.filter((m) => m.status === "matched").length,
    review: matches.filter((m) => m.status === "review").length,
    missing: matches.filter((m) => m.status === "missing").length,
    pending: matches.filter((m) => m.status === "pending").length,
  };
  const filtered = matches.filter(
    (m) =>
      (tab === "all" || m.status === tab) &&
      (aiFilter === "all" ||
        (aiFilter === "reviewed"
          ? !!m.aiReview
          : aiFilter === "pending"
            ? needsAiReview(m)
            : m.aiReview?.decision === aiFilter)) &&
      `${m.source.name} ${m.source.artists.join(" ")} ${m.selected?.name || ""}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  const review = matches.find((m) => m.source.id === reviewId);
  const reviewCandidates = review ? visibleCandidates(review) : [];
  const excludedCandidates = review ? excludedCandidateDetails(review) : [];
  const aiPending = matches.filter(needsAiReview);
  const aiUnmatched = matches.filter(needsOriginalResearch);
  const aiUnverified = matches.filter(
    (m) =>
      needsOriginalResearch(m) &&
      m.aiReview &&
      !m.aiReview.research &&
      needsArtistResearch(m.source, m.candidates),
  );
  const aiReviewed = matches.filter((m) => m.aiReview);
  const aiSearchAgain = matches.filter((m) => needsOriginalResearch(m) &&
    (m.aiReview?.decision === "skip" || m.aiReview?.decision === "uncertain"));
  const aiCounts = {
    match: aiReviewed.filter((m) => m.aiReview?.decision === "match").length,
    skip: aiReviewed.filter((m) => m.aiReview?.decision === "skip").length,
    uncertain: aiReviewed.filter((m) => m.aiReview?.decision === "uncertain")
      .length,
  };
  const aiTotal = aiReviewed.length + aiPending.length;
  const lastAiReview = [...aiReviewed].sort(
    (a, b) => (b.aiReview?.reviewedAt || 0) - (a.aiReview?.reviewedAt || 0),
  )[0];
  const aiProgress = aiTotal
    ? Math.round((aiReviewed.length / aiTotal) * 100)
    : 0;
  const transferJob = !demo ? queue.task?.transferJob : null;
  const serverAiJob = !demo ? queue.task?.aiJob : null;
  const serverAiBlocked = serverAiJob?.blocked || [];
  const serverAiPending = serverAiJob
    ? Math.max(0, serverAiJob.total - serverAiJob.completed - serverAiBlocked.length)
    : 0;
  const serverAiActive =
    !!serverAiJob &&
    ["queued", "running", "waiting"].includes(serverAiJob.status);
  const serverAiDraining = !!serverAiJob?.current.length;
  const serverAiRemaining =
    !!serverAiJob && serverAiJob.completed < serverAiJob.total;
  const savedAiCount = !demo && taskId ? queue.task?.aiReviewed : undefined;
  function filterAi(value: AiFilter) {
    setAiFilter(value);
    setTab("all");
    setQuery("");
    setVisibleCount(50);
  }
  const progress = matches.length
    ? Math.round((completed / matches.length) * 100)
    : 0;

  function loadPlaylist(data: Playlist, isDemo: boolean) {
    setAiFilter("all");
    setAiBatch(null);
    setTaskId(null);
    setPlaylist(data);
    setProvider(data.provider || "netease");
    setDemo(isDemo);
    setName(data.name);
    setMatches(
      data.songs.map((source) => ({
        source,
        candidates: [],
        selected: null,
        status: "pending",
        included: false,
      })),
    );
    setResult(null);
    setWriteStarted(false);
    setTab("all");
    setQuery("");
    setVisibleCount(50);
    setRetryAt(0);
  }
  function errorMessage(error: unknown) {
    if (error instanceof ApiError && error.status === 401)
      setAuth((old) => ({ ...old, connected: false }));
    if (error instanceof ApiError && error.retryAfter)
      setRetryAt(Date.now() + error.retryAfter * 1000);
    setMessage({
      kind: "error",
      text: error instanceof Error ? error.message : "操作未完成，请重试。",
    });
  }
  async function readPlaylist() {
    if (working.current || queue.pending) return;
    const selectedProvider = detectPlaylistProvider(input) || provider;
    const valid =
      selectedProvider === "qq"
        ? parseQqPlaylistId(input) || qqShortShareUrl(input)
        : selectedProvider === "kugou"
          ? parseKugouPlaylistId(input)
          : parsePlaylistId(input);
    if (!valid) {
      setMessage({
        kind: "error",
        text: `请输入有效的${providerNames[selectedProvider]}歌单链接或数字 ID。短链接请先打开，再复制完整歌单地址。`,
      });
      return;
    }
    working.current = true;
    setBusy("read");
    setMessage(null);
    try {
      const data = await api<Playlist>(`/api/${selectedProvider}/playlist`, {
        input,
      });
      loadPlaylist(data, false);
      if (!data.songs.length)
        setMessage({
          kind: "info",
          text: "这个歌单没有可读取的歌曲。请试试其他公开歌单。",
        });
    } catch (error) {
      errorMessage(error);
    } finally {
      working.current = false;
      setBusy(null);
    }
  }
  function openDemo() {
    if (working.current || queue.pending) return;
    loadPlaylist(demoPlaylist, true);
    setMessage({
      kind: "info",
      text: "正在体验示例歌单。匹配结果为演示数据，不会读写你的 Spotify 账号。",
    });
  }
  function connect() {
    if (!user) {
      setModal("account");
      return;
    }
    if (!auth.configured) {
      setModal("settings");
      return;
    }
    window.location.assign(
      new URL("/api/auth/login", window.location.origin).href,
    );
  }
  async function matchPlaylist() {
    if (working.current || !playlist) return;
    if (!demo && !auth.connected) {
      connect();
      return;
    }
    if (!demo) {
      await queue.start();
      return;
    }
    if (Date.now() < retryAt) {
      setMessage({
        kind: "info",
        text: `Spotify 仍在限流中，请约 ${Math.ceil((retryAt - Date.now()) / 1000)} 秒后继续。`,
      });
      return;
    }
    working.current = true;
    stop.current = false;
    setBusy("match");
    setMessage(null);
    controller.current = new AbortController();
    try {
      for (let index = 0; index < matches.length; index++) {
        if (stop.current) break;
        if (matches[index].status !== "pending") continue;
        let match: Match;
        if (demo) {
          await new Promise((resolve) => setTimeout(resolve, 240));
          match = demoMatch(matches[index].source, index);
        } else
          match = await api<Match>(
            "/api/spotify/match",
            { song: matches[index].source },
            controller.current.signal,
          );
        if (stop.current) break;
        setMatches((old) =>
          old.map((item, i) =>
            i === index ? { ...match, source: item.source } : item,
          ),
        );
      }
    } catch (error) {
      if (!stop.current) errorMessage(error);
    } finally {
      working.current = false;
      setBusy(null);
      controller.current = null;
    }
  }
  function pauseMatching() {
    if (!demo && taskId) {
      void queue.pause();
      return;
    }
    stop.current = true;
    controller.current?.abort();
    setMessage({
      kind: "info",
      text: "匹配已暂停，已完成的结果会保留。点击继续匹配即可接着处理。",
    });
  }
  function chooseCandidate(candidate: Candidate) {
    setMatches((old) =>
      old.map((m) =>
        m.source.id === reviewId
          ? {
              ...m,
              selected: candidate,
              included: true,
              status: "matched",
              confirmedByUser: true,
              aiSelected: false,
            }
          : m,
      ),
    );
    setReviewId(null);
  }
  async function runAiReview(
    items: Match[],
    webSearch = false,
    allPending = false,
  ) {
    if (working.current || writeStarted || !items.length) return;
    if (!demo && !ai.configured) {
      setModal("settings");
      setReviewId(null);
      return;
    }
    if (!demo) {
      setMessage(null);
      setReviewId(null);
      await queue.reviewAi(
        "start",
        allPending
          ? undefined
          : items.map((item) =>
              matches.findIndex((m) => m.source.id === item.source.id),
            ),
        webSearch,
      );
      return;
    }
    working.current = true;
    setBusy("ai");
    setMessage(null);
    stop.current = false;
    controller.current = new AbortController();
    setAiBatch({
      taskId,
      done: 0,
      total: items.length,
      current: "",
      state: "running",
    });
    const batchController = controller.current;
    try {
      if (!demo && taskId) await queue.save();
      const done = await runConcurrentBatch(
        items,
        async (match) => {
          let advice: AiReview;
          let candidates: Candidate[] | undefined;
          let excludedCandidates: Candidate[] | undefined;
          if (demo) {
            await new Promise((resolve) => setTimeout(resolve, 650));
            advice = {
              decision: match.selected?.confident ? "match" : "skip",
              candidateId: match.selected?.confident ? match.selected.id : null,
              confidence: "high",
              reason: match.selected?.confident
                ? "示例建议：歌名、歌手和时长一致，可保留此候选。"
                : "示例建议：候选标注 Live，且比原曲长 28 秒，可能是不同的现场录音。建议跳过，或人工确认后再选择。",
              model: `${ai.model} · 模拟结果`,
            };
          } else {
            const response = await api<AiReviewResponse>(
              "/api/ai/review",
              {
                source: match.source,
                candidates: match.candidates,
                taskId,
                webSearch,
              },
              batchController.signal,
            );
            ({ candidates, excludedCandidates, ...advice } = response);
          }
          // A requested pause drains in-flight results instead of dropping them.
          if (batchController.signal.aborted)
            throw new Error("复核已中止，服务器已完成的结果仍会保留。");
          setMatches((old) =>
            old.map((m) =>
              m.source.id === match.source.id
                ? applyAiReview(
                    {
                      ...m,
                      candidates: candidates || m.candidates,
                      excludedCandidates:
                        excludedCandidates || m.excludedCandidates,
                    },
                    advice,
                  )
                : m,
            ),
          );
        },
        {
          concurrency: boundedConcurrency(ai.concurrency),
          shouldStop: () => stop.current,
          onProgress: ({ done, active, lastCompleted, failed }) => {
            setAiBatch({
              taskId,
              done,
              total: items.length,
              current: active.length
                ? active.map((index) => items[index].source.name).join("、")
                : lastCompleted === null
                  ? ""
                  : items[lastCompleted].source.name,
              state: stop.current || failed ? "pausing" : "running",
            });
          },
        },
      );
      setAiBatch((old) =>
        old
          ? { ...old, state: done === items.length ? "complete" : "paused" }
          : null,
      );
    } catch (error) {
      setAiBatch((old) =>
        old ? { ...old, state: stop.current ? "paused" : "failed" } : null,
      );
      if (!stop.current) errorMessage(error);
    } finally {
      working.current = false;
      setBusy(null);
      controller.current = null;
    }
  }
  function exportCsv(subset: Match[] = matches) {
    const url = URL.createObjectURL(
      new Blob([matchesToCsv(subset, playlist?.provider)], {
        type: "text/csv;charset=utf-8;",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${demo ? "示例-" : ""}${name || "歌单"}-匹配报告.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function transfer() {
    if (working.current || writeStarted || !selected.length || !name.trim())
      return;
    setModal(null);
    working.current = true;
    setBusy("transfer");
    setMessage(null);
    if (demo) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      setResult({
        id: "demo",
        url: "",
        added: selected.length,
        total: selected.length,
        complete: true,
      });
      setWriteStarted(true);
      working.current = false;
      setBusy(null);
      return;
    }
    try {
      await queue.write();
      setMessage({ kind: "success", text: "已提交后台写入，可以关闭网页，进度会自动保存。" });
    } catch (error) {
      errorMessage(error);
    } finally {
      working.current = false;
      setBusy(null);
    }
  }
  async function disconnect() {
    try {
      await api("/api/auth/logout", {});
      setAuth((old) => ({ ...old, connected: false }));
      setMessage({ kind: "info", text: "Spotify 已断开连接。" });
      setModal(null);
    } catch (error) {
      errorMessage(error);
    }
  }
  async function logoutAccount() {
    if (working.current) return;
    try {
      await queue.save();
      await api("/api/account", { action: "logout" });
      setUser(null);
      setAuth((old) => ({ ...old, connected: false }));
      reset();
      setModal(null);
      localStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(SESSION_KEY);
      setMessage({
        kind: "info",
        text: "已退出网站账号，后台任务会继续运行。",
      });
    } catch (error) {
      errorMessage(error);
    }
  }
  function reset() {
    if (working.current || queue.pending) return;
    setPlaylist(null);
    setMatches([]);
    setResult(null);
    setWriteStarted(false);
    setDemo(false);
    setMessage(null);
    setMobileNav(false);
    setInput("");
    setName("");
    setTaskId(null);
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
        <Link className="brand" href="/" aria-label="SongShift 首页">
          <span className="brand-icon">
            <AudioLines size={23} />
          </span>
          <span>
            SongShift<span className="brand-cn">移调</span>
          </span>
        </Link>
        <div className="workspace-label">YOUR MUSIC, EVERYWHERE</div>
        <nav aria-label="主要导航">
          <button
            className="nav-item active"
            onClick={() => {
              setMobileNav(false);
              document
                .getElementById("transfer")
                ?.scrollIntoView({ behavior: "smooth" });
            }}
          >
            <AudioLines size={19} />
            歌单迁移
            <ArrowUpRight size={15} />
          </button>
          <button
            className="nav-item"
            onClick={() => {
              setModal("history");
              setMobileNav(false);
            }}
          >
            <History size={19} />
            后台任务
          </button>
          <button
            className="nav-item"
            onClick={() => {
              setModal("settings");
              setMobileNav(false);
            }}
          >
            <SlidersHorizontal size={19} />
            连接与设置
          </button>
        </nav>
        <div className="sidebar-note">
          <span className="mini-disc">
            <Disc3 size={30} />
          </span>
          <p>
            平台会变，
            <br />
            喜欢的音乐不会。
          </p>
          <span>Keep your music close.</span>
          <div className="note-lines">
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
        </div>
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => setModal("help")}>
            <CircleHelp size={18} />
            使用指南
            <ArrowUpRight size={14} />
          </button>
          <div className="local-status">
            <span />
            你的音乐，由你做主 <span className="version">v1.0</span>
          </div>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setMobileNav(!mobileNav)}
            >
              <Menu size={20} />
            </button>
            <span>工作台</span>
            <span className="breadcrumb-slash">/</span>
            <strong>歌单迁移</strong>
          </div>
          <div className="topbar-right">
            <button
              className="account-button"
              onClick={() => setModal("account")}
            >
              <LockKeyhole size={14} />
              {user ? user.username : "登录 / 注册"}
            </button>
            <span className="private-label">
              <ShieldCheck size={14} />
              安全连接，安心迁移
            </span>
            <button
              className="help-button"
              aria-label="使用帮助"
              onClick={() => setModal("help")}
            >
              <CircleHelp size={19} />
            </button>
          </div>
        </header>
        <main id="transfer">
          <section className="hero">
            <div className="hero-copy">
              <div className="eyebrow">
                <span /> A NEW HOME FOR YOUR MUSIC
              </div>
              <h1>
                换个地方，
                <br />
                继续<span>喜欢。</span>
                <svg
                  className="title-swoosh"
                  viewBox="0 0 150 13"
                  aria-hidden="true"
                >
                  <path d="M3 9C47 1 105 1 146 6" />
                </svg>
              </h1>
              <p>
                网易云 / QQ 音乐 / 酷狗 → Spotify。
                <br />
                熟悉的旋律，换个地方继续。
              </p>
              <div className="hero-tags">
                <span>
                  <Check size={13} />
                  保留歌曲顺序
                </span>
                <span>
                  <Check size={13} />
                  逐首智能匹配
                </span>
                <span>
                  <Check size={13} />
                  自主确认版本
                </span>
              </div>
            </div>
            <div className="hero-art" aria-hidden="true">
              <div className="art-orbit orbit-one" />
              <div className="art-orbit orbit-two" />
              <div className="art-star star-one">✳</div>
              <div className="art-star star-two">✦</div>
              <div className="record-sleeve">
                <span>
                  GOOD MUSIC
                  <br />
                  GOES WITH YOU.
                </span>
                <div className="sleeve-landscape">
                  <i />
                  <b />
                </div>
                <span className="sleeve-bottom">SIDE A — YOUR FAVORITES</span>
              </div>
              <div className="vinyl">
                <div className="vinyl-label">
                  <AudioLines size={28} />
                  <span>keep it playing</span>
                  <i />
                </div>
              </div>
              <div
                className={`floating-service netease-float ${provider}-float`}
              >
                {provider === "netease" ? <NeteaseMark /> : <Music2 />}
              </div>
              <div className="floating-service spotify-float">
                <SpotifyMark />
              </div>
              <div className="art-caption">
                <span>{inputSourceName}</span>
                <span className="art-arrow">
                  · · · <ArrowRight size={17} /> · · ·
                </span>
                <span>Spotify</span>
              </div>
            </div>
          </section>

          <ol className="steps" aria-label="迁移步骤">
            {["选择歌单", "匹配与确认", "迁移到 Spotify"].map((label, i) => {
              const activeStep = result
                ? 3
                : completed === matches.length && matches.length > 0
                  ? 2
                  : playlist
                    ? 1
                    : 0;
              return (
                <li
                  key={label}
                  className={
                    i < activeStep ? "done" : i === activeStep ? "current" : ""
                  }
                >
                  <span className="step-number">
                    {i < activeStep ? <Check size={14} /> : `0${i + 1}`}
                  </span>
                  <span>{label}</span>
                  {i < 2 && <div className="step-line" />}
                </li>
              );
            })}
          </ol>

          {message && (
            <div
              className={`notice ${message.kind}`}
              role={message.kind === "error" ? "alert" : "status"}
            >
              <Info size={17} />
              <span>{message.text}</span>
              <button
                className="icon-button"
                aria-label="关闭提示"
                onClick={() => setMessage(null)}
              >
                <X size={16} />
              </button>
            </div>
          )}

          <section className="connection-grid" aria-label="选择来源和目标">
            <div className="service-card source-card">
              <div className="card-topline">
                <span className="section-kicker">FROM / 音乐来源</span>
                <span className="soft-badge">公开歌单 · 免登录</span>
              </div>
              <div
                className="source-selector"
                role="group"
                aria-label="选择音乐来源"
              >
                {(["netease", "qq", "kugou"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={provider === value}
                    disabled={!!busy || queue.pending}
                    onClick={() => {
                      setProvider(value);
                      setInput("");
                    }}
                  >
                    {providerNames[value]}
                  </button>
                ))}
              </div>
              <div className="service-title">
                <span className={`service-logo ${provider}`}>
                  {provider === "netease" ? <NeteaseMark /> : <Music2 size={28} />}
                </span>
                <div>
                  <h2>{inputSourceName}</h2>
                  <p>那些陪伴你的旋律</p>
                </div>
                <span className="service-index">01</span>
              </div>
              <label htmlFor="playlist-input" className="field-label">
                粘贴歌单链接或 ID
              </label>
              <form
                className="input-with-button"
                onSubmit={(event) => {
                  event.preventDefault();
                  void readPlaylist();
                }}
              >
                <Link2 size={17} />
                <input
                  id="playlist-input"
                  placeholder={
                    provider === "qq"
                      ? "y.qq.com/n/ryqq/playlist/…"
                      : provider === "kugou"
                        ? "酷狗公开歌单链接或数字 ID"
                        : "music.163.com/playlist?id=…"
                  }
                  value={input}
                  onChange={(event) => {
                    const value = event.target.value;
                    setInput(value);
                    const detected = detectPlaylistProvider(value);
                    if (detected) setProvider(detected);
                  }}
                  disabled={!!busy}
                  autoComplete="off"
                />
                <button
                  className="small-primary"
                  disabled={!!busy || !input.trim()}
                  type="submit"
                >
                  {busy === "read" ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    "读取歌单"
                  )}
                </button>
              </form>
              <div className="source-hint">
                <span>{inputSourceName} → 歌单 → 分享 → 复制链接</span>
                <button
                  onClick={() => {
                    setInput(
                      provider === "qq"
                        ? "https://y.qq.com/n/ryqq/playlist/7799808010"
                        : provider === "kugou"
                          ? "https://www.kugou.com/yy/special/single/8944261.html"
                          : "13586645289",
                    );
                  }}
                  disabled={!!busy}
                >
                  {provider === "netease" ? "填入你的歌单" : "填入公开歌单"}
                  <ArrowUpRight size={12} />
                </button>
              </div>
            </div>
            <div className="connection-arrow">
              <ArrowRight size={19} />
            </div>
            <div className="service-card destination-card">
              <div className="card-topline">
                <span className="section-kicker">TO / 新的目的地</span>
                <span
                  className={`connection-status ${auth.connected ? "connected" : ""}`}
                >
                  <i />
                  {auth.connected ? "已连接" : "未连接"}
                </span>
              </div>
              <div className="service-title">
                <span className="service-logo spotify">
                  <SpotifyMark />
                </span>
                <div>
                  <h2>Spotify</h2>
                  <p>让喜欢，在这里继续</p>
                </div>
                <span className="service-index">02</span>
              </div>
              <button
                className={`spotify-connect ${auth.connected ? "is-connected" : ""}`}
                onClick={() =>
                  auth.connected ? setModal("settings") : connect()
                }
                disabled={!authReady || !!busy}
              >
                {auth.connected ? <CheckCircle2 size={17} /> : <SpotifyMark />}
                {!authReady
                  ? "正在检查连接…"
                  : auth.connected
                    ? "Spotify 已连接"
                    : "连接 Spotify 账号"}
                <ArrowUpRight size={16} />
              </button>
              <p className="connect-note">
                <LockKeyhole size={12} />
                通过 Spotify 官方授权，无需提供密码
              </p>
            </div>
          </section>

          {!playlist ? (
            <section className="empty-panel">
              <div className="empty-panel-illustration">
                <span />
                <div>
                  <ListMusic size={27} />
                </div>
                <i>
                  <Plus size={12} />
                </i>
              </div>
              <h2>你的下一段音乐旅程，从这里开始</h2>
              <p>在上方粘贴歌单链接，我们会帮你找到每首歌的新位置。</p>
              <button
                className="demo-button"
                onClick={openDemo}
                disabled={!!busy}
              >
                先用示例歌单体验一下
                <ArrowRight size={15} />
              </button>
              <div className="empty-panel-footer">
                <span>
                  <FileMusic size={14} />
                  仅迁移歌曲信息
                </span>
                <i />
                <span>
                  <ShieldCheck size={14} />
                  不修改原始歌单
                </span>
                <i />
                <span>
                  <ArrowDownToLine size={14} />
                  支持导出匹配报告
                </span>
              </div>
            </section>
          ) : (
            <>
              <section className="playlist-panel">
                <div className="playlist-summary">
                  <Cover name={playlist.name} url={playlist.cover} large />
                  <div className="playlist-meta">
                    <div className="playlist-eyebrow">
                      {demo ? "示例歌单 · 演示模式" : `已读取${sourceName}歌单`}
                      <span>PLAYLIST</span>
                    </div>
                    <h2>{playlist.name}</h2>
                    <p>
                      {playlist.creator}
                      <span>·</span>
                      {playlist.songs.length.toLocaleString()} 首歌曲
                      <span>·</span>
                      {Math.round(
                        playlist.songs.reduce(
                          (sum, song) => sum + song.durationMs,
                          0,
                        ) / 60000,
                      )}{" "}
                      分钟
                    </p>
                  </div>
                  <button
                    className="text-button"
                    onClick={reset}
                    disabled={!!busy}
                  >
                    <Plus size={15} />
                    更换歌单
                  </button>
                </div>
                {playlist.missing > 0 && (
                  <div className="inline-warning">
                    <Info size={15} />
                    {sourceName}显示 {playlist.total} 首，其中{" "}
                    {playlist.missing} 首暂时无法读取；下面列出全部可读取歌曲。
                  </div>
                )}
                <div className="matching-controls">
                  <div>
                    <h3>
                      {!demo &&
                      queue.task &&
                      [
                        "queued",
                        "running",
                        "waiting",
                        "needs_auth",
                        "failed",
                        "paused",
                      ].includes(queue.task.status)
                        ? taskLabels[queue.task.status]
                        : busy === "match"
                          ? "正在寻找熟悉的旋律…"
                          : completed === matches.length && matches.length
                            ? "匹配完成，每一首都由你决定"
                            : completed
                              ? "进度已保存，随时继续"
                              : "准备好，为歌单找一个新家"}
                    </h3>
                    <p>
                      {completed
                        ? `已处理 ${completed} / ${matches.length} 首 · 已选择 ${selected.length} 首迁移`
                        : "综合歌名、歌手、专辑与时长，寻找合适的版本。"}
                    </p>
                  </div>
                  {busy === "match" ||
                  (!demo &&
                    queue.task &&
                    ["queued", "running", "waiting"].includes(
                      queue.task.status,
                    )) ? (
                    <button
                      className="secondary-button"
                      onClick={pauseMatching}
                      disabled={queue.pending}
                    >
                      <Pause size={14} />
                      {demo ? "暂停匹配" : "暂停任务"}
                    </button>
                  ) : (
                    completed < matches.length && (
                      <button
                        className="primary-button"
                        disabled={!!busy || writeStarted || queue.pending}
                        onClick={matchPlaylist}
                      >
                        <Sparkles size={15} />
                        {queue.pending
                          ? "正在保存任务…"
                          : completed
                            ? "继续匹配"
                            : demo
                              ? "体验智能匹配"
                              : "创建后台匹配任务"}
                      </button>
                    )
                  )}
                </div>
                {!demo && (
                  <div className="task-budget" aria-live="polite">
                    <div>
                      <History size={17} />
                      <strong>
                        {queue.quota
                          ? `近 24 小时已搜索 ${queue.quota.used} 次 · 无本站每日上限`
                          : "后台匹配，限流后自动续跑"}
                      </strong>
                    </div>
                    <p>
                      每首歌可能搜索 1～3 次。遇到 Spotify
                      限流会按返回的等待时间自动重试，已完成的歌曲不再搜索。创建任务后可以关闭网页。
                    </p>
                    {queue.task?.resumeAt ? (
                      <p className="task-resume">
                        预计{" "}
                        {new Date(queue.task.resumeAt).toLocaleString("zh-CN")}{" "}
                        后继续；实际以 Spotify 可用额度为准。
                      </p>
                    ) : null}
                    {queue.task?.error && (
                      <p className="task-error">{queue.task.error}</p>
                    )}
                    {queue.task?.status === "needs_auth" && (
                      <button className="text-button" onClick={connect}>
                        重新连接 Spotify
                      </button>
                    )}
                    {queue.syncError && (
                      <p className="task-error">
                        {queue.syncError}{" "}
                        <button
                          className="text-button"
                          onClick={() => void queue.save().catch(errorMessage)}
                        >
                          重试保存
                        </button>
                      </p>
                    )}
                    <button
                      className="text-button"
                      onClick={() => setModal("history")}
                    >
                      查看全部后台任务 <ArrowRight size={13} />
                    </button>
                  </div>
                )}
                {(completed > 0 || busy === "match") && (
                  <div
                    className="progress-track"
                    role="progressbar"
                    aria-label="匹配进度"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress}
                  >
                    <span style={{ width: `${progress}%` }} />
                  </div>
                )}
                {completed > 0 && (
                  <div className="ai-review-bar">
                    <div className="ai-bar-icon">
                      <Sparkles size={18} />
                    </div>
                    <div>
                      <h3>
                        AI 复核进度
                        <span>
                          {demo
                            ? "示例"
                            : `${ai.model} · ${boundedConcurrency(ai.concurrency)} 首并发 · 逐首保存`}
                        </span>
                      </h3>
                      <p>
                        已有复核结果 {aiReviewed.length} 首 · {serverAiJob ? "本轮待处理" : "待复核"}{" "}
                        {serverAiJob ? serverAiPending : aiPending.length} 首
                        {savedAiCount !== undefined &&
                          ` · 服务器已保存 ${savedAiCount} 首`}
                      </p>
                      <p>
                        {serverAiJob
                          ? `本轮已处理 ${serverAiJob.completed + serverAiBlocked.length} / ${serverAiJob.total} 首（结果已保存 ${serverAiJob.completed} 首 · 证据不足 ${serverAiBlocked.length} 首） · ${aiJobLabels[serverAiJob.status]}${serverAiJob.current.length ? `：${serverAiJob.current.join("、")}` : ""}${serverAiJob.resumeAt ? ` · ${new Date(serverAiJob.resumeAt).toLocaleString("zh-CN")} 后自动继续` : ""}`
                          : aiBatch?.taskId === taskId
                            ? `本轮 ${aiBatch.done} / ${aiBatch.total} 首（${Math.round((aiBatch.done / aiBatch.total) * 100)}%） · ${{ running: "正在处理", pausing: "等待在途结果保存", paused: "已暂停于", failed: "中断于", complete: "最后完成" }[aiBatch.state]}：${aiBatch.current || "准备中"}`
                            : lastAiReview?.aiReview?.reviewedAt
                              ? `最近完成：${lastAiReview.source.name} · ${aiDecisionLabels[lastAiReview.aiReview.decision]} · ${new Date(lastAiReview.aiReview.reviewedAt).toLocaleString("zh-CN")}`
                              : "点击下面的结果分类，查看已完成的歌曲和判断理由。"}
                      </p>
                    </div>
                    {serverAiJob?.error && (
                      <p className="task-error">{serverAiJob.error}</p>
                    )}
                    {!!serverAiJob?.searching?.length && (
                      <div className="ai-data-note">
                        {serverAiJob.searching.map((s) => (
                          <p key={s.index}>《{s.name}》：已搜索 {s.completed} 轮{s.query ? ` · 当前关键词：${s.query}` : serverAiJob.current.includes(s.name) ? " · 正在分析候选" : " · 搜索进度已保存"}</p>
                        ))}
                      </div>
                    )}
                    {serverAiActive || serverAiDraining ? (
                      <button
                        className="ai-button"
                        disabled={queue.pending || !serverAiActive}
                        onClick={() => void queue.reviewAi("pause")}
                      >
                        <Pause size={13} />
                        {serverAiActive ? "暂停后台复核" : "等待在途结果保存…"}
                      </button>
                    ) : busy === "ai" ? (
                      <button
                        className="ai-button"
                        onClick={() => {
                          stop.current = true;
                          setAiBatch((old) =>
                            old ? { ...old, state: "pausing" } : null,
                          );
                        }}
                      >
                        <Pause size={13} />
                        {aiBatch?.state === "pausing"
                          ? "正在保存结果…"
                          : "暂停复核"}
                      </button>
                    ) : (
                      <button
                        className="ai-button"
                        onClick={() =>
                          serverAiRemaining
                            ? void queue.reviewAi("start")
                            : void runAiReview(aiPending, false, true)
                        }
                        disabled={
                          !!busy ||
                          queue.pending ||
                          writeStarted ||
                          (!aiPending.length && !serverAiRemaining)
                        }
                      >
                        <Sparkles size={13} />
                        {demo
                          ? "体验 AI 复核"
                          : serverAiBlocked.length && !serverAiPending
                            ? "重试证据不足的歌曲"
                          : aiReviewed.length
                            ? "继续复核未处理歌曲"
                            : "AI 复核疑似歌曲"}
                      </button>
                    )}
                    <span className="ai-data-note">
                      AI
                      会主动搜索 Spotify，根据结果调整关键词，确认后自动选择。歌手别名先联网核实；每首最多 6 轮搜索，限流后自动续跑，关闭网页后继续。
                    </span>
                    {serverAiBlocked.length > 0 && (
                      <details className="ai-evidence-errors">
                        <summary>查看证据不足的 {serverAiBlocked.length} 首歌曲</summary>
                        <p>已自动重试一次，仍没有可核验来源。这些歌曲保留原有结果，本次没有通过新结论；其他歌曲继续处理。</p>
                        <ul>
                          {serverAiBlocked.map((item) => (
                            <li key={item.index}>
                              <button className="text-button" onClick={() => {
                                const match = matches[item.index];
                                if (match) setReviewId(match.source.id);
                              }}>《{item.name}》</button>：{item.error}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                )}
                {completed > 0 && (
                  <section
                    className="ai-results"
                    aria-label="AI 复核结果"
                    aria-live="polite"
                  >
                    <div className="ai-progress-label">
                      待复核范围已完成 {aiProgress}% ·
                      新匹配的歌曲会进入待复核列表
                    </div>
                    <div
                      className="progress-track"
                      role="progressbar"
                      aria-label="AI 复核完成比例"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={aiProgress}
                    >
                      <span style={{ width: `${aiProgress}%` }} />
                    </div>
                    <div className="ai-result-filters">
                      {(
                        [
                          ["all", "全部歌曲", matches.length],
                          ["reviewed", "已复核", aiReviewed.length],
                          ["pending", "待复核", aiPending.length],
                          ["match", "复核通过", aiCounts.match],
                          ["skip", "已排除", aiCounts.skip],
                          ["uncertain", "仍不确定", aiCounts.uncertain],
                        ] as const
                      ).map(([key, label, count]) => (
                        <button
                          key={key}
                          aria-pressed={aiFilter === key}
                          onClick={() => filterAi(key)}
                        >
                          {label} <strong>{count}</strong>
                        </button>
                      ))}
                      <button
                        disabled={!aiReviewed.length}
                        onClick={() => exportCsv(aiReviewed)}
                      >
                        <ArrowDownToLine size={14} />
                        导出复核结果
                      </button>
                      {!demo && ai.webSearch && (
                        <button
                          disabled={!!busy || queue.pending || writeStarted || serverAiActive || serverAiDraining || completed !== matches.length || !aiUnmatched.length}
                          onClick={() => void queue.reviewAi("unmatched")}
                        >
                          <Search size={14} />
                          未匹配歌曲联网查原唱（{aiUnmatched.length} 首）
                        </button>
                      )}
                      {!demo && aiSearchAgain.length > 0 && (
                        <button
                          disabled={!!busy || queue.pending || writeStarted || serverAiActive || serverAiDraining}
                          onClick={() => runAiReview(aiSearchAgain)}
                        >
                          <Search size={14} />
                          AI 重新搜索已排除 / 不确定（{aiSearchAgain.length}）
                        </button>
                      )}
                      {!demo && ai.webSearch && aiUnverified.length > 0 && (
                        <button
                          disabled={!!busy || writeStarted}
                          onClick={() => runAiReview(aiUnverified, true)}
                        >
                          <Search size={14} />
                          联网复查未匹配建议（{aiUnverified.length}）
                        </button>
                      )}
                    </div>
                    {!demo && ai.webSearch && (
                      <p>仅对未匹配好的歌曲（待确认、已排除、未找到）联网查原唱，再搜索 Spotify。已匹配和人工处理过的歌曲保留，不重复查；旧结果保留到新结果保存。后台运行，可随时暂停。{(serverAiActive || serverAiDraining) ? "开始前，请先暂停当前复核并等待在途结果保存。" : ""}</p>
                    )}
                    <p>
                      已自动选择{" "}
                      {matches.filter((m) => m.aiSelected && m.included).length}{" "}
                      首。高把握时直接选中；同曲同歌手的其他现场也可自动选择，现场替代和原唱替代会标注。
                    </p>
                  </section>
                )}
                <div className="table-toolbar">
                  <div
                    className="tabs"
                    role="tablist"
                    aria-label="筛选匹配状态"
                  >
                    {(["all", "matched", "review", "missing"] as const).map(
                      (key) => (
                        <button
                          key={key}
                          role="tab"
                          aria-selected={tab === key}
                          className={tab === key ? "selected" : ""}
                          onClick={() => {
                            setTab(key);
                            setVisibleCount(50);
                          }}
                        >
                          {key === "all" ? "全部歌曲" : labels[key]}
                          <span>{counts[key]}</span>
                        </button>
                      ),
                    )}
                  </div>
                  <div className="table-tools">
                    <label className="search-field">
                      <Search size={15} />
                      <input
                        value={query}
                        placeholder="搜索歌曲"
                        aria-label="搜索歌曲"
                        onChange={(event) => {
                          setQuery(event.target.value);
                          setVisibleCount(50);
                        }}
                      />
                    </label>
                    <button
                      className="icon-button"
                      title="导出全部匹配报告"
                      aria-label="导出全部匹配报告"
                      onClick={() => exportCsv()}
                      disabled={!matches.length}
                    >
                      <ArrowDownToLine size={17} />
                    </button>
                  </div>
                </div>
                <div className="track-table-wrapper">
                  <table className="track-table">
                    <thead>
                      <tr>
                        <th className="check-column">
                          <input
                            type="checkbox"
                            aria-label="选择或取消所有已确认歌曲"
                            checked={
                              matches.some((m) => m.status === "matched") &&
                              matches
                                .filter((m) => m.status === "matched")
                                .every((m) => m.included)
                            }
                            disabled={!!busy || writeStarted || !counts.matched}
                            onChange={(event) =>
                              setMatches((old) =>
                                old.map((m) =>
                                  m.status === "matched"
                                    ? {
                                        ...m,
                                        included: event.target.checked,
                                        confirmedByUser: true,
                                        aiSelected: false,
                                      }
                                    : m,
                                ),
                              )
                            }
                          />
                        </th>
                        <th className="number-column">#</th>
                        <th>{sourceName}</th>
                        <th className="arrow-column" />
                        <th>Spotify 匹配结果</th>
                        <th>匹配状态</th>
                        <th className="action-column" />
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.slice(0, visibleCount).map((match) => {
                        const index = matches.indexOf(match);
                        return (
                          <tr key={match.source.id}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`选择 ${match.source.name}`}
                                checked={match.included}
                                disabled={
                                  !!busy ||
                                  writeStarted ||
                                  !match.selected ||
                                  match.status === "review"
                                }
                                onChange={(event) =>
                                  setMatches((old) =>
                                    old.map((m) =>
                                      m.source.id === match.source.id
                                        ? {
                                            ...m,
                                            included: event.target.checked,
                                            confirmedByUser: true,
                                            aiSelected: false,
                                          }
                                        : m,
                                    ),
                                  )
                                }
                              />
                            </td>
                            <td className="track-index">
                              {String(index + 1).padStart(2, "0")}
                            </td>
                            <td>
                              <div className="track-info">
                                <Cover
                                  name={match.source.name}
                                  index={index}
                                  url={match.source.cover}
                                />
                                <div>
                                  <strong>{match.source.name}</strong>
                                  <span>
                                    {match.source.artists.join(" / ")}
                                  </span>
                                </div>
                              </div>
                            </td>
                            <td className="arrow-column">
                              <ArrowRight size={14} />
                            </td>
                            <td>
                              {match.selected ? (
                                <div className="matched-track">
                                  <strong>
                                    {match.selected.url ? (
                                      <a
                                        href={match.selected.url}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        {match.selected.name}
                                        <ArrowUpRight size={11} />
                                      </a>
                                    ) : (
                                      match.selected.name
                                    )}
                                  </strong>
                                  <span>
                                    {match.selected.artists.join(" / ")}
                                  </span>
                                </div>
                              ) : (
                                <span className="no-match">
                                  {match.status === "pending"
                                    ? "等待寻找它的新位置"
                                    : "暂时没有找到合适的版本"}
                                </span>
                              )}
                            </td>
                            <td>
                              <span className={`match-status ${match.status}`}>
                                {match.status === "matched" ? (
                                  <Check size={12} />
                                ) : match.status === "review" ? (
                                  <Info size={12} />
                                ) : (
                                  <span className="status-dot" />
                                )}
                                {labels[match.status]}
                              </span>
                              {match.aiReview && (
                                <button
                                  className={`ai-result-badge ai-${match.aiReview.decision}`}
                                  onClick={() => setReviewId(match.source.id)}
                                  title={match.aiReview.reason}
                                >
                                  <Sparkles size={12} />
                                  {match.aiSelected
                                    ? match.aiReview.matchKind ===
                                      "original_alternative"
                                      ? "AI 已选 · 原唱替代"
                                      : match.aiReview.matchKind === "live_alternative"
                                        ? "AI 已选 · 其他现场"
                                        : "AI 已自动选择"
                                    : match.aiReview.matchKind ===
                                        "original_alternative"
                                      ? "原唱替代 · 待确认"
                                      : match.aiReview.matchKind === "live_alternative"
                                        ? "其他现场 · 待确认"
                                        : aiDecisionLabels[
                                          match.aiReview.decision
                                        ]}
                                </button>
                              )}
                            </td>
                            <td>
                              {match.status !== "pending" && (
                                <button
                                  className="row-action"
                                  onClick={() => setReviewId(match.source.id)}
                                  aria-label={`查看 ${match.source.name} 的匹配候选`}
                                >
                                  <Settings2 size={16} />
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {!filtered.length && (
                    <div className="no-results">
                      <Search size={22} />
                      <p>这里还没有歌曲{query ? "，试试其他关键词" : ""}。</p>
                    </div>
                  )}
                </div>
                {filtered.length > visibleCount && (
                  <button
                    className="load-more"
                    onClick={() => setVisibleCount((count) => count + 50)}
                  >
                    显示更多（还有 {filtered.length - visibleCount} 首）
                    <ChevronDown size={15} />
                  </button>
                )}
                <div className="table-bottom">
                  <span>
                    <Info size={13} />
                    AI 已确认的歌曲自动勾选；其余可继续联网复核或手动选择
                  </span>
                  <button
                    className="text-button"
                    onClick={() => exportCsv(filtered)}
                  >
                    导出{tab === "all" ? "全部" : labels[tab]}结果
                    <ArrowDownToLine size={13} />
                  </button>
                </div>
              </section>

              {transferJob ? (
                <TransferProgress job={transferJob} pending={queue.pending}
                  connect={connect}
                  retry={() => void queue.write("retry").catch(errorMessage)} />
              ) : result ? (
                <section
                  className={`result-panel ${result.complete ? "success" : "partial"}`}
                >
                  <span className="result-icon">
                    {result.complete ? (
                      <CheckCheck size={28} />
                    ) : (
                      <Info size={28} />
                    )}
                  </span>
                  <div>
                    <h2>
                      {demo
                        ? "体验完成，下一站换上你的歌单"
                        : result.complete
                          ? "迁移完成，喜欢的音乐已经到站"
                          : "歌单已创建，部分歌曲尚未确认写入"}
                    </h2>
                    <p>
                      {demo
                        ? `示例中已选择 ${result.added} 首歌曲，没有向 Spotify 写入任何内容。`
                        : `已确认写入 ${result.added} / ${result.total} 首歌曲。${result.complete ? "去 Spotify 开启新的循环吧。" : "请先检查目标歌单，再处理剩余歌曲。"}`}
                    </p>
                  </div>
                  {result.url ? (
                    <a
                      className="primary-button"
                      href={result.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      在 Spotify 打开
                      <ExternalLink size={15} />
                    </a>
                  ) : (
                    <button className="primary-button" onClick={reset}>
                      迁移我的歌单
                      <ArrowRight size={15} />
                    </button>
                  )}
                </section>
              ) : (
                <section className="transfer-footer">
                  <div className="target-name">
                    <label htmlFor="target-name">新歌单名称</label>
                    <input
                      id="target-name"
                      value={name}
                      maxLength={100}
                      onChange={(event) => setName(event.target.value)}
                      disabled={!!busy || writeStarted}
                    />
                  </div>
                  <label className="privacy-toggle">
                    <input
                      type="checkbox"
                      checked={isPublic}
                      onChange={(event) => setIsPublic(event.target.checked)}
                      disabled={!!busy || writeStarted}
                    />
                    <span>公开歌单</span>
                  </label>
                  <button
                    className="primary-button transfer-button"
                    onClick={() => setModal("confirm")}
                    disabled={
                      !!busy ||
                      writeStarted ||
                      queue.pending ||
                      (!demo && (serverAiActive || serverAiDraining)) ||
                      !selected.length ||
                      !name.trim() ||
                      (!demo && !auth.connected) ||
                      (!demo && auth.writeReady === false) ||
                      (!demo && !!taskId && completed < matches.length)
                    }
                  >
                    {busy === "transfer" ? (
                      <LoaderCircle size={17} className="spin" />
                    ) : (
                      <ArrowRight size={17} />
                    )}{" "}
                    {busy === "transfer"
                      ? "正在提交后台任务…"
                      : `${demo ? "体验迁移" : "迁移到 Spotify"}${selected.length ? ` · ${selected.length} 首` : ""}`}
                  </button>
                  {!demo && auth.connected && auth.writeReady === false && (
                    <p className="write-warning">后台写入需要读取歌单以核对进度。请重新授权一次，已有任务会保留。
                      <button className="text-button" onClick={connect}>重新连接 Spotify</button>
                    </p>
                  )}
                  {!demo && taskId && completed < matches.length && (
                    <p className="write-warning">
                      后台会分批完成匹配，全部完成后再统一确认并迁移。
                    </p>
                  )}
                  {!demo && (serverAiActive || serverAiDraining) && !writeStarted && (
                    <p className="write-warning">AI 复核仍在进行，请等它完成；也可以暂停复核，待在途结果保存后提交后台写入。</p>
                  )}
                  {writeStarted && !busy && (
                    <p className="write-warning">
                      上次写入结果尚未确认。请先在 Spotify
                      检查是否已创建歌单，以免重复迁移。
                    </p>
                  )}
                </section>
              )}
            </>
          )}

          <footer className="page-footer">
            <span>
              <AudioLines size={14} />
              让音乐自由流动，让喜欢始终相随。
            </span>
            <button onClick={() => setModal("help")}>
              关于匹配与隐私
              <ArrowUpRight size={12} />
            </button>
          </footer>
        </main>
      </div>

      {modal === "settings" && (
        <Modal title="连接与设置" onClose={() => setModal(null)}>
          <div className="settings-service">
            <span className="service-logo spotify">
              <SpotifyMark />
            </span>
            <div>
              <h3>Spotify 官方授权</h3>
              <p>
                {auth.connected
                  ? "已连接 · 可创建和管理迁移歌单"
                  : auth.configured
                    ? "应用已配置，可以连接账号"
                    : "完成一次应用配置，即可开始迁移"}
              </p>
            </div>
          </div>
          {!auth.configured && (
            <div className="setup-instructions">
              <ol>
                <li>
                  在{" "}
                  <a
                    href="https://developer.spotify.com/dashboard"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Spotify Developer Dashboard <ExternalLink size={12} />
                  </a>{" "}
                  创建应用。
                </li>
                <li>
                  把下面的地址添加到应用的 Redirect URIs：
                  <code>{auth.redirectUri}</code>
                </li>
                <li>
                  在项目的 <code className="inline-code">.env.local</code>{" "}
                  中填写：
                  <pre>{`SPOTIFY_CLIENT_ID=你的 Client ID\nAPP_URL=${auth.redirectUri.replace("/api/auth/callback", "")}\nSESSION_SECRET=至少32位随机字符串`}</pre>
                </li>
                <li>
                  重启服务，然后刷新页面。开发模式的账号资格和用户配额以 Spotify
                  控制台为准。
                </li>
              </ol>
              <p>
                <LockKeyhole size={14} />
                采用 PKCE，不需要 Client Secret。授权令牌通过加密 HttpOnly
                Cookie 保存。
              </p>
            </div>
          )}
          {auth.configured && (
            <button
              className={auth.connected ? "secondary-button" : "primary-button"}
              onClick={auth.connected ? disconnect : connect}
              disabled={!!busy}
            >
              {auth.connected ? <Unplug size={16} /> : <SpotifyMark />}
              {auth.connected ? "断开 Spotify" : "连接 Spotify"}
            </button>
          )}
          <div className="settings-netease">
            <h3>
              <Sparkles size={15} /> AI 歌曲复核
            </h3>
            <p>
              {ai.configured
                ? `已配置 ${ai.model}，通过你的中转站复核疑似歌曲。`
                : "在 .env.local 中填写中转站配置后，重启服务即可启用。"}
            </p>
            <pre className="ai-config">{`AI_BASE_URL=https://api.loe.cx/v1\nAI_API_KEY=你的中转站密钥\nAI_MODEL=gpt-6-luna\nAI_API_STYLE=chat_completions\nAI_REVIEW_CONCURRENCY=3`}</pre>
            <p>
              兼容 Chat Completions 和 Responses，可通过 AI_API_STYLE
              切换。模型名填写中转站实际支持的 ID。密钥只留在服务端；AI
              仅获取你点击复核的歌曲元数据。
            </p>
          </div>
          <div className="settings-netease">
            <h3>网易云 / QQ 音乐 / 酷狗</h3>
            <p>
              选择来源后粘贴公开歌单链接或数字 ID，无需登录来源平台。QQ
              音乐和酷狗支持公开歌单，私密歌单和未公开的「我喜欢」请先复制到公开歌单再导入。
            </p>
          </div>
        </Modal>
      )}
      {modal === "account" && (
        <Modal
          title={user ? "我的账号" : "登录 SongShift"}
          onClose={() => setModal(null)}
        >
          {user ? (
            <div className="account-profile">
              <h3>{user.username}</h3>
              <p>
                后台任务已绑定账号，换设备登录后可以继续查看和处理。退出网站账号不会停止后台任务；需要停止时请暂停任务或断开
                Spotify。
              </p>
              <button
                className="secondary-button"
                onClick={logoutAccount}
                disabled={!!busy || queue.pending}
              >
                退出登录
              </button>
            </div>
          ) : (
            <AccountForm
              onSuccess={(account) => {
                setUser(account);
                setModal(null);
                void api<AuthStatus>("/api/auth/status")
                  .then(setAuth)
                  .catch(errorMessage);
                setMessage({
                  kind: "success",
                  text: "登录成功，可以创建后台任务。",
                });
              }}
            />
          )}
        </Modal>
      )}
      {modal === "help" && (
        <Modal title="带着喜欢的音乐出发" onClose={() => setModal(null)}>
          <div className="help-steps">
            <div>
              <span>01</span>
              <section>
                <h3>复制网易云、QQ 音乐或酷狗公开歌单链接</h3>
                <p>
                  打开歌单，选择分享并复制链接。选择对应来源后，也可以直接输入歌单数字
                  ID。私密歌单请先调整公开状态。
                </p>
              </section>
            </div>
            <div>
              <span>02</span>
              <section>
                <h3>连接 Spotify，逐首匹配</h3>
                <p>
                  通过 Spotify
                  官方页面授权。我们比较歌名、歌手、专辑和时长；不同版本与不确定结果会留给你确认。服务限流时会保留进度，可稍后继续。
                </p>
              </section>
            </div>
            <div>
              <span>03</span>
              <section>
                <h3>确认后，创建一张新歌单</h3>
                <p>
                  只迁移已勾选的歌曲，保持原始顺序。来源平台的原歌单不会被修改；没有找到的歌曲可以随匹配报告导出。
                </p>
              </section>
            </div>
          </div>
          <div className="privacy-note">
            <ShieldCheck size={20} />
            <p>
              这里只处理歌曲信息，不下载或上传音频。后台任务与进度保存在账号下，换设备登录也能继续；授权令牌加密保存，用于隔天续跑。退出网站账号不影响任务，断开
              Spotify 会暂停后台任务。演示数据不会写入你的账号。
            </p>
          </div>
          <button
            className="secondary-button"
            onClick={() => {
              setModal(null);
              openDemo();
            }}
            disabled={!!busy}
          >
            用示例歌单试试看
            <ArrowRight size={15} />
          </button>
        </Modal>
      )}
      {modal === "confirm" && (
        <Modal
          title={demo ? "体验歌单迁移" : "准备迁移这些喜欢"}
          onClose={() => setModal(null)}
        >
          <div className="confirm-art">
            <Music2 size={27} />
            <ArrowRight size={20} />
            <SpotifyMark />
          </div>
          <p className="confirm-description">
            {demo
              ? "将模拟迁移到 Spotify，不会向你的账号写入内容。"
              : "确认后由服务器在你的 Spotify 账号中新建歌单、分批写入所选歌曲。关闭网页后仍会继续，可在后台任务查看进度。"}
          </p>
          <dl className="confirm-details">
            <div>
              <dt>歌单名称</dt>
              <dd>{name}</dd>
            </div>
            <div>
              <dt>已选歌曲</dt>
              <dd>{selected.length} 首</dd>
            </div>
            <div>
              <dt>公开状态</dt>
              <dd>{isPublic ? "公开歌单" : "私密歌单"}</dd>
            </div>
            <div>
              <dt>本次跳过</dt>
              <dd>{matches.length - selected.length} 首</dd>
            </div>
          </dl>
          <p className="confirm-note">
            歌曲将按来源歌单中的原始顺序添加。
            {counts.pending > 0 &&
              `还有 ${counts.pending} 首未匹配，本次不会添加。`}
          </p>
          <button className="primary-button full-width" onClick={transfer}>
            {demo ? "确认体验" : "确认并开始后台写入"}
            <ArrowRight size={16} />
          </button>
        </Modal>
      )}
      {modal === "history" && (
        <Modal title="后台任务" onClose={() => setModal(null)}>
          <p className="task-intro">
            匹配和 AI
            复核都在服务器运行。关闭网页不影响处理；遇到限流自动等待，恢复后继续。登录同一账号即可跨设备查看。
          </p>
          {!user && (
            <button
              className="primary-button"
              onClick={() => setModal("account")}
            >
              登录后查看我的任务
            </button>
          )}
          {queue.quota && (
            <p className="task-quota-summary">
              近 24 小时已搜索 {queue.quota.used} 次 · 无本站每日上限，按
              Spotify 限流自动等待
            </p>
          )}
          <div className="task-list">
            {(user ? queue.tasks : []).map((item) => (
              <div className="task-card" key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <span className={`task-status task-${item.status}`}>
                    {taskLabels[item.status]}
                  </span>
                </div>
                <p>
                  已完成 {item.completed} / {item.total} 首
                  {item.id === taskId ? " · 当前任务" : ""}
                </p>
                <p>
                  AI 已复核 {item.aiReviewed || 0} 首 · 复核通过{" "}
                  {item.aiMatched || 0} · 跳过 {item.aiSkipped || 0} · 不确定{" "}
                  {item.aiUncertain || 0}
                </p>
                {item.transferJob && (
                  <p>Spotify 写入 {item.transferJob.added} / {item.transferJob.total} 首 · {transferJobLabels[item.transferJob.status]}
                    {item.transferJob.resumeAt > 0 ? ` · ${new Date(item.transferJob.resumeAt).toLocaleString("zh-CN")} 后继续` : ""}
                    {item.transferJob.error ? ` · ${item.transferJob.error}` : ""}
                  </p>
                )}
                {item.aiJob && (
                  <p>
                    AI 本轮已处理 {item.aiJob.completed + (item.aiJob.blocked?.length || 0)} / {item.aiJob.total} 首 · 证据不足 {item.aiJob.blocked?.length || 0} 首 ·{" "}
                    {aiJobLabels[item.aiJob.status]}
                    {item.aiJob.current.length
                      ? `：${item.aiJob.current.join("、")}`
                      : ""}
                  </p>
                )}
                <div className="task-mini-progress">
                  <span
                    style={{
                      width: `${item.total ? (item.completed / item.total) * 100 : 0}%`,
                    }}
                  />
                </div>
                {item.resumeAt > 0 && (
                  <p>
                    预计继续：{new Date(item.resumeAt).toLocaleString("zh-CN")}
                  </p>
                )}
                {item.error && <p className="task-error">{item.error}</p>}
                <div className="task-card-actions">
                  <button
                    className="secondary-button"
                    disabled={!!busy || queue.pending}
                    onClick={() => void queue.open(item.id)}
                  >
                    打开任务 <ArrowRight size={13} />
                  </button>
                  <button
                    className="text-button"
                    disabled={!!busy || queue.pending || (!!item.transferJob && item.transferJob.status !== "complete")}
                    onClick={() => {
                      if (
                        window.confirm(
                          `删除“${item.name}”的后台任务和匹配结果？Spotify 歌单不会受影响。`,
                        )
                      )
                        void queue.remove(item.id);
                    }}
                  >
                    删除任务
                  </button>
                </div>
              </div>
            ))}
          </div>
          {queue.syncError && <p className="task-error">{queue.syncError}</p>}
          {playlist ? (
            <div className="session-summary">
              <ListMusic size={34} />
              <h3>{playlist.name}</h3>
              <p>
                {demo ? "示例模式 · " : ""}共 {matches.length} 首，已匹配{" "}
                {completed} 首，选择了 {selected.length} 首。
              </p>
              <p>
                {result
                  ? result.complete
                    ? "本次迁移已完成。"
                    : "本次迁移部分完成，请检查目标歌单。"
                  : taskId
                    ? "已保存为后台任务，可跨天继续。"
                    : "当前进度保存在此浏览器；点击创建后台任务后可关闭网页。"}
              </p>
              <button className="secondary-button" onClick={() => exportCsv()}>
                导出当前报告
                <ArrowDownToLine size={15} />
              </button>
            </div>
          ) : (
            <div className="session-summary">
              <Headphones size={35} />
              <h3>还没有开始的旅程</h3>
              <p>读取第一张歌单后，可以在这里查看进度。</p>
            </div>
          )}
        </Modal>
      )}
      {review && (
        <Modal title="选择合适的歌曲版本" onClose={() => setReviewId(null)}>
          <div className="review-source">
            <span>{sourceName}原曲</span>
            <h3>{review.source.name}</h3>
            <p>
              {review.source.artists.join(" / ")} · {review.source.album} ·{" "}
              {Math.floor(review.source.durationMs / 60000)}:
              {String(
                Math.floor(review.source.durationMs / 1000) % 60,
              ).padStart(2, "0")}
            </p>
          </div>
          <div className="ai-advice">
            <div>
              <Sparkles size={16} />
              <strong>AI 复核建议</strong>
              <button
                className="text-button"
                disabled={!!busy || writeStarted}
                onClick={() => runAiReview([review])}
              >
                {busy === "ai"
                  ? "正在复核…"
                  : review.aiReview
                    ? "AI 重新搜索并复核"
                    : "请 AI 帮我看看"}
              </button>
              {!demo && ai.webSearch && (
                <button
                  className="text-button"
                  disabled={!!busy || writeStarted}
                  onClick={() => runAiReview([review], true)}
                >
                  <Search size={13} />
                  联网查原唱
                </button>
              )}
            </div>
            {review.aiReview ? (
              <>
                <p>
                  <strong>
                    {review.aiSelected
                      ? review.aiReview.matchKind === "original_alternative"
                        ? "已自动选择原唱替代版本 · 非原曲录音"
                        : review.aiReview.matchKind === "live_alternative"
                          ? "已自动选择其他现场版本 · 同曲同歌手"
                          : "AI 已自动选择并勾选"
                      : aiDecisionLabels[review.aiReview.decision]}
                  </strong>
                </p>
                <p>{review.aiReview.reason}</p>
                {review.aiReview.reviewedAt && (
                  <p>
                    复核完成于{" "}
                    {new Date(review.aiReview.reviewedAt).toLocaleString(
                      "zh-CN",
                    )}
                  </p>
                )}
                {review.aiReview.research ? (
                  <div className="ai-research">
                    <strong>
                      联网核实 · 原唱：
                      {review.aiReview.research.originalArtist || "尚未确认"}
                    </strong>
                    <p>{review.aiReview.research.summary}</p>
                    <ul>
                      {review.aiReview.research.sources.map((source) => (
                        <li key={source.url}>
                          <a href={source.url} target="_blank" rel="noreferrer">
                            {source.title}
                            <ExternalLink size={12} />
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p>此建议尚无联网来源，可点击「联网查原唱」重新核实。</p>
                )}
                {review.aiReview.searchWarning && (
                  <p className="task-error">{review.aiReview.searchWarning}</p>
                )}
                {!!review.aiReview.spotifySearches?.length && (
                  <details className="ai-research">
                    <summary>查看 Spotify 搜索记录（{review.aiReview.spotifySearches.length} 轮）</summary>
                    <ol>
                      {review.aiReview.spotifySearches.map((search, index) => (
                        <li key={index}>
                          <strong>{search.query}</strong>
                          <p>{search.reason} · 找到 {search.candidateIds.length} 个候选</p>
                          {search.candidateIds.map((id) => {
                            const candidate = [...review.candidates, ...(review.excludedCandidates || [])].find((c) => c.id === id);
                            return <p key={id}><a href={`https://open.spotify.com/track/${id}`} target="_blank" rel="noreferrer">{candidate ? `${candidate.name} · ${candidate.artists.join(" / ")}` : "在 Spotify 查看候选"}</a></p>;
                          })}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                <span>
                  {review.aiReview.model} · 判断把握：
                  {
                    { high: "较高", medium: "一般", low: "较低" }[
                      review.aiReview.confidence
                    ]
                  }
                </span>
                {review.aiReview.candidateId && (
                  <p>
                    {review.aiSelected ? "已选择：" : "复核候选："}
                    {
                      review.candidates.find(
                        (c) => c.id === review.aiReview?.candidateId,
                      )?.name
                    }
                    {review.aiSelected
                      ? "。已加入待迁移歌曲。"
                      : review.confirmedByUser
                        ? "。保留你的手动选择。"
                        : "。证据或把握不足时暂不自动选中，可继续联网复核。"}
                  </p>
                )}
              </>
            ) : (
              <p>核对艺人别名、简繁体歌名和录音版本，确认后自动选择。</p>
            )}
          </div>
          <p className="candidate-intro">
            {review.aiSelected
              ? "已选中 AI 确认的版本，并隐藏其他歌手的候选。"
              : "已隐藏烟嗓、翻唱等与原曲不符的版本。"}
            {!!excludedCandidates.length &&
              ` 已排除 ${excludedCandidates.length} 个候选，可在下方展开查看。`}
          </p>
          <div className="candidates">
            {!reviewCandidates.length && (
              <p className="candidate-intro">
                暂未找到可用的原版，AI 不会拿不符版本凑数。
              </p>
            )}
            {reviewCandidates.map((candidate) => (
              <div className="candidate" key={candidate.id}>
                <div>
                  <h3>{candidate.name}</h3>
                  <p>
                    {candidate.artists.join(" / ")} · {candidate.album}
                  </p>
                  <span>
                    匹配分 {candidate.score}
                    {candidate.durationDiff !== null &&
                      ` · 时长相差 ${(candidate.durationDiff / 1000).toFixed(1)} 秒`}
                  </span>
                  {candidate.url && (
                    <a href={candidate.url} target="_blank" rel="noreferrer">
                      在 Spotify 查看
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
                <button
                  className="secondary-button"
                  disabled={
                    !!busy ||
                    writeStarted ||
                    (review.included && review.selected?.id === candidate.id)
                  }
                  onClick={() => chooseCandidate(candidate)}
                >
                  <Check size={14} />
                  {review.included && review.selected?.id === candidate.id
                    ? "已选择"
                    : "改用此版本"}
                </button>
              </div>
            ))}
          </div>
          {!!excludedCandidates.length && (
            <details className="excluded-candidates" key={review.source.id}>
              <summary>查看已排除候选（{excludedCandidates.length}）</summary>
              <p className="candidate-intro">
                这里保留未采用的版本，方便核对。展开查看不会改变当前选择。
              </p>
              <div className="candidates">
                {excludedCandidates.map(({ candidate, reason }) => (
                  <div className="candidate" key={candidate.id}>
                    <div>
                      <h3>{candidate.name}</h3>
                      <p>
                        {candidate.artists.join(" / ")} · {candidate.album}
                      </p>
                      <span>
                        匹配分 {candidate.score}
                        {candidate.durationDiff !== null &&
                          ` · 时长相差 ${(candidate.durationDiff / 1000).toFixed(1)} 秒`}
                      </span>
                      <p className="exclusion-reason">{reason}</p>
                      {candidate.url && (
                        <a
                          href={candidate.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          在 Spotify 查看
                          <ExternalLink size={12} />
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
          <button
            disabled={!!busy || writeStarted}
            className="text-button skip-button"
            onClick={() => {
              setMatches((old) =>
                old.map((m) =>
                  m.source.id === reviewId
                    ? {
                        ...m,
                        included: false,
                        confirmedByUser: true,
                        aiSelected: false,
                      }
                    : m,
                ),
              );
              setReviewId(null);
            }}
          >
            跳过这首歌曲
            <ArrowRight size={14} />
          </button>
        </Modal>
      )}
    </div>
  );
}

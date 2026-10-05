import { AppError } from "./http";
import { applyAiReview, makeMatch, scoreCandidate } from "./matching";
import { validateReview } from "./ai";
import { safeSourceUrl } from "./ai-research";
import type { Candidate, Match, Playlist, Song } from "./types";

export function validSong(value: unknown): value is Song {
  if (!value || typeof value !== "object") return false;
  const s = value as Song;
  return (
    typeof s.id === "string" &&
    s.id.length > 0 &&
    s.id.length <= 100 &&
    typeof s.name === "string" &&
    !!s.name.trim() &&
    s.name.length <= 500 &&
    typeof s.album === "string" &&
    s.album.length <= 500 &&
    Array.isArray(s.artists) &&
    s.artists.length <= 30 &&
    s.artists.every((a) => typeof a === "string" && a.length <= 200) &&
    Number.isFinite(s.durationMs) &&
    s.durationMs >= 0
  );
}
export function validatePlaylist(value: unknown): Playlist {
  const p = value as Playlist;
  if (
    !p ||
    typeof p.id !== "string" ||
    p.id.length > 100 ||
    typeof p.name !== "string" ||
    p.name.length > 500 ||
    typeof p.creator !== "string" ||
    p.creator.length > 500 ||
    !Array.isArray(p.songs) ||
    !p.songs.length ||
    p.songs.length > 10000 ||
    !p.songs.every(validSong)
  )
    throw new AppError("歌单无效，单个任务最多 10,000 首歌曲。");
  return {
    ...p,
    songs: p.songs.map((s) => ({
      id: s.id,
      name: s.name,
      artists: s.artists,
      album: s.album,
      durationMs: s.durationMs,
      cover: safeCover(s.cover),
    })),
    cover: safeCover(p.cover),
    total: Math.max(p.songs.length, Number(p.total) || 0),
    missing: Math.max(0, Number(p.missing) || 0),
  };
}
function safeCover(value: unknown) {
  return typeof value === "string" &&
    value.length < 2000 &&
    value.startsWith("https://")
    ? value
    : undefined;
}
export function validateSavedMatch(
  value: unknown,
  original: Match,
): Match | null {
  const incoming = value as Match;
  if (!incoming || typeof incoming !== "object")
    throw new AppError("保存内容无效。");
  if (
    incoming.confirmedByUser &&
    incoming.selected &&
    !original.candidates.some((c) => c.id === incoming.selected!.id)
  )
    throw new AppError("候选歌曲不属于这个任务。");
  // Stored candidates and an equally recent server review are authoritative.
  // This also keeps web evidence when an older page saves the same review date.
  const savedReview =
    original.aiReview &&
    (original.aiReview.reviewedAt || 0) >= (incoming.aiReview?.reviewedAt || 0)
      ? original.aiReview
      : undefined;
  const match = validateMatch(
    {
      ...incoming,
      candidates: original.candidates,
      aiReview: savedReview || incoming.aiReview,
    },
    original.source,
  );
  return match && savedReview ? applyAiReview(match, savedReview) : match;
}
export function validateMatch(value: unknown, source: Song): Match | null {
  const m = value as Match;
  if (!m || m.status === "pending") return null;
  if (
    !["matched", "review", "missing"].includes(m.status) ||
    !Array.isArray(m.candidates) ||
    m.candidates.length > 5
  )
    throw new AppError("已保存的匹配结果格式不正确。");
  const candidates = m.candidates.map((c: Candidate) => {
    if (
      !validSong(c) ||
      !/^[A-Za-z0-9]{22}$/.test(c.id) ||
      c.uri !== `spotify:track:${c.id}`
    )
      throw new AppError("匹配候选无效。");
    return scoreCandidate(source, {
      ...c,
      cover: safeCover(c.cover),
      url: `https://open.spotify.com/track/${c.id}`,
    });
  });
  const base = makeMatch(source, candidates);
  const chosen = m.selected
    ? candidates.find((c) => c.id === m.selected!.id)
    : null;
  if (m.confirmedByUser) {
    base.selected = chosen || null;
    base.status = chosen ? "matched" : "review";
    base.confirmedByUser = true;
  }
  base.included = !!m.included && !!base.selected && base.status === "matched";
  if (
    m.aiReview &&
    typeof m.aiReview.reason === "string" &&
    m.aiReview.reason.length <= 1000 &&
    ["match", "skip", "uncertain"].includes(m.aiReview.decision)
  ) {
    const checked = validateReview(
      m.aiReview,
      candidates,
      String(m.aiReview.model || "AI").slice(0, 100),
    );
    // Keep old review dates absent rather than treating a browser save as a fresh review.
    checked.reviewedAt = Number.isFinite(m.aiReview.reviewedAt)
      ? m.aiReview.reviewedAt
      : undefined;
    if (typeof m.aiReview.searchWarning === "string")
      checked.searchWarning = m.aiReview.searchWarning.slice(0, 1000);
    const research = m.aiReview.research;
    if (
      research &&
      typeof research.summary === "string" &&
      Array.isArray(research.sources)
    ) {
      checked.research = {
        summary: research.summary.slice(0, 2000),
        originalArtist:
          typeof research.originalArtist === "string"
            ? research.originalArtist.slice(0, 200)
            : null,
        queries: [],
        searchedAt: Number.isFinite(research.searchedAt)
          ? research.searchedAt
          : 0,
        sources: research.sources.slice(0, 6).flatMap((s) => {
          const url = safeSourceUrl(s?.url);
          return url && typeof s.title === "string"
            ? [{ url, title: s.title.slice(0, 200) }]
            : [];
        }),
      };
    }
    return applyAiReview(base, checked);
  }
  return base;
}

import type { AiReview, Candidate, Match, Song } from "./types";

export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]|（[^）]*）/g, " ")
    .replace(/[-–—_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function versions(name: string) {
  return [
    "live",
    "remix",
    "acoustic",
    "instrumental",
    "karaoke",
    "伴奏",
    "现场",
    "翻唱",
  ]
    .filter((tag) =>
      new RegExp(/[a-z]/.test(tag) ? `\\b${tag}\\b` : tag, "i").test(name),
    )
    .join("|");
}

export function needsArtistResearch(source: Song, candidates: Candidate[]) {
  const best = candidates[0];
  return (
    !best ||
    normalize(source.name) !== normalize(best.name) ||
    !source.artists.some((a) =>
      best.artists.some((b) => normalize(a) === normalize(b)),
    )
  );
}

export function scoreCandidate(
  source: Song,
  track: Song & { uri: string; url: string },
): Candidate {
  const a = normalize(source.name);
  const b = normalize(track.name);
  const titleScore =
    a && b ? (a === b ? 60 : a.includes(b) || b.includes(a) ? 35 : 0) : 0;
  const artistMatch = source.artists.some((artist) =>
    track.artists.some((other) => normalize(artist) === normalize(other)),
  );
  const durationDiff =
    source.durationMs > 0 && track.durationMs > 0
      ? Math.abs(source.durationMs - track.durationMs)
      : null;
  const durationScore =
    durationDiff === null
      ? 0
      : durationDiff < 3000
        ? 20
        : durationDiff < 8000
          ? 12
          : durationDiff < 15000
            ? 5
            : 0;
  const albumMatch =
    normalize(source.album) &&
    normalize(source.album) === normalize(track.album);
  const versionMatch = versions(source.name) === versions(track.name);
  const score = Math.max(
    0,
    titleScore +
      (artistMatch ? 25 : 0) +
      durationScore +
      (albumMatch ? 10 : 0) -
      (versionMatch ? 0 : 35),
  );
  return {
    ...track,
    score,
    durationDiff,
    confident:
      score >= 70 &&
      artistMatch &&
      titleScore >= 35 &&
      versionMatch &&
      (durationDiff === null || durationDiff < 15000),
  };
}

export function makeMatch(source: Song, candidates: Candidate[]): Match {
  const sorted = [...candidates].sort(
    (a, b) =>
      b.score - a.score ||
      (a.durationDiff ?? Infinity) - (b.durationDiff ?? Infinity),
  );
  const selected = sorted[0] ?? null;
  return {
    source,
    candidates: sorted,
    selected,
    status: !selected ? "missing" : selected.confident ? "matched" : "review",
    included: !!selected?.confident,
  };
}

export function parsePlaylistId(value: string): string | null {
  const input = value.trim();
  if (/^[1-9]\d{0,19}$/.test(input)) return input;
  const embedded = input.match(/https?:\/\/[^\s「」<>]+/i)?.[0];
  if (!embedded) return null;
  try {
    const url = new URL(embedded);
    if (url.hostname !== "music.163.com" && url.hostname !== "y.music.163.com")
      return null;
    const route = url.pathname + url.hash;
    if (!/\/playlist(?:[/?#]|$)/.test(route)) return null;
    const id =
      url.searchParams.get("id") ||
      new URLSearchParams(url.hash.split("?")[1]).get("id") ||
      route.match(/\/playlist\/(\d+)/)?.[1];
    return id && /^[1-9]\d{0,19}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function matchesToCsv(matches: Match[]): string {
  const escape = (value: unknown) => {
    let text = String(value ?? "");
    if (/^[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const rows = matches.map((match) => [
    match.source.name,
    match.source.artists.join(" / "),
    match.selected?.name,
    match.selected?.artists.join(" / "),
    match.selected?.url,
    match.selected?.score,
    match.selected?.durationDiff,
    match.status,
    match.included ? "yes" : "no",
    match.aiReview?.decision,
    match.aiReview?.candidateId,
    match.aiReview?.reason,
    match.aiReview?.matchKind,
    match.aiReview?.research?.originalArtist,
    match.aiReview?.research?.summary,
    match.aiReview?.research?.sources.map((s) => s.url).join(" | "),
  ]);
  return (
    "\uFEFF" +
    [
      "netease_name,netease_artist,spotify_name,spotify_artist,spotify_url,score,duration_diff_ms,status,included,ai_decision,ai_candidate_id,ai_reason,ai_match_kind,original_artist,research_summary,research_sources",
      ...rows.map((row) => row.map(escape).join(",")),
    ].join("\r\n")
  );
}

export function needsAiReview(match: Match): boolean {
  return (
    !match.confirmedByUser &&
    !match.aiReview &&
    (match.status === "missing" ||
      match.status === "review" ||
      (match.status === "matched" &&
        !!match.selected &&
        (match.selected.score < 100 ||
          normalize(match.source.name) !== normalize(match.selected.name) ||
          (match.selected.durationDiff ?? 0) >= 8000)))
  );
}

export function applyAiReview(match: Match, advice: AiReview): Match {
  const agrees =
    advice.decision === "match" &&
    advice.confidence === "high" &&
    advice.matchKind !== "original_alternative" &&
    advice.candidateId === match.selected?.id;
  return {
    ...match,
    aiReview: advice,
    ...(!match.confirmedByUser && !agrees
      ? { status: "review" as const, included: false }
      : {}),
  };
}

import type { AiReview, Candidate, Match, Song } from "./types";
import { Converter } from "opencc-js/t2cn";

const simplify = Converter({ from: "t", to: "cn" });

export function normalize(text: string): string {
  return simplify(text.normalize("NFKC"))
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]|（[^）]*）/g, " ")
    .replace(/[-–—_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function versions(name: string) {
  const text = simplify(name.normalize("NFKC"));
  return [
    "live",
    "remix",
    "acoustic",
    "instrumental",
    "karaoke",
    "cover",
    "伴奏",
    "现场",
    "翻唱",
    "烟嗓",
    "女声版",
    "男声版",
    "加速版",
    "降速版",
    "卡拉OK",
  ]
    .filter((tag) =>
      new RegExp(/^[a-z]+$/.test(tag) ? `\\b${tag}\\b` : tag, "i").test(text),
    )
    .join("|");
}

export function excludedVersion(source: Song, candidate: Song): boolean {
  // Inspect version labels before stripping parentheses for title comparison.
  const sourceVersions = new Set(
    versions(`${source.name} ${source.album}`).split("|"),
  );
  return versions(`${candidate.name} ${candidate.album}`)
    .split("|")
    .some((tag) => tag && !sourceVersions.has(tag));
}

export function rankedCandidates(
  source: Song,
  candidates: Candidate[],
): Candidate[] {
  return candidates
    .map((c) => scoreCandidate(source, c))
    .sort(
      (a, b) =>
        Number(excludedVersion(source, a)) -
          Number(excludedVersion(source, b)) ||
        b.score - a.score ||
        (a.durationDiff ?? Infinity) - (b.durationDiff ?? Infinity),
    );
}

function automaticCandidate(
  match: Match,
  advice: AiReview,
): Candidate | undefined {
  if (advice.decision !== "match" || advice.confidence !== "high") return;
  const candidate = match.candidates.find((c) => c.id === advice.candidateId);
  if (!candidate || excludedVersion(match.source, candidate)) return;
  const differentArtist = !match.source.artists.some((a) =>
    candidate.artists.some((b) => normalize(a) === normalize(b)),
  );
  if (
    (differentArtist || advice.matchKind === "original_alternative") &&
    !advice.research?.sources.length
  )
    return;
  if (
    advice.matchKind === "original_alternative" &&
    !advice.research?.originalArtist
  )
    return;
  return candidate;
}

export function visibleCandidates(match: Match): Candidate[] {
  const candidates = rankedCandidates(match.source, match.candidates).filter(
    (c) =>
      !excludedVersion(match.source, c) ||
      (match.confirmedByUser && match.selected?.id === c.id),
  );
  if (match.aiReview?.decision === "skip" && !match.confirmedByUser) return [];
  if (match.aiSelected && match.selected) {
    return candidates
      .filter(
        (c) =>
          c.id === match.selected!.id ||
          c.artists.some((a) =>
            match.selected!.artists.some((b) => normalize(a) === normalize(b)),
          ),
      )
      .sort(
        (a, b) =>
          Number(b.id === match.selected!.id) -
          Number(a.id === match.selected!.id),
      );
  }
  return candidates;
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
  const sorted = rankedCandidates(source, candidates);
  const selected = sorted.find((c) => !excludedVersion(source, c)) ?? null;
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
    (!match.aiReview ||
      (match.aiReview.decision === "match" &&
        match.aiReview.confidence === "high" &&
        !automaticCandidate(match, match.aiReview))) &&
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
  const candidates = rankedCandidates(match.source, match.candidates);
  if (match.confirmedByUser)
    return { ...match, candidates, aiReview: advice, aiSelected: false };
  const selected = automaticCandidate({ ...match, candidates }, advice) || null;
  return {
    ...match,
    candidates: selected
      ? [selected, ...candidates.filter((c) => c.id !== selected.id)]
      : candidates,
    aiReview: advice,
    selected,
    status: selected ? "matched" : "review",
    included: !!selected,
    aiSelected: !!selected,
  };
}

export function reconcileMatch(match: Match): Match {
  if (match.status === "pending") return match;
  if (match.aiReview) return applyAiReview(match, match.aiReview);
  if (match.confirmedByUser)
    return {
      ...match,
      candidates: rankedCandidates(match.source, match.candidates),
    };
  const fresh = makeMatch(match.source, match.candidates);
  return { ...match, ...fresh, included: match.included && fresh.included };
}

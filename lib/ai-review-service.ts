import { aiStatus, reviewWithAi } from "./ai";
import { needsArtistResearch, researchArtist } from "./ai-research";
import { AppError } from "./http";
import { excludedVersion, normalize, rankedCandidates } from "./matching";
import { searchCandidates } from "./spotify";
import type { TaskStore } from "./task-store";
import type { AiReviewResponse, Candidate, Song } from "./types";

export async function reviewSong(
  source: Song,
  candidates: Candidate[],
  options: {
    forceSearch?: boolean;
    token?: string;
    store?: TaskStore;
    canExpand?: boolean;
  } = {},
  dependencies = {
    research: researchArtist,
    search: searchCandidates,
    review: reviewWithAi,
  },
): Promise<AiReviewResponse> {
  candidates = rankedCandidates(source, candidates).filter(
    (c) => !excludedVersion(source, c),
  );
  const needsSearch =
    options.forceSearch || needsArtistResearch(source, candidates);
  const research =
    aiStatus().webSearch && needsSearch
      ? await dependencies.research(source, candidates)
      : undefined;
  if (options.forceSearch && !research)
    throw new AppError("联网核实尚未配置，请先开启 AI_WEB_SEARCH。", 503);
  let selectedCandidates = candidates;
  let searchWarning: string | undefined;
  if (research && options.canExpand && options.store && options.token) {
    const supplemental = new Map<string, Candidate>();
    for (const query of research.queries) {
      try {
        options.store.reserveSearch();
        const text = `track:"${query.title.replaceAll('"', " ")}" artist:"${query.artist.replaceAll('"', " ")}"`;
        for (const candidate of await dependencies.search(
          options.token,
          source,
          text,
        ))
          if (!supplemental.has(candidate.id))
            supplemental.set(candidate.id, candidate);
      } catch (error) {
        if (error instanceof AppError && error.status === 429) {
          options.store.cooldown(
            error.retryAfter || 60,
            error.reason || "RATE_LIMITED",
          );
          searchWarning = `原唱资料已核实；Spotify 补搜限流，${new Date(options.store.quota().resumeAt).toISOString()} 后可点击「联网查原唱」继续。`;
        } else
          searchWarning =
            "联网资料已保留，Spotify 补搜未完成；请稍后点击「联网查原唱」重试。";
        break;
      }
    }
    // Prioritize the artists supported by research, without relaxing matching scores.
    const targetArtists = research.queries.map((q) => normalize(q.artist));
    const extra = [...supplemental.values()].sort((a, b) => {
      const targeted = (c: Candidate) => {
        const index = targetArtists.findIndex((a) =>
          c.artists.some((b) => normalize(b) === a),
        );
        return index < 0 ? 0 : targetArtists.length - index;
      };
      return targeted(b) - targeted(a) || b.score - a.score;
    });
    const merged = new Map<string, Candidate>();
    for (const c of [
      ...candidates.slice(0, 1),
      ...extra,
      ...candidates.slice(1),
    ])
      if (!merged.has(c.id)) merged.set(c.id, c);
    selectedCandidates = [...merged.values()]
      .filter((c) => !excludedVersion(source, c))
      .slice(0, 5);
  }
  const review = await dependencies.review(
    source,
    selectedCandidates,
    research,
  );
  const suggested = selectedCandidates.find((c) => c.id === review.candidateId);
  if (
    !research &&
    aiStatus().webSearch &&
    suggested &&
    needsArtistResearch(source, [suggested])
  )
    return reviewSong(
      source,
      candidates,
      { ...options, forceSearch: true },
      dependencies,
    );
  if (review.matchKind === "original_alternative" && !research?.originalArtist)
    throw new AppError("缺少原唱核实依据，未采纳替代建议。", 502);
  return {
    ...review,
    ...(searchWarning ? { searchWarning } : {}),
    ...(options.canExpand ? { candidates: selectedCandidates } : {}),
  };
}

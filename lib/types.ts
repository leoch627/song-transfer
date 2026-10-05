export type Song = {
  id: string;
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
  cover?: string;
};
export type Playlist = {
  id: string;
  name: string;
  creator: string;
  cover?: string;
  total: number;
  songs: Song[];
  missing: number;
};
export type Candidate = Song & {
  uri: string;
  url: string;
  score: number;
  durationDiff: number | null;
  confident: boolean;
};
export type Match = {
  source: Song;
  candidates: Candidate[];
  excludedCandidates?: Candidate[];
  selected: Candidate | null;
  status: "pending" | "matched" | "review" | "missing";
  included: boolean;
  aiReview?: AiReview;
  confirmedByUser?: boolean;
  aiSelected?: boolean;
};
export type AiReview = {
  decision: "match" | "skip" | "uncertain";
  candidateId: string | null;
  confidence: "high" | "medium" | "low";
  reason: string;
  model: string;
  matchKind?: "same_recording" | "original_alternative" | "no_match";
  reviewedAt?: number;
  reviewVersion?: number;
  research?: ArtistResearch;
  searchWarning?: string;
};
export type ArtistResearch = {
  summary: string;
  originalArtist: string | null;
  queries: { title: string; artist: string }[];
  sources: { title: string; url: string }[];
  searchedAt: number;
};
export type AiReviewResponse = AiReview & {
  candidates?: Candidate[];
  excludedCandidates?: Candidate[];
};
export type AiStatus = {
  configured: boolean;
  model: string;
  concurrency?: number;
  webSearch?: boolean;
};
export type AuthStatus = {
  configured: boolean;
  connected: boolean;
  displayName?: string;
  redirectUri: string;
};

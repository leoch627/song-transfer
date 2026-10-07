export type Song = {
  id: string;
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
  cover?: string;
};
export type PlaylistProvider = "netease" | "qq" | "kugou";
export type Playlist = {
  // Older saved tasks have no provider and continue to mean NetEase.
  provider?: PlaylistProvider;
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
  matchKind?: "same_recording" | "original_alternative" | "live_alternative" | "no_match";
  reviewedAt?: number;
  reviewVersion?: number;
  research?: ArtistResearch;
  searchWarning?: string;
  spotifySearches?: SpotifySearchRecord[];
};
export type SpotifySearchRecord = {
  query: string;
  reason: string;
  candidateIds: string[];
  searchedAt: number;
};
export type AiSearchCheckpoint = {
  version: 1;
  candidates: Candidate[];
  searches: SpotifySearchRecord[];
  rounds: number;
  pending?: { query: string; reason: string };
  finished?: boolean;
  research?: ArtistResearch;
  researchDone?: boolean;
  researchWarning?: string;
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
  writeReady?: boolean;
  configured: boolean;
  connected: boolean;
  displayName?: string;
  redirectUri: string;
  /** The user's own Spotify app Client ID, when they set one (not a secret). */
  customClientId?: string;
  /** Whether the site-wide default Spotify app is available. */
  defaultAppAvailable?: boolean;
};

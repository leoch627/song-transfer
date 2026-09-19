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
  selected: Candidate | null;
  status: "pending" | "matched" | "review" | "missing";
  included: boolean;
  aiReview?: AiReview;
  confirmedByUser?: boolean;
};
export type AiReview = {
  decision: "match" | "skip" | "uncertain";
  candidateId: string | null;
  confidence: "high" | "medium" | "low";
  reason: string;
  model: string;
};
export type AiStatus = { configured: boolean; model: string };
export type AuthStatus = {
  configured: boolean;
  connected: boolean;
  displayName?: string;
  redirectUri: string;
};

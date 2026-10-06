import type { Match } from "./types";
import type { TaskWorkspace } from "./task-types";

export type TaskSnapshot = { matches: Match[]; workspace: TaskWorkspace };
export function mergeTaskSnapshot(
  remote: TaskSnapshot,
  local: TaskSnapshot,
  baseline: TaskSnapshot | null,
): TaskSnapshot {
  if (!baseline) return remote;
  const matches = remote.matches.map((match, index) => {
    const edited = local.matches[index],
      previous = baseline.matches[index];
    return edited &&
      previous &&
      previous.status !== "pending" &&
      JSON.stringify(edited) !== JSON.stringify(previous)
      ? edited
      : match;
  });
  const workspace = { ...remote.workspace };
  for (const key of ["name", "isPublic"] as const) {
    if (
      !remote.workspace.writeStarted &&
      JSON.stringify(local.workspace[key]) !==
      JSON.stringify(baseline.workspace[key])
    )
      Object.assign(workspace, { [key]: local.workspace[key] });
  }
  // Only the server knows whether a write was accepted and how far it got.
  // In particular, a rejected request must clear the old browser-only guard.
  return { matches, workspace };
}

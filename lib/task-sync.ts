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
  for (const key of ["name", "isPublic", "result", "writeStarted"] as const) {
    if (
      JSON.stringify(local.workspace[key]) !==
      JSON.stringify(baseline.workspace[key])
    )
      Object.assign(workspace, { [key]: local.workspace[key] });
  }
  // A write started on another device must always block a second submission.
  if (remote.workspace.writeStarted) workspace.writeStarted = true;
  return { matches, workspace };
}

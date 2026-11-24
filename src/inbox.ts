import { openAssumptions, prUrl, type Job, type Note, type Snapshot } from "./backend/types.ts";

/** Something that waits on the user, as the Inbox lists it. */
export type InboxItem =
  | { kind: "ask"; job: Job; note: Note }
  | { kind: "checkpoint"; job: Job }
  | { kind: "failed"; job: Job }
  | { kind: "review"; job: Job }
  | { kind: "assume"; job: Job; note: Note & { index: number } }
  | { kind: "unverified"; job: Job; need: string };

/**
 * What waits on the user: `stopped` holds work until they act, oldest first; `ready` is what agents
 * carried on past, newest first. A PR not fetched yet counts as open, as it does in Results.
 */
export function inbox({ jobs, prs }: Pick<Snapshot, "jobs" | "prs">) {
  const stopped: InboxItem[] = [];
  const ready: InboxItem[] = [];
  for (const job of jobs) {
    if (job.state === "removed") continue;
    const ask = job.notes.findLast((note) => note.kind === "ask");
    if (job.blocked === "asked" && ask) stopped.push({ kind: "ask", job, note: ask });
    if (job.blocked === "checkpoint") stopped.push({ kind: "checkpoint", job });
    if (job.state === "failed") stopped.push({ kind: "failed", job });
    const url = prUrl(job);
    // A goal's nodes merge through factory; only the goal's own PR into main is the user's.
    if (job.state === "done" && !job.of && url && (prs[url]?.state ?? "OPEN") === "OPEN")
      ready.push({ kind: "review", job });
    for (const note of openAssumptions(job)) ready.push({ kind: "assume", job, note });
    for (const need of job.unverified) ready.push({ kind: "unverified", job, need });
  }
  stopped.sort((a, b) => since(a).localeCompare(since(b)));
  ready.sort((a, b) => since(b).localeCompare(since(a)));
  return { stopped, ready };
}

/** When the item started waiting, as near as the job records it. */
function since(item: InboxItem) {
  if (item.kind === "ask" || item.kind === "assume") return item.note.at;
  return item.job.attempts.at(-1)?.end ?? item.job.added;
}

/** Unfinished jobs that wait for this one, directly. */
export const holds = (job: Job, jobs: Job[]) =>
  jobs.filter(
    (other) => other.after.includes(job.id) && other.state !== "done" && other.state !== "removed",
  ).length;

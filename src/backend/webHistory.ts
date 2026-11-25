import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { inbox } from "../inbox.ts";
import { livePath } from "./state.ts";
import {
  ACTIVITY_LIMIT,
  itemKey,
  prUrl,
  type Item,
  type Job,
  type ResultsPage,
  type Snapshot,
} from "./types.ts";

/** The job records needed outside Results. Keep their original order (including event ties). */
export function liveJobs(
  jobs: Job[],
  prs: Snapshot["prs"],
  candidates: Item[],
  status: Snapshot["status"],
) {
  const { stopped, ready } = inbox({ jobs, prs });
  const keep = new Set([...stopped, ...ready].map(({ job }) => job.id));
  for (const worker of status?.workers ?? []) if (worker.job) keep.add(worker.job);

  const candidateKeys = new Set(candidates.map(itemKey));
  const latest = new Map<string, string>();
  const goals = new Set(
    jobs.filter((job) => job.goal && job.state !== "removed").map((job) => job.id),
  );
  for (const job of jobs) {
    const key = itemKey(job.item);
    if (job.state !== "removed" && candidateKeys.has(key)) latest.set(key, job.id);
    // Keep even removed children of visible goals: Queue uses them to identify milestones.
    if (goals.has(job.id) || (job.of && goals.has(job.of)) || active(job)) keep.add(job.id);
    if (job.state === "queued") for (const id of job.after) keep.add(id);
  }
  for (const id of latest.values()) keep.add(id);

  // Same events, order and cap as ActivityView, without building their presentation on the server.
  const events = jobs.flatMap((job) =>
    job.state === "removed"
      ? []
      : [
          job.added,
          ...job.attempts.flatMap(({ start, end }) => [start, end]),
          ...job.notes.map(({ at }) => at),
        ].map((at) => ({ at, id: job.id })),
  );
  for (const { id } of events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, ACTIVITY_LIMIT))
    keep.add(id);
  return jobs.filter(({ id }) => keep.has(id));
}

const active = (job: Job) =>
  job.state === "queued" || job.state === "running" || job.state === "blocked";

function resultsWindow(jobs: Job[], project: string | null, limit: number) {
  const results = jobs.filter((job) => job.state !== "removed" && job.attempts.length > 0);
  const repos = [...new Set(results.map((job) => job.item.repo))];
  // A project can be selected before it has run its first job.
  const repo = project || null;
  const ordered = results
    .filter((job) => repo === null || job.item.repo === repo)
    .sort((a, b) => b.attempts.at(-1)!.start.localeCompare(a.attempts.at(-1)!.start));
  const running = ordered.filter(active);
  const finished = ordered.filter((job) => !active(job));
  return { running, finished: finished.slice(0, limit), total: finished.length, repos, repo };
}

export function jobPrs(jobs: Job[], prs: (urls: string[]) => Snapshot["prs"]) {
  return prs([
    ...new Set(jobs.flatMap((job) => (job.state === "removed" ? [] : (prUrl(job) ?? [])))),
  ]);
}

/** Cross-job facts for the records on the wire, even when their related jobs aren't sent. */
export function jobContext(all: Job[], shown: Job[]) {
  const reviews = new Set<string>();
  const followups = new Set<string>();
  for (const job of all) {
    if (job.state === "removed") continue;
    if (job.item.blueprint === "review") reviews.add(itemKey(job.item));
    if (job.item.blueprint === "followup") followups.add(job.item.title);
  }
  return {
    reviewed: shown.filter((job) => reviews.has(itemKey(job.item))).map(({ id }) => id),
    queuedFollowups: [
      ...new Set(
        shown.flatMap((job) =>
          job.notes.flatMap((note) => (note.followups ?? []).filter((task) => followups.has(task))),
        ),
      ),
    ],
  };
}

export function webJob(state: string, job: Job): Job {
  return {
    ...job,
    attempts: job.attempts.map((attempt) => ({ ...attempt, log: relative(state, attempt.log) })),
    ...(job.state === "running" && agentExited(state, job.id) && { exited: true }),
  };
}

function agentExited(state: string, id: string): boolean {
  const live = livePath(state, id);
  return existsSync(live) && existsSync(join(JSON.parse(readFileSync(live, "utf8")).dir, "exit"));
}

export function resultsPage(
  state: string,
  all: Job[],
  project: string | null,
  limit: number,
  prs: (urls: string[]) => Snapshot["prs"],
  train: Snapshot["train"],
): ResultsPage {
  const window = resultsWindow(all, project, limit);
  const shown = [...window.running, ...window.finished];
  return {
    ...window,
    running: window.running.map((job) => webJob(state, job)),
    finished: window.finished.map((job) => webJob(state, job)),
    prs: jobPrs(shown, prs),
    train: Object.fromEntries(shown.flatMap(({ id }) => (train[id] ? [[id, train[id]]] : []))),
    ...jobContext(all, shown),
  };
}

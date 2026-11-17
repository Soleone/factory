import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { itemKey, LEVELS } from "./state.ts";
import type { Attempt, Item, Job, Settings, Tuning } from "./types.ts";

/**
 * jobs.jsonl is append-only, so the CLI, the factory and serve can all write to it without overwriting
 * each other; the queue is whatever replaying it gives.
 */
type Event = { at: string } & (
  | { type: "add"; job: Pick<Job, "id" | "item" | "source" | "agent" | "model" | "effort"> }
  | { type: "remove" | "requeue" | "retry"; id: string }
  | { type: "move"; id: string; index: number }
  | { type: "start"; id: string; agent: string }
  | { type: "attempt"; id: string; attempt: Attempt }
);

/** An unexpected failure gets one more try by the same agent. */
const TRIES = 2;

const path = (state: string) => join(state, "jobs.jsonl");

function append(state: string, event: Event): void {
  appendFileSync(path(state), `${JSON.stringify(event)}\n`);
}

/** Every job ever, the queued ones in the order they will be taken: picks first, then auto. */
export function readJobs(state: string): Job[] {
  if (!existsSync(path(state))) return [];
  const jobs = new Map<string, Job>();
  const failures = new Map<string, number>();
  // Picks keep the order the user gave them; auto jobs keep the order they were added in.
  const picks: Job[] = [];
  const autos: Job[] = [];
  for (const line of readFileSync(path(state), "utf8").split("\n")) {
    if (!line) continue;
    const event: Event = JSON.parse(line);
    if (event.type === "add") {
      const job: Job = { ...event.job, added: event.at, state: "queued", attempts: [] };
      jobs.set(job.id, job);
      (job.source === "pick" ? picks : autos).push(job);
      continue;
    }
    const job = jobs.get(event.id)!;
    if (event.type === "remove") job.state = "removed";
    if (event.type === "requeue") job.state = "queued";
    if (event.type === "retry") {
      job.state = "queued";
      failures.set(job.id, 0);
    }
    if (event.type === "move") {
      picks.splice(picks.indexOf(job), 1);
      const before = picks.filter((pick) => pick.state === "queued")[event.index];
      picks.splice(before ? picks.indexOf(before) : picks.length, 0, job);
    }
    if (event.type === "start") {
      job.state = "running";
      job.agent = event.agent;
    }
    if (event.type === "attempt") {
      job.attempts.push(event.attempt);
      const { outcome } = event.attempt;
      if (outcome === "done") job.state = "done";
      else if (outcome === "limited") job.state = "queued";
      else {
        const count = (failures.get(job.id) ?? 0) + 1;
        failures.set(job.id, count);
        job.state = count >= TRIES ? "failed" : "queued";
      }
    }
  }
  return [...picks, ...autos];
}

/** The next job this agent may take. */
export function nextJob(jobs: Job[], agent: string): Job | undefined {
  return jobs.find((job) => job.state === "queued" && (job.agent ?? agent) === agent);
}

export function addJobs(
  state: string,
  items: Item[],
  source: Job["source"],
  pin: { agent?: string } & Tuning = {},
): Job[] {
  const at = new Date().toISOString();
  return items.map((item) => {
    const job = { id: randomBytes(4).toString("hex"), item, source, ...pin };
    append(state, { at, type: "add", job });
    return { ...job, added: at, state: "queued", attempts: [] };
  });
}

function find(state: string, id: string, ...states: Job["state"][]): Job {
  const job = readJobs(state).find((job) => job.id === id);
  if (!job) throw new Error(`no job ${id}`);
  if (!states.includes(job.state)) throw new Error(`job ${id} is ${job.state}`);
  return job;
}

export function removeJob(state: string, id: string): void {
  find(state, id, "queued");
  append(state, { at: new Date().toISOString(), type: "remove", id });
}

export function retryJob(state: string, id: string): void {
  find(state, id, "failed");
  append(state, { at: new Date().toISOString(), type: "retry", id });
}

/** Moves a queued pick to index among the queued picks. */
export function moveJob(state: string, id: string, index: number): void {
  if (find(state, id, "queued").source !== "pick") throw new Error(`job ${id} is not a pick`);
  append(state, { at: new Date().toISOString(), type: "move", id, index });
}

export function startJob(state: string, id: string, agent: string): void {
  append(state, { at: new Date().toISOString(), type: "start", id, agent });
}

export function endJob(state: string, id: string, attempt: Attempt): void {
  append(state, { at: new Date().toISOString(), type: "attempt", id, attempt });
}

/** A job that was running when its run stopped goes back to the queue, its agent kept. */
export function requeueJob(state: string, id: string): void {
  append(state, { at: new Date().toISOString(), type: "requeue", id });
}

/** Cheapest attention first, and within a level one item per repo in turn so no repo takes the night. */
export function order(items: Item[], levels: string[]): Item[] {
  return LEVELS.filter((level) => levels.includes(level)).flatMap((level) => {
    const byRepo = new Map<string, Item[]>();
    for (const item of items.filter((item) => item.level === level))
      byRepo.set(item.repo, [...(byRepo.get(item.repo) ?? []), item]);
    const queues = [...byRepo.values()];
    const turns: Item[] = [];
    for (let round = 0; queues.some((queue) => queue.length > round); round++)
      for (const queue of queues) if (queue[round]) turns.push(queue[round]);
    return turns;
  });
}

/** What auto mode would add next: wanted candidates that never had a job. */
export function autoPicks(
  candidates: Item[],
  jobs: Job[],
  auto: Omit<Settings["auto"], "on">,
  count: number,
): Item[] {
  const seen = new Set(jobs.map((job) => itemKey(job.item)));
  const wanted = candidates.filter(
    (item) =>
      !seen.has(itemKey(item)) &&
      (auto.plays.length === 0 || auto.plays.includes(item.play)) &&
      (auto.repos.length === 0 || auto.repos.includes(item.repo)),
  );
  return order(wanted, auto.levels).slice(0, count);
}

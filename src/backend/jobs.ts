import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workworkBranch } from "./review.ts";
import { LEVELS, output } from "./state.ts";
import {
  itemKey,
  prUrl,
  type Attempt,
  type Item,
  type Job,
  type Note,
  type Settings,
} from "./types.ts";

/**
 * jobs.jsonl is append-only, so the CLI, the factory and serve can all write to it without overwriting
 * each other; the queue is whatever replaying it gives.
 */
export type Event = { at: string } & (
  | {
      type: "add";
      job: Pick<Job, "id" | "item" | "source" | "agent" | "model" | "effort" | "prompt" | "after">;
    }
  | { type: "remove" | "requeue" | "retry"; id: string }
  | { type: "move"; id: string; index: number }
  | { type: "start"; id: string; agent: string }
  | { type: "attempt"; id: string; attempt: Attempt }
  | { type: "note"; id: string; note: NoteBody }
);

export type NoteBody = Omit<Note, "at" | "attempt">;

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
      const job: Job = {
        ...event.job,
        added: event.at,
        state: "queued",
        attempts: [],
        notes: [],
      };
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
    if (event.type === "note") {
      const answer = event.note.kind === "answer";
      // A note comes during the attempt that isn't recorded yet; an answer after the one that asked.
      const attempt = job.attempts.length + (answer ? 0 : 1);
      job.notes.push({ ...event.note, at: event.at, attempt });
      if (answer) job.state = "queued";
    }
    if (event.type === "attempt") {
      job.attempts.push(event.attempt);
      const { outcome } = event.attempt;
      const asked = job.notes.some(
        (note) => note.kind === "ask" && note.attempt === job.attempts.length,
      );
      if (asked) job.state = "blocked";
      else if (outcome === "done") job.state = "done";
      else if (outcome === "limited" || outcome === "stopped") job.state = "queued";
      else {
        const count = (failures.get(job.id) ?? 0) + 1;
        failures.set(job.id, count);
        job.state = count >= TRIES ? "failed" : "queued";
      }
    }
  }
  return [...picks, ...autos];
}

/** The next job this agent may take: queued for it, with the job it comes after done. */
export function nextJob(jobs: Job[], agent: string): Job | undefined {
  const done = (id?: string) => !id || jobs.find((job) => job.id === id)?.state === "done";
  return jobs.find(
    (job) => job.state === "queued" && (job.agent ?? agent) === agent && done(job.after),
  );
}

const ACTIVE: Job["state"][] = ["queued", "running", "blocked"];
const sameWork = (item: Item) => `${itemKey(item)} ${item.play} ${item.title}`;

/** Queues the items, skipping those already in the queue; returns the jobs it added. */
export function addJobs(
  state: string,
  items: Item[],
  source: Job["source"],
  pin: Pick<Job, "agent" | "model" | "effort" | "prompt" | "after"> = {},
): Job[] {
  const at = new Date().toISOString();
  const active = new Set(
    readJobs(state)
      .filter((job) => ACTIVE.includes(job.state))
      .map((job) => sameWork(job.item)),
  );
  const fresh = items.filter((item) => !active.has(sameWork(item)));
  return fresh.map((item) => {
    const job = { id: randomBytes(4).toString("hex"), item, source, ...pin };
    append(state, { at, type: "add", job });
    return { ...job, added: at, state: "queued", attempts: [], notes: [] };
  });
}

/**
 * Queues a job to rebase the job's PR and resolve its conflicts, unless one is already waiting. It
 * keeps the job's workwork id, so the attempt links the same PR.
 */
export function queueConflicts(state: string, id: string, url: string, files: string[]): void {
  const job = readJobs(state).find((job) => job.id === id)!;
  const item = { ...job.item, play: "conflicts", title: `Resolve conflicts: ${job.item.title}` };
  addJobs(state, [item], "pick", { prompt: conflictsPrompt(url, files) });
}

const conflictsPrompt = (
  url: string,
  files: string[],
) => `Pull request ${url} conflicts with its base branch in:
${files.map((file) => `- ${file}`).join("\n")}

1. Check out its branch with \`gh pr checkout ${url}\`.
2. Rebase it onto the freshly fetched base branch. Resolve each conflict so the intent of both sides survives; read the commits on both sides before choosing.
3. Run the repo's checks and tests, and fix what the rebase broke.
4. Push with \`git push --force-with-lease\`. Don't open a new pull request.

If a conflict can't be resolved without guessing what someone meant, don't push. Comment on the pull request with what's in the way instead.

End your reply with the pull request's URL.
`;

/**
 * Queues a review of the job's PR by another agent, once the job is done. Like a conflicts job it
 * keeps the job's workwork id, so it finds and links the same PR.
 */
export function queueReview(state: string, id: string, agent: string): Job | undefined {
  const job = find(state, id, ...ACTIVE, "done");
  if (job.agent === agent)
    throw new Error(`job ${id} is ${agent}'s own; pick another agent to review it`);
  const branch = workworkBranch(job.item);
  const item = { ...job.item, play: "review", title: `Review: ${job.item.title}` };
  const prompt = reviewPrompt(branch, job.agent);
  return addJobs(state, [item], "pick", { agent, prompt, after: id })[0];
}

const reviewPrompt = (
  branch: string,
  author = "another agent",
) => `Review the pull request ${author} opened from branch \`${branch}\`: \`gh pr view ${branch}\` and \`gh pr diff ${branch}\`.

1. Check it out with \`gh pr checkout ${branch}\`, run the repo's checks and tests, and read the change against what its description says it does.
2. Look for bugs, missed cases and changes nobody asked for. Skip style the linters already cover.
3. Post what you found as one comment with \`gh pr comment ${branch} --body-file -\`: each finding with file, line and why it matters, or that you found nothing. Don't push, approve or merge.

If there's no such pull request, say so and end.

End your reply with the pull request's URL.
`;

/**
 * Queues a task an agent reported as a follow-up of its job. Its own id, so the PR of the job it
 * came from isn't taken for its own.
 */
export function queueFollowup(state: string, id: string, task: string): Job | undefined {
  const job = find(state, id, ...ACTIVE, "done", "failed");
  if (!job.notes.some((note) => note.followups?.includes(task)))
    throw new Error(`job ${id} reported no follow-up "${task}"`);
  const item = { ...job.item, id: `${job.item.id}+followup`, play: "followup", title: task };
  const url = prUrl(job);
  const prompt = `${task}

This came up while an agent worked on "${job.item.title}"${url ? ` (${url})` : ""}. Make it its own change on a new branch, and open a pull request for it.
`;
  return addJobs(state, [item], "pick", { prompt })[0];
}

function find(state: string, id: string, ...states: Job["state"][]): Job {
  const job = readJobs(state).find((job) => job.id === id);
  if (!job) throw new Error(`no job ${id}`);
  if (!states.includes(job.state)) throw new Error(`job ${id} is ${job.state}`);
  return job;
}

/** Takes a job out of the queue or the results, and deletes the branches its attempts kept. */
export async function removeJob(state: string, id: string): Promise<void> {
  const job = find(state, id, "queued", "blocked", "done", "failed");
  append(state, { at: new Date().toISOString(), type: "remove", id });
  const kept = job.attempts.flatMap((attempt) => attempt.branch ?? []);
  if (kept.length === 0) return;
  const branches = await output(
    "git",
    ["for-each-ref", "--format=%(refname:short)", "refs/heads/factory/"],
    job.item.repo,
  );
  const left = kept.filter((branch) => branches.split("\n").includes(branch));
  if (left.length) await output("git", ["branch", "-D", ...left], job.item.repo);
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

/** An agent's note on the job it works, or the user's answer to a blocked job, which queues it again. */
export function addNote(state: string, id: string, note: NoteBody): void {
  find(state, id, note.kind === "answer" ? "blocked" : "running");
  append(state, { at: new Date().toISOString(), type: "note", id, note });
}

export function startJob(state: string, id: string, agent: string): void {
  append(state, { at: new Date().toISOString(), type: "start", id, agent });
}

export function endJob(state: string, id: string, attempt: Attempt): void {
  append(state, { at: new Date().toISOString(), type: "attempt", id, attempt });
}

/** A job whose run stopped before its agent started goes back to the queue, its agent kept. */
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

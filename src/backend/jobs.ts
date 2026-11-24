import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { workworkBranch } from "./review.ts";
import { ATTENTION, output } from "./state.ts";
import {
  chains,
  itemKey,
  openAssumptions,
  prUrl,
  PLANNING,
  TIERS,
  type Attempt,
  type Blocked,
  type Item,
  type Job,
  type Note,
  type Pin,
  type Settings,
  type Tier,
  reviewTier,
  upgradeItem,
} from "./types.ts";

/**
 * jobs.jsonl is append-only, so the CLI, the factory and serve can all write to it without overwriting
 * each other; the queue is whatever replaying it gives.
 */
export type Event = { at: string } & (
  | { type: "add"; job: NewJob }
  | { type: "remove" | "requeue" | "retry" | "merged" | "unblock"; id: string }
  | { type: "move"; id: string; index: number }
  | { type: "start"; id: string; agent: string; preset?: string }
  | { type: "attempt"; id: string; attempt: Attempt }
  | { type: "note"; id: string; note: NoteBody }
  /** The open attempt waits: for the user's answer, or for its pool's limit to reset. */
  | { type: "pause"; id: string; reason: "asked" | "limited" }
  | { type: "block"; id: string; reason: Blocked; why?: string }
  /** A replan's change to a job that hasn't started. */
  | { type: "update"; id: string; change: Change }
  /** What a waiting job runs on now, replacing its old pin. */
  | { type: "pin"; id: string; pin: Pin }
  /** The user checked a need it couldn't verify; no need: all of them. */
  | { type: "verify"; id: string; need?: string }
);

/** What a new job may say; the rest starts empty. Old logs have `after` as one id. */
export type NewJob = Pick<Job, "id" | "item" | "source"> &
  Partial<
    Pick<
      Job,
      | "agent"
      | "model"
      | "effort"
      | "preset"
      | "tier"
      | "prompt"
      | "after"
      | "parent"
      | "gates"
      | "touches"
      | "needs"
      | "goal"
      | "key"
      | "checkpoint"
      | "review"
      | "of"
      | "branchOf"
      | "front"
    >
  >;

export type Change = Partial<
  Pick<
    Job,
    | "item"
    | "tier"
    | "prompt"
    | "after"
    | "parent"
    | "gates"
    | "touches"
    | "needs"
    | "checkpoint"
    | "review"
    | "goal"
  >
>;

export type NoteBody = Omit<Note, "at" | "attempt">;

/** An unexpected failure gets one more try by the same agent. */
const TRIES = 2;

const path = (state: string) => join(state, "jobs.jsonl");

function append(state: string, event: Event): void {
  appendFileSync(path(state), `${JSON.stringify(event)}\n`);
}

/** Appends an event now. */
export function record(state: string, event: DistributiveOmit<Event, "at">): void {
  append(state, { at: new Date().toISOString(), ...event } as Event);
}
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const fresh = (job: NewJob, at: string): Job => ({
  ...job,
  item: upgradeItem(job.item),
  after: typeof job.after === "string" ? [job.after] : (job.after ?? []),
  gates: job.gates ?? [],
  needs: job.needs ?? [],
  unverified: [],
  added: at,
  state: "queued",
  attempts: [],
  notes: [],
  escalations: 0,
  open: false,
});

/**
 * Every job ever, the queued ones in the order they will be taken: picks first, then goal nodes by
 * goal and longest remaining chain, then auto.
 */
export function readJobs(state: string): Job[] {
  return replay(readEvents(state));
}

export function readEvents(state: string): Event[] {
  if (!existsSync(path(state))) return [];
  return readFileSync(path(state), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function replay(events: Event[]): Job[] {
  const jobs = new Map<string, Job>();
  const failures = new Map<string, number>();
  // Picks keep the order the user gave them; the rest keep the order they were added in.
  const picks: Job[] = [];
  const others: Job[] = [];
  for (const event of events) {
    if (event.type === "add") {
      const job = fresh(event.job, event.at);
      jobs.set(job.id, job);
      (job.source === "pick" ? picks : others).push(job);
      continue;
    }
    const job = jobs.get(event.id)!;
    if (event.type === "remove") job.state = "removed";
    if (event.type === "requeue" || event.type === "unblock") {
      job.state = "queued";
      job.blocked = undefined;
      job.why = undefined;
    }
    if (event.type === "retry") {
      job.state = "queued";
      job.blocked = undefined;
      job.why = undefined;
      failures.set(job.id, 0);
    }
    if (event.type === "move") {
      picks.splice(picks.indexOf(job), 1);
      const before = picks.filter((pick) => pick.state === "queued")[event.index];
      picks.splice(before ? picks.indexOf(before) : picks.length, 0, job);
    }
    if (event.type === "start") {
      job.state = "running";
      job.blocked = undefined;
      job.open = true;
      job.agent = event.agent;
    }
    if (event.type === "pause") {
      job.state = event.reason === "asked" ? "blocked" : "queued";
      job.blocked = event.reason === "asked" ? "asked" : undefined;
    }
    if (event.type === "block") {
      job.state = "blocked";
      job.blocked = event.reason;
      job.why = event.why;
    }
    if (event.type === "merged") {
      job.state = "done";
      job.blocked = undefined;
      job.why = undefined;
    }
    if (event.type === "pin") {
      for (const key of PIN_KEYS) delete job[key];
      Object.assign(job, event.pin);
    }
    if (event.type === "update")
      Object.assign(
        job,
        event.change,
        event.change.item && { item: upgradeItem(event.change.item) },
      );
    if (event.type === "verify")
      job.unverified = event.need ? job.unverified.filter((need) => need !== event.need) : [];
    if (event.type === "note") {
      const { kind } = event.note;
      // Notes during an attempt belong to it; the merge train's report and answers to a finished
      // attempt (old logs) belong to the last one.
      const attempt = job.attempts.length + (job.open ? 1 : 0);
      job.notes.push({ ...event.note, at: event.at, attempt });
      if (kind === "answer" && event.note.re === undefined && job.state === "blocked") {
        job.state = "queued";
        job.blocked = undefined;
      }
    }
    if (event.type === "attempt") {
      job.attempts.push(event.attempt);
      job.open = false;
      const { outcome } = event.attempt;
      const number = job.attempts.length;
      const said = job.notes.filter((note) => note.attempt === number);
      // Old logs ended an attempt with an unanswered question; now an answer goes on in it.
      const asked =
        said.findLastIndex((note) => note.kind === "ask") >
        said.findLastIndex((note) => note.kind === "answer" && note.re === undefined);
      const unverified = job.notes.findLast(
        (note) => note.kind === "result" && note.attempt === number,
      )?.unverified;
      const lacking = [...(unverified ?? []), ...(event.attempt.missing ?? [])];
      // A plan has nothing to check by hand; what its writer was unsure of stays in its result.
      const planning = (PLANNING as readonly string[]).includes(job.item.blueprint);
      if (outcome === "done" && lacking.length && !planning)
        job.unverified = [...new Set([...job.unverified, ...lacking])];
      if (asked) {
        // Old logs: the attempt ended with the question.
        job.state = "blocked";
        job.blocked = "asked";
      } else if (outcome === "done") {
        // A goal node is done once its branch is merged into the integration branch.
        job.state = job.of ? "blocked" : "done";
        job.blocked = job.of ? "review" : undefined;
      } else if (outcome === "limited" || outcome === "stopped") job.state = "queued";
      else {
        const count = (failures.get(job.id) ?? 0) + 1;
        failures.set(job.id, count);
        const up = job.tier && TIERS[TIERS.indexOf(job.tier) - 1];
        if (count < TRIES) job.state = "queued";
        else if (up) {
          job.notes.push({
            at: event.at,
            attempt: number,
            kind: "factory",
            text: `failed twice on ${job.tier}; moves up to ${up}`,
          });
          job.tier = up;
          job.escalations++;
          failures.set(job.id, 0);
          job.state = "queued";
        } else job.state = "failed";
      }
    }
  }
  settle(jobs);
  return [...picks, ...ordered(others, jobs)];
}

/**
 * States that follow from others: a job waiting on one that failed or was removed is held until
 * that one is retried; a job with children is done when they are, and waits until then.
 */
function settle(jobs: Map<string, Job>): void {
  const children = childrenOf(jobs.values());
  const settled = new Map<string, Job["state"]>();
  const stateOf = (job: Job): Job["state"] => {
    const known = settled.get(job.id);
    if (known) return known;
    const kids = (children.get(job.id) ?? []).filter((kid) => kid.state !== "removed");
    let state = job.state;
    if (!job.goal && kids.length > 0 && (state === "queued" || state === "done"))
      state = kids.every((kid) => stateOf(kid) === "done") ? "done" : "queued";
    settled.set(job.id, state);
    return state;
  };
  for (const job of jobs.values()) job.state = stateOf(job);
  for (const job of jobs.values()) {
    if (job.state !== "queued") continue;
    const lost = job.after.some((id) => {
      const state = jobs.get(id)?.state;
      return state === "failed" || state === "removed";
    });
    if (lost) {
      job.state = "blocked";
      job.blocked = "held";
    }
  }
  // Holding spreads down the chain, in any order of adding.
  for (let changed = true; changed;) {
    changed = false;
    for (const job of jobs.values())
      if (
        job.state === "queued" &&
        job.after.some(
          (id) => jobs.get(id)?.blocked === "held" && jobs.get(id)?.state === "blocked",
        )
      ) {
        job.state = "blocked";
        job.blocked = "held";
        changed = true;
      }
  }
}

function childrenOf(jobs: Iterable<Job>): Map<string, Job[]> {
  const children = new Map<string, Job[]>();
  for (const job of jobs)
    if (job.parent) children.set(job.parent, [...(children.get(job.parent) ?? []), job]);
  return children;
}

/** Goal jobs in the order their goals were added, factory's own first, then the longest remaining chain; auto jobs last. */
function ordered(others: Job[], jobs: Map<string, Job>): Job[] {
  const goals = others.filter((job) => job.goal).map((job) => job.id);
  const chain = chains(jobs);
  const rank = (job: Job) =>
    job.source === "auto" ? goals.length : Math.max(0, goals.indexOf(job.of ?? job.id));
  return others
    .map((job, index) => ({ job, index }))
    .sort(
      (a, b) =>
        rank(a.job) - rank(b.job) ||
        Number(b.job.front ?? false) - Number(a.job.front ?? false) ||
        (chain.get(b.job.id) ?? 0) - (chain.get(a.job.id) ?? 0) ||
        a.index - b.index,
    )
    .map(({ job }) => job);
}

/**
 * Whether a job may start now, whoever takes it: queued, not a goal or a group, everything it comes
 * after done, no goal or group above it waiting, and no running job that may touch the same files.
 */
export function ready(job: Job, jobs: Job[]): boolean {
  if (job.state !== "queued" || job.goal) return false;
  const byId = new Map(jobs.map((each) => [each.id, each]));
  if (jobs.some((each) => each.parent === job.id && each.state !== "removed")) return false;
  if (!job.after.every((id) => byId.get(id)?.state === "done")) return false;
  for (let up = job.parent ?? job.of; up;) {
    const above = byId.get(up);
    if (!above || above.state === "removed") return false;
    // Factory's own jobs work a goal that waits for approval or a fix: the decomposer, conflicts, fixes.
    const through = job.front && (above.blocked === "checkpoint" || above.blocked === "red");
    if (above.state === "blocked" && !through) return false;
    // A milestone's children wait for what the milestone comes after.
    if (!above.goal && !above.after.every((id) => byId.get(id)?.state === "done")) return false;
    up = above.parent ?? (above.goal ? undefined : above.of);
  }
  return !jobs.some(
    (other) =>
      other.state === "running" && other.item.repo === job.item.repo && overlap(job, other),
  );
}

/**
 * Two jobs may touch the same files when both track touches and a glob of one could match a path of
 * the other; an empty list means anything. Compared by the part before the first wildcard.
 */
export function overlap(a: Job, b: Job): boolean {
  if (!a.touches || !b.touches) return false;
  if (a.touches.length === 0 || b.touches.length === 0) return true;
  const stem = (glob: string) => glob.split(/[*?[{]/)[0];
  return a.touches.some((x) =>
    b.touches!.some((y) => stem(x).startsWith(stem(y)) || stem(y).startsWith(stem(x))),
  );
}

/** The next untiered job this agent may take: ready, and queued for it or for anyone. */
export function nextJob(jobs: Job[], agent: string): Job | undefined {
  return jobs.find(
    (job) => !job.tier && !job.preset && (job.agent ?? agent) === agent && ready(job, jobs),
  );
}

const ACTIVE: Job["state"][] = ["queued", "running", "blocked"];
const sameWork = (item: Item) => `${itemKey(item)} ${item.blueprint} ${item.title}`;

/** Queues the items, skipping those already in the queue; returns the jobs it added. */
export function addJobs(
  state: string,
  items: Item[],
  source: Job["source"],
  pin: Omit<NewJob, "id" | "item" | "source"> = {},
): Job[] {
  const at = new Date().toISOString();
  const active = new Set(
    readJobs(state)
      .filter((job) => ACTIVE.includes(job.state))
      .map((job) => sameWork(job.item)),
  );
  return items
    .filter((item) => !active.has(sameWork(item)))
    .map((item) => addJob(state, { id: newId(), item, source, ...pin }, at));
}

export const newId = () => randomBytes(4).toString("hex");

/** Queues one job as given. */
export function addJob(state: string, job: NewJob, at = new Date().toISOString()): Job {
  append(state, { at, type: "add", job });
  return fresh(job, at);
}

/** A job of the user's own, from a prompt for a tier, without workwork. */
export function addOwnJob(
  state: string,
  own: { repo: string; prompt: string; tier: Tier; title?: string; after?: string[] },
): Job {
  if (!TIERS.includes(own.tier)) throw new Error(`a tier is ${TIERS.join(", ")}, not ${own.tier}`);
  const first = own.prompt.split("\n").find((line) => line.trim());
  if (!first) throw new Error("the prompt is empty");
  const title = own.title?.trim() || first.replace(/^#+\s*/, "").slice(0, 100);
  return addJob(state, {
    id: newId(),
    item: {
      repo: own.repo,
      label: basename(own.repo),
      id: `own-${Date.now()}`,
      blueprint: "own",
      attention: "decide",
      title,
    },
    source: "pick",
    tier: own.tier,
    prompt: own.prompt,
    after: own.after,
  });
}

/**
 * Queues a job to rebase the job's PR and resolve its conflicts, unless one is already waiting. It
 * keeps the job's workwork id, so the attempt links the same PR.
 */
export function queueConflicts(state: string, id: string, url: string, files: string[]): void {
  const job = readJobs(state).find((job) => job.id === id)!;
  const item = {
    ...job.item,
    blueprint: "conflicts",
    title: `Resolve conflicts: ${job.item.title}`,
  };
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
 * Queues a review of the job's PR once the job is done, by another role than the author's, or by
 * the agent given. Like a conflicts job it keeps the job's workwork id, so it finds and links the
 * same PR. What it finds becomes a fix on that PR (queueReviewFix).
 */
export function queueReview(state: string, id: string, agent?: string): Job | undefined {
  const job = find(state, id, ...ACTIVE, "done");
  if (agent && job.agent === agent)
    throw new Error(`job ${id} is ${agent}'s own; pick another agent to review it`);
  const branch = workworkBranch(job.item);
  const item = { ...job.item, blueprint: "review", title: `Review: ${job.item.title}` };
  const by = agent ? { agent } : { tier: reviewTier(job) };
  const prompt = reviewPrompt(branch, job.agent);
  return addJobs(state, [item], "pick", { ...by, prompt, after: [id], branchOf: id })[0];
}

const reviewPrompt = (
  branch: string,
  author = "another agent",
) => `Review the pull request ${author} opened from branch \`${branch}\`: \`gh pr view ${branch}\` and \`gh pr diff ${branch}\`.

1. Check it out with \`gh pr checkout ${branch}\`, run the repo's checks and tests, and read the change against what its description says it does.
2. Look for bugs, missed cases and changes nobody asked for. Skip style the linters already cover.
3. Post what you found as one comment with \`gh pr comment ${branch} --body-file -\`: each finding with file, line and why it matters, or that you found nothing. Don't push, approve or merge.
4. Report with \`factory result "<summary>"\`, adding \`--followup "<finding: file, line, why it matters>"\` for each finding worth fixing; factory queues a fix for them on the same branch. No findings: no --followup.

If there's no such pull request, say so and end.

End your reply with the pull request's URL.
`;

/**
 * Queues the fix for what a done review of a job's PR found, on the same PR, by the author's role.
 * A review that found nothing queues nothing.
 */
export function queueReviewFix(state: string, id: string): Job | undefined {
  const jobs = readJobs(state);
  const review = jobs.find((job) => job.id === id)!;
  const reviewed = jobs.find((job) => job.id === review.branchOf);
  if (review.of || review.item.blueprint !== "review" || !reviewed) return undefined;
  const findings = review.notes.findLast((note) => note.kind === "result")?.followups ?? [];
  if (review.state !== "done" || findings.length === 0) return undefined;
  const item = {
    ...reviewed.item,
    blueprint: "fix",
    title: `Fix review findings: ${reviewed.item.title}`,
  };
  const url = prUrl(review) ?? prUrl(reviewed);
  const prompt = `A review of pull request ${url ?? `from branch \`${workworkBranch(reviewed.item)}\``} found:

${findings.map((each) => `- ${each}`).join("\n")}

1. Check out its branch with \`gh pr checkout ${url ?? workworkBranch(reviewed.item)}\`.
2. Fix each finding, or leave one that's wrong and say why. Run the repo's checks and tests, and push to the same branch. Don't open a new pull request.
3. Reply on the pull request with what changed.

End your reply with the pull request's URL.
`;
  return addJobs(state, [item], "pick", { tier: reviewed.tier, prompt, branchOf: reviewed.id })[0];
}

/**
 * Queues a task an agent reported as a follow-up of its job. Its own id, so the PR of the job it
 * came from isn't taken for its own.
 */
export function queueFollowup(state: string, id: string, task: string): Job | undefined {
  const job = find(state, id, ...ACTIVE, "done", "failed");
  if (!job.notes.some((note) => note.followups?.includes(task)))
    throw new Error(`job ${id} reported no follow-up "${task}"`);
  const item = { ...job.item, id: `${job.item.id}+followup`, blueprint: "followup", title: task };
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

const PIN_KEYS = ["agent", "model", "effort", "preset", "tier"] as const;

/** The user changes what a waiting job runs on: a tier, a worker, or neither for any free worker. */
export function pinJob(state: string, id: string, pin: Pin): void {
  const job = find(state, id, "queued");
  if (job.open || job.of) throw new Error(`job ${id} has started or belongs to a goal`);
  if (pin.tier && !TIERS.includes(pin.tier))
    throw new Error(`a tier is ${TIERS.join(", ")}, not ${pin.tier}`);
  const kept = Object.fromEntries(PIN_KEYS.flatMap((key) => (pin[key] ? [[key, pin[key]]] : [])));
  append(state, { at: new Date().toISOString(), type: "pin", id, pin: kept });
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

/** A failed job goes back in the queue, and with it the jobs it held. */
export function retryJob(state: string, id: string): void {
  find(state, id, "failed");
  append(state, { at: new Date().toISOString(), type: "retry", id });
}

/** Moves a queued pick to index among the queued picks. */
export function moveJob(state: string, id: string, index: number): void {
  if (find(state, id, "queued").source !== "pick") throw new Error(`job ${id} is not a pick`);
  append(state, { at: new Date().toISOString(), type: "move", id, index });
}

/** What agents say while they work; the rest come from the user, the merge train and factory. */
const AGENT_KINDS: Note["kind"][] = ["note", "ask", "assume", "result", "step"];

/** An agent's note on the job it works, what the merge train did with its PR, or factory's own. */
export function addNote(state: string, id: string, note: NoteBody): void {
  if (note.kind === "answer") throw new Error("answers go through answer()");
  // The train only takes jobs with a PR, and the job may have been removed since it boarded.
  if (AGENT_KINDS.includes(note.kind)) find(state, id, "running");
  append(state, { at: new Date().toISOString(), type: "note", id, note });
}

const FINE = /^\s*(fine|ok|okay|yes|good|agreed)[.!]?\s*$/i;

/**
 * The user's answer: to the assumption at index `re` among the job's notes, or else to the question
 * a blocked job asked, which queues it again, or else to its oldest open assumption. An answer to an
 * assumption that isn't "fine" queues a job after it, in its tier, to change what was assumed;
 * returns that job.
 */
export function answer(state: string, id: string, text: string, re?: number): Job | undefined {
  const job = find(state, id, "queued", "running", "blocked", "done", "failed");
  if (re === undefined && job.state === "blocked" && job.blocked === "asked") {
    append(state, {
      at: new Date().toISOString(),
      type: "note",
      id,
      note: { kind: "answer", text },
    });
    return undefined;
  }
  const assumption = openAssumptions(job).find((note) => re === undefined || note.index === re);
  if (!assumption)
    throw new Error(
      re === undefined
        ? `job ${id} has no question or assumption to answer`
        : `job ${id} has no open assumption ${re}`,
    );
  append(state, {
    at: new Date().toISOString(),
    type: "note",
    id,
    note: { kind: "answer", text, re: assumption.index },
  });
  if (FINE.test(text)) return undefined;
  const prompt = `${job.item.title} (job ${job.id}) was done assuming: ${assumption.assumed}

It had asked: ${assumption.text}

The user answered: ${text}

Change the work to follow the answer. ${prUrl(job) ? `Its pull request is ${prUrl(job)}; push the change to its branch.` : "Start from what it delivered."}
`;
  return addJob(state, {
    id: newId(),
    item: {
      ...job.item,
      id: `${job.item.id}+answer`,
      blueprint: "answer",
      title: `Follow the answer: ${job.item.title}`,
    },
    source: job.of ? "goal" : "pick",
    prompt,
    after: [job.id],
    tier: job.tier,
    agent: job.tier ? undefined : job.agent,
    of: job.of,
    parent: job.parent,
    gates: job.gates,
    touches: job.touches,
    needs: job.needs,
  });
}

export function startJob(state: string, id: string, agent: string, preset?: string): void {
  append(state, { at: new Date().toISOString(), type: "start", id, agent, preset });
}

export function endJob(state: string, id: string, attempt: Attempt): void {
  append(state, { at: new Date().toISOString(), type: "attempt", id, attempt });
}

/** Cheapest attention first, and within each one item per repo in turn so no repo takes the night. */
export function order(items: Item[], wanted: string[]): Item[] {
  return ATTENTION.filter((attention) => wanted.includes(attention)).flatMap((attention) => {
    const byRepo = new Map<string, Item[]>();
    for (const item of items.filter((item) => item.attention === attention))
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
      (auto.blueprints.length === 0 || auto.blueprints.includes(item.blueprint)) &&
      (auto.repos.length === 0 || auto.repos.includes(item.repo)),
  );
  return order(wanted, auto.attention).slice(0, count);
}

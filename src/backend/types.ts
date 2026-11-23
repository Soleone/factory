/** The shapes the CLI, the factory and the page share, and the rules both sides apply to them. No imports, so the page can use them too. */

/** Unset means the agent's own default. */
export type Tuning = { model?: string; effort?: string };

/** An agent with a model and effort, saved to queue jobs with in one click, and what tiers run on. */
export type Preset = Tuning & {
  agent: string;
  /** Stable, so tiers can name it; unset: agent/model/effort. */
  id?: string;
  /** The account its usage limit counts against; unset: claude, or pi's provider. */
  pool?: string;
  /** Process slots a run gives it; unset: 1 when a tier lists it, else 0. */
  workers?: number;
  /** Context tokens at which the runner compacts; unset: 90k for Haiku, 200k otherwise. */
  compactAt?: number;
  /** Turns factory adds to an attempt after a failed gate or an unfinished exit. */
  followups?: number;
};

/** What kind of intelligence a job needs, highest first. */
export const TIERS = ["communicator", "builder", "grunt"] as const;

/** The blueprints of factory's own jobs that write a goal's plan. */
export const PLANNING = ["decompose", "replan"] as const;
export type Tier = (typeof TIERS)[number];

export const presetId = (preset: Preset) =>
  preset.id ?? [preset.agent, preset.model, preset.effort].filter(Boolean).join("/");

/**
 * A model the settings offer for an agent: what --model takes, how to show it, and its efforts.
 * Scoped models are the agent's short list (Pi's Ctrl+P scope), shown above the rest.
 */
export type Model = { value: string; label: string; efforts: string[]; scoped: boolean };

/** stopped: the factory was turned off with --kill while the agent worked. timeout: no output for `idle` minutes. */
export type Outcome = "done" | "failed" | "limited" | "timeout" | "stopped";

/** The global settings; a run starts from these unless told otherwise. */
export type Settings = {
  /** The registered agents, each with its model and effort (unset: the agent's default). */
  agents: Record<string, Tuning>;
  /** The agent the Plan chat talks to, with its model and effort; a change starts a new chat. */
  chat: Tuning & { agent: string };
  /** Agents with a model and effort to queue candidates with, like pi on its biggest model. */
  presets: Preset[];
  /** Usage-limit hits per agent per run before that agent stops; null: never stop, wait for the reset. */
  limit: number | null;
  /** HH:MM local time after which a run starts nothing new. */
  until?: string;
  /** Percent of a pool's 5-hour window left for other apps: past it, the pool starts nothing new until the reset. */
  reserves: Record<string, number>;
  /** Minutes without a sign of life from an agent before its attempt ends as a timeout. */
  idle: number;
  /** Each tier's presets by id, in the order they're tried. */
  tiers: Record<Tier, string[]>;
  /** tasks: goals and everything under them are mirrored into Tasks, both ways; workwork jobs stay out. */
  store: "local" | "tasks";
  /** The Tasks home and CLI the mirror uses, and the category its goals get. */
  tasks?: { home: string; cli?: string; category?: string };
  /** What this machine's workers can verify with, like display, gpu or android-emulator. */
  capabilities: string[];
  /** Environment per repo path for the agents and gates that work it. */
  env: Record<string, Record<string, string>>;
  /** Auto mode tops up the queue from workwork; empty repos or blueprints means all of them. */
  auto: { on: boolean; attention: string[]; blueprints: string[]; repos: string[] };
  /**
   * While a run works, what queues a job in the repos factory has jobs in: CI failing on the
   * default branch, an open issue with `label` (empty: none), a person's remarks on a job's PR.
   */
  triggers: { ci: boolean; label: string; reviews: boolean };
};

/** A workwork candidate, as `workwork --json` prints it. `id` is workwork's, not a job's. */
export type Item = {
  repo: string;
  label: string;
  id: string;
  blueprint: string;
  attention: string;
  title: string;
};

/** Before workwork 0.3 a blueprint was a play and attention a level, with auto for none. */
export type LegacyItem =
  | Item
  | (Omit<Item, "blueprint" | "attention"> & { play: string; level: string });

export function upgradeItem(item: LegacyItem): Item {
  if (!("play" in item)) return item;
  const { play, level, ...rest } = item;
  return { ...rest, blueprint: play, attention: level === "auto" ? "none" : level };
}

/** A candidate's identity across workwork runs. */
export const itemKey = (item: Pick<Item, "repo" | "id">) => `${item.repo} ${item.id}`;

/** `workwork --all --json` takes minutes, so its answer is kept here for browsing and auto mode. */
export type Candidates = { at: string; items: Item[] };

/** A blueprint as `workwork blueprints --json` prints it. `custom` ones are the user's own. */
export type Blueprint = {
  name: string;
  attention: string;
  description: string;
  finder: string;
  done: string;
  onRequest: boolean;
  prompt: string;
  custom: boolean;
};

/** Tokens by kind over an attempt, as the runner's event stream reports them. */
export type Tokens = { input: number; cached: number; output: number };

/**
 * One agent working one job, in one session that factory may talk to several times: `turns` counts
 * the runs, `followups` those factory sent after a failed gate or an unfinished exit. `branch`
 * holds work it left unpushed.
 */
export type Attempt = {
  run: string;
  agent: string;
  model?: string;
  effort?: string;
  preset?: string;
  start: string;
  end: string;
  outcome: Outcome;
  url?: string;
  log: string;
  branch?: string;
  error?: string;
  session?: string;
  turns?: number;
  followups?: number;
  /** Largest context seen, in tokens, and how often the runner compacted it. */
  peak?: number;
  compactions?: number;
  tokens?: Tokens;
  /** Needs the job had that no worker here could check. */
  missing?: string[];
};

export type Confidence = "low" | "medium" | "high";

/**
 * What an agent says about its job through the CLI while working it (a note, a question for the user,
 * its result), and the user's answers. `attempt` counts from 1; an answer belongs to the attempt that asked.
 */
export type Note = {
  at: string;
  attempt: number;
  /**
   * step: progress in the agent's words. assume: a question it carried on from with `assumed`.
   * factory: what factory did, like a follow-up, an escalation or a merge.
   */
  kind: "note" | "ask" | "assume" | "answer" | "result" | "step" | "train" | "factory";
  text: string;
  confidence?: Confidence;
  followups?: string[];
  url?: string;
  assumed?: string;
  /** An answer to an assumption names the assumption's index among the job's notes. */
  re?: number;
  /** Needs the agent couldn't check, from `factory result --unverified`. */
  unverified?: string[];
  done?: number;
  of?: number;
};

/** A goal: a job with children, worked on its own integration branch. */
export type Goal = {
  repo: string;
  /** Names the branch `goal/<slug>` and the memory file `.factory/<slug>.md`. */
  slug: string;
  /** What the user asked for when starting it from the page or `goal new`; a decomposer's plan replaces the summary. */
  brief?: string;
  summary: string;
  /** Run on the integration branch after every merge into it. */
  gates: string[];
  budget?: { attempts: number };
  /** Nodes may run on a higher tier than their own when theirs is busy or limited. */
  allowUp: boolean;
  /** The tier replans run on. */
  replanTier?: Tier;
};

/**
 * Why a job waits. asked: for the user's answer. held: a job it comes after failed or was removed.
 * checkpoint: for the user's approval. paused: by the user. red: a goal whose integration branch fails
 * its gates, until a fix merges. review: a done node's branch waits to merge (a review, its fixes, conflicts).
 */
export type Blocked = "asked" | "held" | "checkpoint" | "paused" | "red" | "review";

/**
 * One unit of work: a workwork candidate, a goal or a node of one, or a job factory writes itself
 * (conflicts, reviews, fixes, replans). Goal nodes carry a made-up item with the goal's repo and their
 * plan key as id. An attempt keeps its agent and preset; untiered jobs keep their agent.
 */
export type Job = Tuning & {
  id: string;
  item: Item;
  /** pick and auto: workwork candidates; goal: goals and everything under them. */
  source: "pick" | "auto" | "goal";
  added: string;
  agent?: string;
  /** A pin that overrides the tier. */
  preset?: string;
  tier?: Tier;
  state: "queued" | "running" | "blocked" | "done" | "failed" | "removed";
  blocked?: Blocked;
  /** What a goal's checkpoint waits for, in factory's words. */
  why?: string;
  attempts: Attempt[];
  notes: Note[];
  /** For jobs that aren't workwork's, which asks workwork for the rest. */
  prompt?: string;
  /** Jobs that have to be done before this one starts. */
  after: string[];
  parent?: string;
  /** Shell commands run in the job's worktree after the agent stops; it's done only when all pass. */
  gates: string[];
  /** Globs of files it expects to change; unset: not tracked, empty: anything, so it runs alone. */
  touches?: string[];
  needs: string[];
  /** Needs no worker had when it was done, until the user checks them. */
  unverified: string[];
  goal?: Goal;
  /** Its key in the goal's plan. */
  key?: string;
  /** When it's done, its goal waits for the user's approval. */
  checkpoint?: boolean;
  /** The tier that reviews its branch before it merges. */
  review?: Tier;
  /** The goal job this one belongs to, for every job under a goal. */
  of?: string;
  /** The job whose branch this one works on (a review's fix) or reviews. */
  branchOf?: string;
  /** Factory's own jobs inside a goal go before the rest. */
  front?: boolean;
  /** Times it failed twice and moved up a tier. */
  escalations: number;
  /** An attempt is under way, maybe paused for an answer or a limit; its agent's session continues. */
  open: boolean;
};

export type Worker = Tuning & {
  /** The preset's id and a slot number, like claude#1. */
  id: string;
  agent: string;
  preset: string;
  pool: string;
  state: "idle" | "working" | "sleeping" | "stopped";
  since: string;
  job?: string;
  until?: string;
  reason?: string;
  /** What the agent does right now, read from its event stream, and its context size in tokens. */
  activity?: string;
  context?: number;
};

/** The pools whose 5-hour usage factory can read, so a reserve can be kept on them. */
export const USAGE_POOLS = ["claude", "anthropic", "openai-codex"] as const;

/** A usage window: the percent used, and when it resets in epoch ms; no reset while nothing was used. */
export type UsageWindow = { used: number; resets?: number };
/** A pool's two limits. */
export type Usage = { fiveHour: UsageWindow; sevenDay: UsageWindow };
/** A pool's limits as of a read, in epoch ms. */
export type ReadUsage = Usage & { at: number };

/** What one usage limit counts against: an account at a provider. */
export type Pool = {
  name: string;
  limits: number;
  until?: string;
  stopped?: string;
  /** Percent of its 5-hour window used when last read; only read for a pool with a reserve. */
  used?: number;
  /** Its until is the reset of a window that reached its reserve, not a limit hit. */
  reserved?: boolean;
};

/** What status.json holds while a run is on, and after it ended. */
export type Status = {
  pid: number;
  run: string;
  until?: string;
  limit: number | null;
  /** Minutes without a sign of life before an attempt times out. */
  idle: number;
  workers: Worker[];
  pools: Pool[];
};

/** What the page polls: everything it shows except the candidates themselves. */
export type Snapshot = {
  on: boolean;
  /** The current run's, or the last one's when the factory is off. */
  status: Status | null;
  settings: Settings;
  /** Attempt logs are paths the server serves, relative to the state folder. */
  jobs: Job[];
  candidates: { at: string | null; count: number; refreshing: boolean };
  /** What GitHub last said about each job's PR, by URL; a PR not fetched yet is missing. */
  prs: Record<string, Pr>;
  /** Where each job on the merge train is, by job id; gone when serve restarts. */
  train: Record<string, TrainCar>;
  /** The last good usage read of each pool a run works on, by pool; a pool never read is missing. */
  usage: Record<string, ReadUsage>;
};

export type TrainCar =
  | { step: "queued" | "waiting" | "rebasing" | "merging" | "merged" }
  | { step: "skipped"; reason: string };

export const onTrain = (car?: TrainCar) =>
  car !== undefined && car.step !== "merged" && car.step !== "skipped";

/** A job's PR as `gh pr view` describes it, trimmed to what a quick review needs. */
export type Pr = {
  state: "OPEN" | "MERGED" | "CLOSED";
  draft: boolean;
  title: string;
  /** The PR body's Attention line: the agent may have raised the candidate's. */
  attention?: string;
  additions: number;
  deletions: number;
  files: string[];
  checks: "passing" | "failing" | "pending" | "none";
  /** Null while GitHub is calculating mergeability. */
  conflicts: boolean | null;
  fork: boolean;
};

/** The PR factory opened for a goal node, or else the PR of the job's latest attempt that linked one. */
export const prUrl = (job: Job) =>
  job.notes.findLast((note) => note.kind === "factory" && note.url?.includes("/pull/"))?.url ??
  job.attempts.findLast((attempt) => attempt.url?.includes("/pull/"))?.url;

/** Assumptions an agent carried on from that the user hasn't answered yet, with their index among the notes. */
export const openAssumptions = (job: Job) =>
  job.notes.flatMap((note, index) =>
    note.kind === "assume" &&
    !job.notes.some((other) => other.kind === "answer" && other.re === index)
      ? [{ ...note, index }]
      : [],
  );

/** Merging from the page skips GitHub's own page, so it only goes ahead when nothing argues against it. */
export const canMerge = (pr: Pr) =>
  pr.state === "OPEN" &&
  !pr.draft &&
  pr.conflicts === false &&
  (pr.checks === "passing" || pr.checks === "none");

export const canRebase = (pr: Pr) => pr.state === "OPEN" && pr.conflicts === true && !pr.fork;

/** The longest chain of unfinished jobs that wait on each job, itself included. */
export function chains(jobs: Map<string, Job>): Map<string, number> {
  const waiting = new Map<string, Job[]>();
  for (const job of jobs.values())
    for (const id of job.after) waiting.set(id, [...(waiting.get(id) ?? []), job]);
  const lengths = new Map<string, number>();
  const length = (job: Job): number => {
    const known = lengths.get(job.id);
    if (known !== undefined) return known;
    lengths.set(job.id, 0);
    const unfinished = job.state !== "done" && job.state !== "removed";
    const next = (waiting.get(job.id) ?? []).map(length);
    const value = (unfinished ? 1 : 0) + Math.max(0, ...next);
    lengths.set(job.id, value);
    return value;
  };
  for (const job of jobs.values()) length(job);
  return lengths;
}

/** How many dependencies deep each node is, for layered columns. */
export function depths(nodes: Job[]): Map<string, number> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depth = new Map<string, number>();
  const of = (node: Job, seen: Set<string> = new Set()): number => {
    const known = depth.get(node.id);
    if (known !== undefined) return known;
    if (seen.has(node.id)) return 0;
    seen.add(node.id);
    const value =
      Math.max(-1, ...node.after.flatMap((id) => (byId.get(id) ? [of(byId.get(id)!, seen)] : []))) +
      1;
    depth.set(node.id, value);
    return value;
  };
  for (const node of nodes) of(node);
  return depth;
}

/** The unfinished jobs on a longest chain: what to watch, since the goal can't finish sooner. */
export function critical(nodes: Job[]): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const after = chains(byId);
  const into = new Map<string, number>();
  const before = (node: Job): number => {
    const known = into.get(node.id);
    if (known !== undefined) return known;
    into.set(node.id, 0);
    const unfinished = node.state !== "done" && node.state !== "removed";
    const value =
      (unfinished ? 1 : 0) +
      Math.max(0, ...node.after.flatMap((id) => (byId.has(id) ? [before(byId.get(id)!)] : [])));
    into.set(node.id, value);
    return value;
  };
  const length = (node: Job) => before(node) + (after.get(node.id) ?? 0) - 1;
  const unfinished = nodes.filter((node) => node.state !== "done" && node.state !== "removed");
  const longest = Math.max(0, ...unfinished.map(length));
  return new Set(
    unfinished.filter((node) => longest > 0 && length(node) === longest).map((node) => node.id),
  );
}

/** The shapes the CLI, the factory and the page share, and the rules both sides apply to them. No imports, so the page can use them too. */

/** Unset means the agent's own default. */
export type Tuning = { model?: string; effort?: string };

/** An agent with a model and effort, saved to queue jobs with in one click. */
export type Preset = Tuning & { agent: string };

/**
 * A model the settings offer for an agent: what --model takes, how to show it, and its efforts.
 * Scoped models are the agent's short list (Pi's Ctrl+P scope), shown above the rest.
 */
export type Model = { value: string; label: string; efforts: string[]; scoped: boolean };

/** stopped: the factory was turned off with --kill while the agent worked. */
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
  /** Minutes before an agent is killed. */
  timeout: number;
  /** Auto mode tops up the queue from workwork; empty repos or plays means all of them. */
  auto: { on: boolean; levels: string[]; plays: string[]; repos: string[] };
};

/** A workwork candidate, as `workwork --json` prints it. `id` is workwork's, not a job's. */
export type Item = {
  repo: string;
  label: string;
  id: string;
  play: string;
  level: string;
  title: string;
};

/** A candidate's identity across workwork runs. */
export const itemKey = (item: Pick<Item, "repo" | "id">) => `${item.repo} ${item.id}`;

/** `workwork --all --json` takes minutes, so its answer is kept here for browsing and auto mode. */
export type Candidates = { at: string; items: Item[] };

/** A play as `workwork plays --json` prints it, with the fields factory shows. */
export type Play = { name: string; description: string };

/** One agent working one job. `branch` holds work it left unpushed. */
export type Attempt = {
  run: string;
  agent: string;
  model?: string;
  effort?: string;
  start: string;
  end: string;
  outcome: Outcome;
  url?: string;
  log: string;
  branch?: string;
  error?: string;
};

export type Confidence = "low" | "medium" | "high";

/**
 * What an agent says about its job through the CLI while working it (a note, a question for the user,
 * its result), and the user's answers. `attempt` counts from 1; an answer belongs to the attempt that asked.
 */
export type Note = {
  at: string;
  attempt: number;
  kind: "note" | "ask" | "answer" | "result" | "train";
  text: string;
  confidence?: Confidence;
  followups?: string[];
  url?: string;
};

/** A workwork candidate in the queue. Once it has an agent, by choice or by its first start, it keeps it. */
export type Job = Tuning & {
  id: string;
  item: Item;
  source: "pick" | "auto";
  added: string;
  agent?: string;
  /** blocked: its agent asked the user something, and it waits for the answer. */
  state: "queued" | "running" | "blocked" | "done" | "failed" | "removed";
  attempts: Attempt[];
  notes: Note[];
  /** For jobs factory writes itself, like resolving a PR's conflicts; the rest ask workwork. */
  prompt?: string;
  /** A job that has to be done before this one starts, like the fix a review is of. */
  after?: string;
};

export type Worker = Tuning & {
  agent: string;
  state: "idle" | "working" | "sleeping" | "stopped";
  since: string;
  job?: string;
  until?: string;
  reason?: string;
  limits: number;
};

/** What status.json holds while a run is on, and after it ended. */
export type Status = {
  pid: number;
  run: string;
  until?: string;
  limit: number | null;
  /** Minutes before an agent is killed. */
  timeout: number;
  workers: Worker[];
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
  /** The PR body's Level line: the agent may have raised the candidate's. */
  level?: string;
  additions: number;
  deletions: number;
  files: string[];
  checks: "passing" | "failing" | "pending" | "none";
  /** Null while GitHub is calculating mergeability. */
  conflicts: boolean | null;
  fork: boolean;
};

/** The PR of the job's latest attempt that linked one. */
export const prUrl = (job: Job) =>
  job.attempts.findLast((attempt) => attempt.url?.includes("/pull/"))?.url;

/** Merging from the page skips GitHub's own page, so it only goes ahead when nothing argues against it. */
export const canMerge = (pr: Pr) =>
  pr.state === "OPEN" &&
  !pr.draft &&
  pr.conflicts === false &&
  (pr.checks === "passing" || pr.checks === "none");

export const canRebase = (pr: Pr) => pr.state === "OPEN" && pr.conflicts === true && !pr.fork;

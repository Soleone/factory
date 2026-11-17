/** The shapes the CLI, the factory and the page share. No imports, so the page can use them too. */

/** Unset means the agent's own default. */
export type Tuning = { model?: string; effort?: string };

export type Outcome = "done" | "failed" | "limited" | "timeout";

/** The global settings; a run starts from these unless told otherwise. */
export type Settings = {
  /** The registered agents, each with its model and effort (unset: the agent's default). */
  agents: Record<string, Tuning>;
  /** Usage-limit hits per agent per run before that agent stops; null: never stop, wait for the reset. */
  limit: number | null;
  /** HH:MM local time after which a run starts nothing new. */
  until?: string;
  /** Minutes before an agent is killed. */
  timeout: number;
  /** Auto mode tops up the queue from workwork; empty plays means every play. */
  auto: { on: boolean; levels: string[]; plays: string[] };
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

/** `workwork --all --json` takes minutes, so its answer is kept here for browsing and auto mode. */
export type Candidates = { at: string; items: Item[] };

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

/** A workwork candidate in the queue. Once it has an agent, by choice or by its first start, it keeps it. */
export type Job = Tuning & {
  id: string;
  item: Item;
  source: "pick" | "auto";
  added: string;
  agent?: string;
  state: "queued" | "running" | "done" | "failed" | "removed";
  attempts: Attempt[];
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
};

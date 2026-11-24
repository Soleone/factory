import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { agent as makeAgent, classify, resetTime, type Agent } from "./agents.ts";
import { keepWork, release } from "./git.ts";
import { piWindows } from "./models.ts";
import { mirrorTasks } from "./tasksStore.ts";
import { afterAttempt, builtinCheck, discardCancelledJob, finishGoals, prepare } from "./goals.ts";
import {
  addJobs,
  answer,
  autoPicks,
  endJob,
  queueReviewFix,
  ready,
  readJobs,
  record,
  startJob,
} from "./jobs.ts";
import { findPr } from "./review.ts";
import { alive, compactAt, readCandidates, readSettings, refreshCandidates } from "./state.ts";
import { noFacts, readStream, type Facts } from "./stream.ts";
import { fiveHour } from "./usage.ts";
import { watch } from "./triggers.ts";
import {
  presetWorkers,
  presetId,
  TIERS,
  type Attempt,
  type Item,
  type Job,
  type Outcome,
  type Pool,
  type Preset,
  type Settings,
  type Status,
  type UsageWindow,
  type Worker,
} from "./types.ts";

export type RunOptions = {
  /** This run's worker counts by preset id, over the settings'. */
  workers?: Record<string, number>;
  /** Usage-limit hits per pool before its workers stop; null: always wait for the reset. */
  limit: number | null;
  /** Epoch ms after which nothing new starts. */
  until?: number;
  /** An attempt whose agent shows no sign of life this long ends as a timeout. */
  idleMs: number;
  state: string;
  /** The workwork command; tests swap in a script. */
  workwork: string;
  /** Stops the run like SIGTERM does, or like SIGINT when aborted with the reason "kill". */
  signal?: AbortSignal;
  /** How often an idle worker looks for new jobs. */
  pollMs?: number;
  /** Tests record the waits for a limit reset instead of sleeping through them. */
  sleep?: (ms: number) => Promise<void>;
  /** Reads a pool's 5-hour window; tests swap in their own. */
  usage?: (pool: string) => Promise<UsageWindow>;
  /** Queues jobs for events on GitHub and says what it queued; tests swap in their own. */
  watch?: (state: string) => Promise<string[]>;
};

const MINUTE = 60_000;
/** Auto mode keeps this many of its jobs queued per worker, so picks never drown in them. */
const AUTO_PER_WORKER = 5;
const STALE_CANDIDATES = 6 * 60 * MINUTE;
const FOLLOWUPS = 2;
const GATE_TIMEOUT = 30 * MINUTE;
const WATCH_EVERY = 5 * MINUTE;
/** A question nobody answers this long stops holding the job: the agent goes with its recommendation. */
const ASK_WAIT = 15 * MINUTE;
const NO_ANSWER = `Nobody answered within ${ASK_WAIT / MINUTE} minutes, so factory told the agent to go with its recommendation.`;
/** What claude and pi print when the session to resume was never saved. */
const LOST_SESSION = /No conversation found with session ID|No session found matching/;

/**
 * An attempt under way, kept in running/<job id>.json until it's recorded: its session, its worktree,
 * and the agent's pid while a turn runs. A run that stops leaves the agent working, and the next run
 * finishes the turn from this. Paused (an ask, a limit), it has no pid and keeps its worktree.
 */
type Live = {
  begun: Begun;
  session: string;
  worktree: string;
  dir: string;
  turns: number;
  followups: number;
  /** The turn's file and where its output starts in the log. */
  turn: string;
  offset: number;
  pid?: number;
  /** What the next turn picks up from. */
  waiting?: "asked" | "limited" | "alone" | "interrupted";
  /** The turn this session started on, when not the first; later turns resume it. */
  sessionTurn?: number;
  /** Needs no worker here has, so the agent was told it can't check them. */
  missing: string[];
};
type Begun = Pick<Attempt, "run" | "agent" | "model" | "effort" | "preset" | "start" | "log">;

const livePath = (state: string, id: string) => join(state, "running", `${id}.json`);
const readLive = (state: string, id: string): Live | undefined =>
  existsSync(livePath(state, id))
    ? JSON.parse(readFileSync(livePath(state, id), "utf8"))
    : undefined;
const writeLive = (state: string, id: string, live: Live) =>
  writeFileSync(livePath(state, id), JSON.stringify(live));

const URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d+/g;

/** A worker and the preset it runs. */
type Slot = { worker: Worker; preset: Preset; quickFailures: number };

/** Works the queue until every worker is out of limits, until passes, or it's stopped; returns the run id. */
export async function run(options: RunOptions): Promise<string> {
  const { state } = options;
  const id = new Date().toISOString().slice(0, 19).replaceAll(":", "");
  const runDir = join(state, "runs", id);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(state, "running"), { recursive: true });
  const settings = readSettings(state);
  const slots = makeSlots(settings, options.workers);
  if (slots.length === 0)
    throw new Error("no workers; give one a count above 0 under Settings, Workers");
  const pools = new Map<string, Pool>();
  for (const { worker } of slots) pools.set(worker.pool, { name: worker.pool, limits: 0 });
  const agents = new Set<number>();
  const wakers = new Set<() => void>();
  let stopping = false;
  let killing = false;
  let topping: Promise<void> | undefined;
  const borrowed = new Set<string>();
  /** Each pool's last usage read, shared by its workers so one read serves them all. */
  const reads = new Map<string, { at: number; done: Promise<void> }>();
  const piPresets = slots
    .map((slot) => slot.preset)
    .filter((preset) => preset.agent === "pi" && preset.model);
  // Informational, so it never holds up the run.
  if (piPresets.length)
    void piWindows()
      .then((windows) => piSettingsWarnings(piPresets, windows).forEach(log))
      .catch((error: Error) => log(`can't check pi's compaction settings: ${error.message}`));

  function writeStatus(): void {
    const status: Status = {
      pid: process.pid,
      run: id,
      until: options.until ? new Date(options.until).toISOString() : undefined,
      limit: options.limit,
      idle: options.idleMs / MINUTE,
      workers: slots.map((slot) => slot.worker),
      pools: [...pools.values()],
    };
    writeFileSync(join(state, "status.json"), `${JSON.stringify(status, null, 2)}\n`);
  }

  function set(worker: Worker, change: Partial<Worker>): void {
    Object.assign(
      worker,
      {
        job: undefined,
        until: undefined,
        reason: undefined,
        activity: undefined,
        context: undefined,
      },
      change,
    );
    worker.since = new Date().toISOString();
    writeStatus();
  }

  /** Starts nothing new; agents keep working for the next run to finish, unless killed. */
  function stop(kill: boolean): void {
    stopping = true;
    killing ||= kill;
    if (kill) for (const pid of agents) killGroup(pid);
    for (const wake of wakers) wake();
  }
  const handOff = () => stop(false);
  const kill = () => stop(true);
  const aborted = () => stop(options.signal?.reason === "kill");

  function ended(): string | undefined {
    if (stopping) return "turned off";
    if (options.until && Date.now() >= options.until) return "until passed";
  }

  /** A wait that stopping cuts short. */
  function nap(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        wakers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      wakers.add(wake);
    });
  }

  /**
   * Holds a pool until its 5-hour window resets once the window reaches the pool's reserve, so
   * other apps on the account keep some. Reads at most once a minute; a failed read holds nothing.
   * Reads the settings each time, so a changed reserve applies at once.
   */
  function keepReserve(pool: Pool): Promise<void> {
    const reserve = readSettings(state).reserves[pool.name];
    const last = reads.get(pool.name);
    if (reserve === undefined || pool.until) return Promise.resolve();
    if (last && Date.now() - last.at < MINUTE) return last.done;
    const done = (options.usage ?? fiveHour)(pool.name).then(
      ({ used, resets }) => {
        pool.used = used;
        if (used >= 100 - reserve && resets && resets > Date.now()) {
          const wake = Math.min(resets + 2 * MINUTE, options.until ?? Infinity);
          Object.assign(pool, { until: new Date(wake).toISOString(), reserved: true });
          log(`${pool.name} used ${used}% of its 5 hours, keeps ${reserve}% until ${pool.until}`);
        }
        writeStatus();
      },
      (error: Error) => log(`can't read ${pool.name}'s usage: ${error.message}`),
    );
    reads.set(pool.name, { at: Date.now(), done });
    return done;
  }

  /** The triggers' part: look for new events every few minutes, in the background. */
  let watched = 0;
  let watching: Promise<void> | undefined;
  function lookOut(): void {
    if (watching || Date.now() - watched < WATCH_EVERY) return;
    watched = Date.now();
    watching = (options.watch ?? watch)(state)
      .then((lines) => lines.forEach(log))
      .catch((error: Error) => log(`triggers failed: ${error.message}`))
      .finally(() => (watching = undefined));
  }

  /** Nobody may be around to answer, overnight least of all: a question waits only so long. */
  function moveOnFromAsks(): void {
    for (const job of readJobs(state)) {
      if (job.blocked !== "asked" || job.state !== "blocked") continue;
      const ask = job.notes.findLast((note) => note.kind === "ask");
      if (ask && Date.now() - Date.parse(ask.at) < ASK_WAIT) continue;
      // An answer like the user's, so the question counts as settled everywhere a real one does.
      answer(state, job.id, NO_ANSWER);
      log(`${job.id} goes on without an answer`);
    }
  }

  /** Auto mode's part: keep a few of its jobs queued. Reads settings each time, so the toggle applies at once. */
  function topUp(): void {
    topping ??= fillFromAuto()
      .catch((error: Error) => log(`auto mode could not ask workwork: ${error.message}`))
      .finally(() => (topping = undefined));
  }

  async function fillFromAuto(): Promise<void> {
    const { auto } = readSettings(state);
    if (!auto.on) return;
    const wanted = () =>
      AUTO_PER_WORKER * slots.length -
      readJobs(state).filter((job) => job.source === "auto" && job.state === "queued").length;
    if (wanted() <= 0) return;
    const cached = readCandidates(state);
    if (!cached || Date.now() - Date.parse(cached.at) > STALE_CANDIDATES)
      await refreshCandidates(state, options.workwork);
    const candidates = readCandidates(state);
    if (!candidates) return;
    const added = addJobs(
      state,
      autoPicks(candidates.items, readJobs(state), auto, wanted()),
      "auto",
    );
    if (added.length) log(`auto mode queued ${added.length}`);
  }

  const free = (preset: string, self: Worker) =>
    slots.some(
      ({ worker }) =>
        worker.preset === preset &&
        (worker === self || worker.state === "idle") &&
        !pools.get(worker.pool)!.until,
    );
  const usable = (preset: string) =>
    slots.some(({ worker }) => worker.preset === preset && !pools.get(worker.pool)!.stopped);

  /**
   * Which preset a tiered job runs on: the first in its tier's list (then higher tiers' when its goal
   * allows) whose pool isn't limited and that has a free worker; undefined: it waits. null: none of
   * this run's presets serve the tier, so any free worker takes it.
   */
  function choose(job: Job, jobs: Job[], self: Worker): string | null | undefined {
    const goal = jobs.find((each) => each.id === job.of)?.goal;
    const at = TIERS.indexOf(job.tier!);
    const tiers = goal?.allowUp ? TIERS.slice(0, at + 1).reverse() : [job.tier!];
    const ids = tiers.flatMap((tier) => settings.tiers[tier]).filter(usable);
    if (ids.length === 0) return null;
    return ids.find((preset) => free(preset, self));
  }

  /** The next job this worker takes, decided without awaiting anything, so two workers never take one. */
  function pick({ worker }: Slot): Job | undefined {
    const jobs = readJobs(state);
    for (const job of jobs) {
      if (!ready(job, jobs)) continue;
      if (job.open) {
        // A paused attempt goes on with its own session, so only its preset can take it, or its
        // agent when this run doesn't have that preset.
        const begun = readLive(state, job.id)?.begun;
        const here = slots.some((slot) => slot.worker.preset === begun?.preset);
        if (begun?.preset === worker.preset || (!here && begun?.agent === worker.agent)) return job;
        continue;
      }
      if (job.preset && slots.some((slot) => slot.worker.preset === job.preset)) {
        if (job.preset === worker.preset) return job;
        continue;
      }
      if (job.tier) {
        const chosen = choose(job, jobs, worker);
        if (chosen === worker.preset) return job;
        if (chosen !== null) continue;
      }
      if (firstFree(job.agent, worker) === worker) return job;
    }
  }

  /**
   * Who takes a job without a worker of its own: the first free worker in settings order, of its agent
   * when it names one. A pin on a preset this run has no worker for lands here, on the pin's tuning.
   */
  const firstFree = (agent: string | undefined, self: Worker) =>
    slots.find(
      ({ worker }) =>
        (agent ?? worker.agent) === worker.agent &&
        (worker === self || worker.state === "idle") &&
        !pools.get(worker.pool)!.until,
    )?.worker;

  async function work(slot: Slot, handed?: Handed): Promise<void> {
    const { worker } = slot;
    const pool = pools.get(worker.pool)!;
    while (!ended()) {
      topUp();
      lookOut();
      moveOnFromAsks();
      if (pool.stopped) return set(worker, { state: "stopped", reason: pool.stopped });
      if (!handed) await keepReserve(pool);
      if (pool.until) {
        set(worker, { state: "sleeping", until: pool.until });
        await (options.sleep ?? nap)(Math.max(0, Date.parse(pool.until) - Date.now()));
        Object.assign(pool, { until: undefined, reserved: undefined });
        continue;
      }
      let job: Job | undefined;
      let result: Turned | undefined;
      if (handed) {
        ({ job } = handed);
        set(worker, { state: "working", job: job.id });
        log(`${worker.id} takes over ${job.id} from run ${handed.live.begun.run}`);
        const taken = job;
        result = await attempt(slot, job, handed.live).catch((error: Error) => broke(taken, error));
        handed = undefined;
      } else {
        job = pick(slot);
        if (!job) {
          if (worker.state !== "idle") set(worker, { state: "idle" });
          await nap(options.pollMs ?? 3000);
          continue;
        }
        startJob(state, job.id, worker.agent, worker.preset);
        set(worker, { state: "working", job: job.id });
        log(`${worker.id} starts ${job.id}: ${job.item.label} ${job.item.id}`);
        const taken = job;
        result = await attempt(slot, job, readLive(state, job.id)).catch((error: Error) =>
          broke(taken, error),
        );
      }
      if (!result) {
        // The run stopped: before the agent started the job goes back; a running agent is handed off.
        const live = readLive(state, job.id);
        if (!live?.pid) record(state, { type: "requeue", id: job.id });
        break;
      }
      if (result.paused) {
        record(state, { type: "pause", id: job.id, reason: result.paused });
        if (discardCancelledJob(state, readJobs(state), job))
          log(`${worker.id} discards ${job.id}: its goal was canceled`);
        else log(`${worker.id} ${job.id} waits: ${result.paused}`);
      } else {
        endJob(state, job.id, result.attempt);
        log(
          `${worker.id} ${result.attempt.outcome} ${job.id} ${result.attempt.url ?? result.attempt.error?.split("\n")[0] ?? ""}`,
        );
        const fix = queueReviewFix(state, job.id);
        if (fix) log(`${job.id} found something: queued ${fix.id}, ${fix.item.title}`);
        // Still holding the worktree: a goal node merges from it.
        const worktree = readLive(state, job.id)?.worktree;
        if (worktree) {
          await afterAttempt(state, job.id, worktree, log);
          // Lets go of its branch, which a later job may check out elsewhere. When that fails, the
          // next job's checkout forces it anyway.
          await release(worktree).catch((error: Error) =>
            log(`can't release ${worktree}: ${error.message.trim().split("\n")[0]}`),
          );
        }
        rmSync(livePath(state, job.id), { force: true });
        const seconds = (Date.parse(result.attempt.end) - Date.parse(result.attempt.start)) / 1000;
        slot.quickFailures =
          result.attempt.outcome === "failed" && seconds < 60 ? slot.quickFailures + 1 : 0;
        if (slot.quickFailures >= 3)
          return set(worker, {
            state: "stopped",
            reason: `3 failures in a row under a minute; last: ${result.attempt.error?.split("\n")[0] ?? "see its log"}`,
          });
      }
      if (result.paused !== "limited") {
        set(worker, { state: "idle" });
        continue;
      }
      // Other workers of the pool hit the same limit meanwhile; that's one hit, not several.
      if (pool.until) continue;
      pool.limits++;
      if (options.limit !== null && pool.limits >= options.limit) {
        pool.stopped = `limit ${pool.limits} of ${options.limit}`;
        continue;
      }
      const reset = resetTime(result.text, Date.now());
      const wake = Math.min(
        reset === undefined ? Date.now() + 30 * MINUTE : reset + 2 * MINUTE,
        options.until ?? Infinity,
      );
      pool.until = new Date(wake).toISOString();
      log(`${worker.pool} hit limit ${pool.limits}, sleeps until ${pool.until}`);
    }
    set(worker, { state: "stopped", reason: ended() });
  }

  /**
   * One job's trouble (git in its worktree, a gate that won't run) fails that job; it doesn't end
   * the run and every agent working in it.
   */
  function broke(job: Job, error: Error): Turned {
    const begun = readLive(state, job.id)?.begun;
    if (!begun) throw error;
    const message = error.message.trim();
    log(`${job.id} broke: ${message.split("\n")[0]}`);
    const end = new Date().toISOString();
    return {
      attempt: { ...begun, end, outcome: "failed", error: message.slice(0, 2000) },
      text: "",
    };
  }

  /**
   * One attempt as a session: the first turn, or the turn that picks a paused one up, then follow-ups
   * while a gate fails or the agent stopped without finishing. Undefined when the run stopped first.
   */
  async function attempt(slot: Slot, job: Job, live?: Live): Promise<Turned | undefined> {
    const { worker, preset } = slot;
    if (!live) {
      const begun = await begin(slot, job);
      if ("failed" in begun) return { attempt: begun.failed, text: "" };
      live = begun.live;
    } else if (!live.pid) {
      if (stopping) return undefined;
      live = nextTurn(
        live,
        resumeText(
          live,
          readJobs(state).find((each) => each.id === job.id)!,
        ),
      );
    }
    const agentOf = () =>
      makeAgent(worker.agent, live!.begun, {
        id: live!.session,
        resume: live!.turns > (live!.sessionTurn ?? 1),
        folder: join(state, "sessions"),
        compactAt: worker.agent === "claude" ? compactAt(preset) : undefined,
      });
    for (;;) {
      if (!live.pid) {
        if (stopping) return undefined;
        live.pid = startAgent(agentOf(), live, job.id, envFor(job, live.worktree));
        writeLive(state, job.id, live);
      }
      const turn = await finishTurn(worker, live);
      if (!turn) return undefined;
      const { code, facts, timedOut, text } = turn;
      live.pid = undefined;
      if (killing) return { attempt: await end(job, live, "stopped", facts), text };
      if (timedOut) return { attempt: await end(job, live, "timeout", facts), text };
      const outcome = classify(makeAgent(worker.agent, live.begun), code, text, facts.error);
      if (outcome === "limited") return pause(job, live, "limited", text);
      // Once: an agent that saves no session at all would start over at every follow-up.
      if (outcome === "failed" && live.turns > 1 && !live.sessionTurn && LOST_SESSION.test(text)) {
        live = restart(job, live);
        continue;
      }
      const fresh = readJobs(state).find((each) => each.id === job.id)!;
      const said = fresh.notes.filter((note) => note.attempt === fresh.attempts.length + 1);
      // A question since the last answer: this turn asked it.
      const answered = said.findLastIndex(
        (note) => note.kind === "answer" && note.re === undefined,
      );
      if (said.slice(answered + 1).some((note) => note.kind === "ask"))
        return pause(job, live, "asked", text);
      // It ran `factory alone` this turn: it goes on once no other job runs.
      if (fresh.machine && !job.machine) return pause(job, live, "alone", text);
      const problem =
        outcome === "failed" || !said.some((note) => note.kind === "result")
          ? unfinished(code, facts, text)
          : await gates(fresh, live.worktree);
      if (!problem) return { attempt: await end(job, live, "done", facts), text };
      const allowed = preset.followups ?? FOLLOWUPS;
      if (live.followups >= allowed)
        return { attempt: await end(job, live, "failed", facts, problem.split("\n")[0]), text };
      live.followups++;
      record(state, {
        type: "note",
        id: job.id,
        note: {
          kind: "factory",
          text: `follow-up ${live.followups} of ${allowed}: ${problem.split("\n")[0]}`,
        },
      });
      live = nextTurn(live, problem);
      writeLive(state, job.id, live);
    }
  }

  /** Sets up a new attempt: worktree, prompt, session. */
  async function begin(slot: Slot, job: Job): Promise<{ live: Live } | { failed: Attempt }> {
    const { worker } = slot;
    const tuning = { model: job.model ?? worker.model, effort: job.effort ?? worker.effort };
    const dir = join(runDir, `${job.id}-${job.attempts.length + 1}`);
    mkdirSync(dir, { recursive: true });
    const begun: Begun = {
      run: id,
      agent: worker.agent,
      ...tuning,
      preset: worker.preset,
      start: new Date().toISOString(),
      log: join(dir, "agent.log"),
    };
    const worktree = borrow(state, job.item.repo, borrowed);
    // Held from here, so another worker setting up meanwhile takes the next one.
    borrowed.add(worktree);
    const missing = job.needs.filter((need) => !settings.capabilities.includes(need));
    let prompt: string;
    try {
      const jobs = readJobs(state);
      prompt = await prepare(state, job, jobs, worktree, options.workwork);
    } catch (error) {
      // The repo or workwork failed, not the agent: record why and move on.
      borrowed.delete(worktree);
      const message = (error as Error).message.trim();
      writeFileSync(begun.log, `${message}\n`);
      return {
        failed: {
          ...begun,
          end: new Date().toISOString(),
          outcome: "failed",
          error: message.slice(0, 2000),
        },
      };
    }
    const turn = join(dir, "prompt.md");
    writeFileSync(turn, prompt + earlier(job) + lacking(missing) + reporting(job, begun));
    writeFileSync(begun.log, "");
    const live: Live = {
      begun,
      session: randomUUID(),
      worktree,
      dir,
      turns: 1,
      followups: 0,
      turn,
      offset: 0,
      missing,
    };
    writeLive(state, job.id, live);
    borrowed.delete(worktree);
    return { live };
  }

  /** The next turn of the same session, with what it picks up from. */
  function nextTurn(live: Live, message: string): Live {
    const turns = live.turns + 1;
    const turn = join(live.dir, `turn-${turns}.md`);
    writeFileSync(turn, message);
    return {
      ...live,
      turns,
      turn,
      offset: size(live.begun.log),
      waiting: undefined,
      pid: undefined,
    };
  }

  /**
   * The session to resume was never saved, say because a run stopped before its first turn got
   * going: a new session starts from the prompt, with what this turn had to say after it.
   */
  function restart(job: Job, live: Live): Live {
    const prompt = readFileSync(join(live.dir, "prompt.md"), "utf8");
    const message = readFileSync(live.turn, "utf8");
    const next = nextTurn(
      live,
      `${prompt}\n## Picking up\n\nAn earlier session at this job was lost; whatever it did is still in this folder.\n\n${message}`,
    );
    record(state, {
      type: "note",
      id: job.id,
      note: {
        kind: "factory",
        text: "the session to resume was lost; a new one starts from the prompt",
      },
    });
    const restarted = { ...next, session: randomUUID(), sessionTurn: next.turns };
    writeLive(state, job.id, restarted);
    return restarted;
  }

  function pause(job: Job, live: Live, reason: Paused, text: string): Turned {
    writeLive(state, job.id, { ...live, pid: undefined, waiting: reason });
    return { paused: reason, text };
  }

  /**
   * Waits for the turn's agent, ending it once it shows no sign of life for the idle time, and keeps
   * the worker's activity and context up to date from its stream. Undefined when the run hands it off.
   */
  async function finishTurn(worker: Worker, live: Live) {
    const exit = join(live.dir, "exit");
    const pid = live.pid!;
    let facts = noFacts();
    let read = live.offset;
    let quiet = Date.now();
    let timedOut = false;
    agents.add(pid);
    try {
      // The exit file first: after a long hand-off the pid may be some other process's by now.
      while (!existsSync(exit) && alive(pid)) {
        if (stopping && !killing) return undefined;
        const grown = size(live.begun.log);
        if (grown > read) {
          facts = readStream(slice(live.begun.log, live.offset, grown));
          read = grown;
          quiet = Date.now();
          if (worker.activity !== facts.activity || worker.context !== facts.context) {
            Object.assign(worker, {
              activity: facts.activity,
              context: facts.context || undefined,
            });
            writeStatus();
          }
        }
        if (!timedOut && Date.now() - quiet >= options.idleMs) {
          timedOut = true;
          killGroup(pid);
        }
        await nap(Math.min(options.pollMs ?? 1000, 1000));
      }
    } finally {
      agents.delete(pid);
    }
    // Whatever the agent left running in its group goes with it.
    killGroup(pid);
    const text = slice(live.begun.log, live.offset, size(live.begun.log));
    // No exit file: something killed the agent and its shell.
    const code = existsSync(exit) ? Number(readFileSync(exit, "utf8")) : 1;
    rmSync(exit, { force: true });
    return { code, facts: readStream(text), timedOut, text };
  }

  /** Records the attempt: its kept work, link and numbers summed over its turns. */
  async function end(
    job: Job,
    live: Live,
    outcome: Outcome,
    last: Facts,
    error?: string,
  ): Promise<Attempt> {
    const branch = await keepWork(live.worktree, `factory/${basename(live.dir)}`);
    const whole = readFileSync(live.begun.log, "utf8");
    const facts = readStream(whole);
    const fresh = readJobs(state).find((each) => each.id === job.id)!;
    const result = fresh.notes.findLast(
      (note) => note.kind === "result" && note.attempt === fresh.attempts.length + 1,
    );
    const url =
      (outcome === "done" && !job.of && (await delivered(job.item))) ||
      result?.url ||
      whole.match(URL)?.at(-1);
    return {
      ...live.begun,
      end: new Date().toISOString(),
      outcome,
      url: url || undefined,
      branch,
      error: error ?? (outcome === "failed" ? last.error?.slice(0, 2000) : undefined),
      session: facts.session ?? live.session,
      turns: live.turns,
      followups: live.followups,
      peak: facts.peak || undefined,
      compactions: facts.compactions,
      tokens: facts.tokens,
      missing: live.missing.length ? live.missing : undefined,
    };
  }

  /** Factory's own checks on a turn the agent called finished: the job's gates, in its worktree. */
  async function gates(job: Job, worktree: string): Promise<string | undefined> {
    const own = builtinCheck(job, readJobs(state), worktree);
    if (own) return own;
    for (const gate of job.gates) {
      const failed = await runGate(gate, worktree, envFor(job, worktree));
      if (failed !== undefined)
        return `The gate \`${gate}\` failed. The last lines of its output:\n\n\`\`\`\n${failed}\n\`\`\`\n\nFix this; the gates run again when you stop.`;
    }
  }

  function envFor(job: Job, worktree: string): Record<string, string> {
    const extra = settings.env[job.item.repo] ?? {};
    return Object.fromEntries(
      Object.entries(extra).map(([key, value]) => [key, value.replaceAll("{worktree}", worktree)]),
    );
  }

  /**
   * Attempts the last run left: those whose agent still works go to this run's worker for that
   * preset (or agent); those whose agent died mid-turn wait to be picked up again; the rest stopped
   * before their agent started, so they go back to the queue.
   */
  const handed = new Map<Slot, Handed>();
  for (const job of readJobs(state)) {
    if (job.state !== "running") continue;
    const live = readLive(state, job.id);
    if (!live?.pid) {
      if (!live) record(state, { type: "requeue", id: job.id });
      else record(state, { type: "pause", id: job.id, reason: "limited" });
      continue;
    }
    if (!alive(live.pid) && !existsSync(join(live.dir, "exit"))) {
      writeLive(state, job.id, { ...live, pid: undefined, waiting: "interrupted" });
      record(state, { type: "pause", id: job.id, reason: "limited" });
      continue;
    }
    const slot =
      slots.find((each) => each.worker.preset === live.begun.preset && !handed.has(each)) ??
      slots.find((each) => each.worker.agent === live.begun.agent && !handed.has(each));
    if (slot) handed.set(slot, { job, live });
  }
  process.on("SIGTERM", handOff);
  process.on("SIGINT", kill);
  options.signal?.addEventListener("abort", aborted);
  const stopMirror = mirrorTasks(state, settings, log);
  writeStatus();
  try {
    // Retried after every goal job; a failed fetch here shouldn't keep the factory off.
    await finishGoals(state, log).catch((error: Error) =>
      log(`can't finish goals: ${error.message.trim().split("\n")[0]}`),
    );
    await Promise.all(slots.map((slot) => work(slot, handed.get(slot))));
  } catch (error) {
    kill();
    throw error;
  } finally {
    process.off("SIGTERM", handOff);
    process.off("SIGINT", kill);
    options.signal?.removeEventListener("abort", aborted);
    stopMirror();
    await topping;
    writeStatus();
    log(
      `off: ${slots.map(({ worker }) => `${worker.id} ${worker.reason ?? worker.state}`).join(", ")}`,
    );
  }
  return id;
}

type Handed = { job: Job; live: Live };
type Turned =
  | { paused?: undefined; attempt: Attempt; text: string }
  | { paused: Paused; text: string };
type Paused = "asked" | "limited" | "alone";

/** Each preset's workers with the preset it runs, with the run's counts over the settings'. */
export function makeSlots(settings: Settings, counts: Record<string, number> = {}): Slot[] {
  const byId = new Map(settings.presets.map((preset) => [presetId(preset), preset]));
  return presetWorkers(settings.presets, counts).map((worker) => ({
    worker,
    preset: byId.get(worker.preset)!,
    quickFailures: 0,
  }));
}

/**
 * Pi has no per-run compaction flag: it compacts at the model's window minus `reserveTokens`, set per
 * model in its settings. Factory only checks them, and says what to add.
 */
export function piSettingsWarnings(presets: Preset[], windows: Record<string, number>): string[] {
  const file = join(
    process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent"),
    "settings.json",
  );
  const overrides: Record<string, { reserveTokens?: number }> = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")).compaction?.modelOverrides ?? {})
    : {};
  return presets.flatMap((preset) => {
    if (preset.agent !== "pi" || !preset.model) return [];
    const window = windows[preset.model];
    if (!window) return [];
    const reserve = window - compactAt(preset);
    if (reserve <= 0 || overrides[preset.model]?.reserveTokens === reserve) return [];
    return [
      `pi compacts ${preset.model} at its own threshold, not at ${compactAt(preset)} tokens; add to ${file}: ${JSON.stringify({ compaction: { modelOverrides: { [preset.model]: { reserveTokens: reserve } } } })}`,
    ];
  });
}

/** What a paused attempt's next turn says. */
function resumeText(live: Live, job: Job): string {
  if (live.waiting === "asked") {
    const said = job.notes.findLast((note) => note.kind === "answer" && note.re === undefined);
    if (said?.text === NO_ANSWER)
      return `Nobody answered your question within ${ASK_WAIT / MINUTE} minutes. Go with your recommendation, or with the option that deletes and publishes nothing when yours would, and record it with \`factory ask "<question>" --assume "<what you chose>"\` so the user can still weigh in. Then carry on with the job.`;
    return `The user answered your question: ${said?.text ?? "(no answer recorded)"}\n\nCarry on with the job.`;
  }
  if (live.waiting === "limited")
    return "You were stopped by a usage limit, which has reset. Carry on where you left off.";
  if (live.waiting === "alone")
    return "No other job runs now, and none starts until you finish. Do what needed the machine, then carry on with the job.";
  return "Your run was interrupted before it finished. Check where you were and carry on.";
}

/** Why a turn that ended doesn't count as finished, quoting how it ended. */
function unfinished(code: number, facts: Facts, text: string): string {
  const tail = (facts.text ?? text.split("\n").slice(-20).join("\n")).slice(-3000);
  return `You stopped without finishing${code === 0 ? " (no `factory result` or `factory ask`)" : ` (exit code ${code})`}. Here is how the run ended:\n\n\`\`\`\n${tail}\n\`\`\`\n\nFinish the job, or report with \`factory result\` why you can't.`;
}

/** Runs a gate; undefined when it passes, else the last 200 lines of its output. */
async function runGate(
  gate: string,
  cwd: string,
  env: Record<string, string>,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", gate], {
      cwd,
      env: { ...process.env, ...env },
      detached: true,
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    const timer = setTimeout(() => killGroup(child.pid!), GATE_TIMEOUT);
    child.on("close", (code) => {
      clearTimeout(timer);
      const tail = Buffer.concat(chunks).toString("utf8").split("\n").slice(-200).join("\n");
      resolve(code === 0 ? undefined : tail || `exit code ${code}`);
    });
  });
}

const size = (path: string) => (existsSync(path) ? statSync(path).size : 0);

function slice(path: string, from: number, to: number): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, to - from));
    readSync(fd, buffer, 0, buffer.length, from);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * The agent in its own process group, so a timeout or kill takes down everything it started, and
 * detached, so it outlives a run that hands it off. The shell in between reads the turn from a file
 * and writes the exit code to one, both of which outlast this process. Returns the group's pid.
 */
function startAgent(agent: Agent, live: Live, job: string, env: Record<string, string>): number {
  const log = openSync(live.begun.log, "a");
  const child = spawn(
    "sh",
    [
      "-c",
      'dir=$1; turn=$2; shift 2; "$@" <"$turn"; echo $? >"$dir/exit"',
      "sh",
      live.dir,
      live.turn,
      agent.command,
      ...agent.args,
    ],
    {
      cwd: live.worktree,
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, ...env, FACTORY_JOB: job },
    },
  );
  closeSync(log);
  child.unref();
  return child.pid!;
}

/**
 * A worktree of the repo no attempt holds: running or paused attempts keep theirs. The pool grows by
 * one when all are taken.
 */
function borrow(state: string, repo: string, borrowed: Set<string>): string {
  const key = createHash("sha256").update(repo).digest("hex").slice(0, 16);
  const held = new Set([
    ...borrowed,
    ...readJobs(state).flatMap((job) => readLive(state, job.id)?.worktree ?? []),
  ]);
  for (let n = 1; ; n++) {
    const worktree = join(state, "worktrees", key, String(n));
    if (!held.has(worktree)) return worktree;
  }
}

const NOTE_LABEL: Record<string, string> = {
  note: "note",
  ask: "it asked",
  assume: "it assumed",
  answer: "the user answered",
  result: "result",
  step: "step",
  train: "merge train",
  factory: "factory",
  alone: "it needed to run alone",
};

/** What earlier attempts said and kept, so a retry picks up where they left off. */
function earlier(job: Job): string {
  if (job.attempts.length === 0) return "";
  const lines = job.attempts.flatMap((attempt, i) => [
    `\nAttempt ${i + 1} (${attempt.agent}, ${attempt.outcome})${attempt.branch ? `: its work is kept on branch ${attempt.branch}; start from it with \`git checkout -B ${attempt.branch}\`` : ""}`,
    ...job.notes
      .filter((note) => note.attempt === i + 1 && note.kind !== "step")
      .map(
        (note) =>
          `- ${NOTE_LABEL[note.kind]}: ${note.text}${note.assumed ? ` (assumed: ${note.assumed})` : ""}`,
      ),
  ]);
  return `\n\n## Earlier attempts at this job\n${lines.join("\n")}\n`;
}

/** Needs nobody here can check, so the agent verifies what it can and says what it couldn't. */
function lacking(missing: string[]): string {
  if (missing.length === 0) return "";
  return `\n\nThis job needs ${missing.join(", ")} to verify, and this machine has none of that. Verify what you can without it, and name what you couldn't check in your result with \`--unverified\`.\n`;
}

/** How the agent reports back. Nobody watches a run, so this is all the user learns besides the PR. */
function reporting(job: Job, { agent, model, effort }: Begun): string {
  // argv[1] is this CLI, whether it runs from dist or, under pn dev, from source.
  const factory = `"${process.execPath}" "${process.argv[1]}"`;
  const signature = [agent, model, effort].filter(Boolean).join(" · ");
  return `
---
You run headless for factory as job ${job.id}, and nobody watches live. Report through its CLI:

- \`${factory} step "<what you're doing now>" [--done N --of M]\` at each meaningful step (not every command), so the user sees where you are.
- \`${factory} note "<text>"\` records something worth knowing later: what you found, tried, or what's in the way. A few per job, not a play-by-play.
- Decide for yourself wherever a reasonable engineer would. When the user might decide otherwise, run \`${factory} ask "<question>" --assume "<what you'll do>"\` and carry on with that; the user answers later, and a different answer becomes a job of its own.
- Only for a decision too costly to guess (a data format, deleting things, anything public), run \`${factory} ask "<question, with the options and your recommendation>"\` without --assume and end there. Your work in this folder is kept, and you'll get the answer in this same session. Nobody may be around: after ${ASK_WAIT / MINUTE} minutes without an answer you'll be told to go with your recommendation.
- Before you end, run \`${factory} result "<what changed and why, in a sentence or two>" --confidence low|medium|high\`, adding \`--url <link>\` for the PR or issue you opened, \`--followup "<task>"\` for each task you saw that deserves its own job, and \`--unverified "<what>"\` for each thing you couldn't check. Factory may run checks after you stop and come back to you with what failed.
- ${
    job.machine
      ? "No other job runs while you work, so you may change things outside this folder when the job needs it. Put back anything you change only to verify, like a stopped service or a taken port."
      : `Other jobs run on this machine at the same time, each in its own folder. Change nothing outside this one: no global installs, no edits under your home folder, no services left running, no fixed ports, no git stash (every worktree shares it). If the job can't be done without that, run \`${factory} alone "<what you need and why>"\` and end your turn; you'll carry on in this session once no other job runs.`
  }
- In a PR description you write, add the line \`Agent: ${signature}\`.
- When the PR changes what users see, add screenshots of the app running to its description, with before and after when existing UI changes. \`gh\` can't upload images, so commit them to the repo's \`screenshots\` branch (an orphan branch; create it if it's missing) under a folder named after the PR's branch, and embed them from \`https://github.com/<owner>/<repo>/raw/screenshots/<path>\`. Keep them out of the PR's own commits.
`;
}

/** The PR the agent opened, as GitHub knows it; undefined when gh can't tell, and the log's last link stands in. */
async function delivered(item: Item): Promise<string | undefined> {
  try {
    return await findPr(item);
  } catch (error) {
    log(`gh can't find the PR for ${item.id}: ${(error as Error).message.trim().split("\n")[0]}`);
    return undefined;
  }
}

function killGroup(pid: number): void {
  for (const [signal, delay] of [
    ["SIGTERM", 0],
    ["SIGKILL", 10_000],
  ] as const)
    setTimeout(() => {
      try {
        process.kill(-pid, signal);
      } catch (error) {
        // The group is already gone.
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }, delay).unref();
}

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { pinJob } from "../src/backend/jobs.ts";
import { readSettings, writeSettings } from "../src/backend/state.ts";
import {
  scratch,
  MINUTE,
  sh,
  agents,
  setup,
  options,
  work,
  status,
  RESULT,
  OK,
  LIMIT_ERROR,
  STARTUP_LIMIT,
} from "./harness.ts";

describe("the factory", () => {
  test.each([
    { limit: 2, claude: 1, poolState: "sleeping" },
    { limit: 1, claude: 2, poolState: "stopped" },
  ])(
    "Pi takes a startup-rejected job while Claude's pool is $poolState",
    async ({ limit, claude, poolState }) => {
      const base = setup(["a"]);
      agents({ claude: STARTUP_LIMIT, pi: `echo '{"type":"session","id":"pi-new"}'; ${OK}` });
      const added = base.pick("a");
      // Never simulate the reset before Pi finishes. The deadline lets a broken scheduler shut down.
      let wake!: () => void;
      const cooldown = new Promise<void>((resolve) => (wake = resolve));
      const sleeps: number[] = [];
      const deadline = Date.now() + 3000;
      let claudeStates: string[] = [];
      const [job] = await work(
        {
          ...options(base, { claude, pi: 1 }),
          limit,
          sleep: (ms) => {
            sleeps.push(ms);
            return cooldown;
          },
        },
        ([job]) => {
          if (job.state !== "done" && Date.now() < deadline) return false;
          claudeStates = status(base.state)
            .workers.filter((worker) => worker.agent === "claude")
            .map((worker) => worker.state);
          wake();
          return true;
        },
      );
      expect(claudeStates).toEqual(Array(claude).fill(poolState));
      if (poolState === "sleeping") {
        expect(sleeps).toHaveLength(1);
        expect(sleeps[0]).toBeGreaterThan(60 * MINUTE);
      } else expect(sleeps).toEqual([]);
      expect(job).toMatchObject({ id: added.id, state: "done", open: false, agent: "pi" });
      expect(job.attempts).toMatchObject([
        {
          agent: "claude",
          outcome: "limited",
          turns: 1,
          session: "startup",
          error: LIMIT_ERROR,
          tokens: { input: 0, cached: 0, output: 0 },
        },
        { agent: "pi", outcome: "done", turns: 1, session: "pi-new" },
      ]);
      expect(status(base.state).pools.find((pool) => pool.name === "claude")?.limits).toBe(1);
      expect(readFileSync(job.attempts[0].log, "utf8")).toContain('"model":"<synthetic>"');
      expect(existsSync(join(base.state, "running", `${job.id}.json`))).toBe(false);
    },
  );

  test.each([{ agent: "claude" }, { preset: "claude" }])(
    "a startup rejection preserves an explicit Claude pin %j",
    async (pin) => {
      const base = setup(["a", "b"]);
      agents({ claude: STARTUP_LIMIT, pi: OK });
      base.pick("a", pin);
      let added = false;
      const deadline = Date.now() + 3000;
      const [held, done] = await work({ ...options(base, {}), limit: 1 }, ([held, other]) => {
        if (!added && held.attempts.length) {
          base.pick("b");
          added = true;
        }
        return other?.state === "done" || Date.now() >= deadline;
      });
      expect(held).toMatchObject({
        ...pin,
        agent: pin.agent,
        state: "queued",
        open: false,
        attempts: [{ agent: "claude", outcome: "limited" }],
      });
      expect(done?.attempts).toMatchObject([{ agent: "pi", outcome: "done" }]);
    },
  );

  test.each(["same turn", "earlier turn"])(
    "a limit after progress in the %s keeps the session",
    async (when) => {
      const base = setup(["a"]);
      const progress = `echo '{"type":"assistant","message":{"model":"claude-sonnet","content":[{"type":"tool_use","name":"Read","input":{"file_path":"README.md"}}]}}'`;
      agents({
        claude:
          when === "same turn"
            ? `${progress}\n${STARTUP_LIMIT}`
            : `case "$*" in *--resume*) ;; *) ${progress}; exit 1 ;; esac\n${STARTUP_LIMIT}`,
        pi: OK,
      });
      const added = base.pick("a");
      const deadline = Date.now() + 3000;
      const [paused] = await work(
        { ...options(base, {}), limit: 1 },
        () =>
          status(base.state).workers.some((worker) => worker.reason === "limit 1 of 1") ||
          Date.now() >= deadline,
      );
      expect(paused).toMatchObject({ state: "queued", open: true, agent: "claude", attempts: [] });
      const live = JSON.parse(
        readFileSync(join(base.state, "running", `${added.id}.json`), "utf8"),
      );
      const turns = when === "same turn" ? 1 : 2;
      expect(live).toMatchObject({ waiting: "limited", turns });
      agents({ claude: `echo "$*"; ${OK}` });
      const [done] = await work(options(base, {}));
      expect(done.attempts).toMatchObject([{ agent: "claude", outcome: "done", turns: turns + 1 }]);
      expect(readFileSync(done.attempts[0].log, "utf8")).toContain(`--resume ${live.session}`);
    },
  );

  test("limit 1: a pool stops at its first limit hit and the factory turns off with no worker left", async () => {
    const base = setup(["a"]);
    agents({ claude: "echo 'Claude AI usage limit reached|1794801600'; exit 1" });
    base.pick("a");
    const wakes: number[] = [];
    const [job] = await work(
      { ...options(base), limit: 1, sleep: async (ms) => void wakes.push(ms) },
      () => false,
    );
    expect(job).toMatchObject({ state: "queued", agent: "claude", open: true, attempts: [] });
    expect(wakes).toHaveLength(0);
    expect(status(base.state).workers[0]).toMatchObject({
      state: "stopped",
      reason: "limit 1 of 1",
    });
    expect(status(base.state).pools).toEqual([
      { name: "claude", limits: 1, stopped: "limit 1 of 1" },
    ]);
  });

  test("a paused job pinned elsewhere drops its session and starts fresh there", async () => {
    const base = setup(["a"]);
    agents({ claude: "echo 'Claude AI usage limit reached|1794801600'; exit 1" });
    const added = base.pick("a");
    await work({ ...options(base), limit: 1, sleep: async () => {} }, () => false);
    pinJob(base.state, added.id, { agent: "pi" });
    expect(existsSync(join(base.state, "running", `${added.id}.json`))).toBe(false);
    agents({ pi: OK });
    const [done] = await work(options(base, {}));
    expect(done.attempts).toMatchObject([
      { agent: "claude", outcome: "stopped" },
      { agent: "pi", outcome: "done" },
    ]);
  });

  test("sleeps until the parsed reset, resumes the session, and stops at its limit", async () => {
    const base = setup(["a", "b"]);
    const reset = Math.floor(Date.now() / 1000) + 3600;
    agents({ claude: `echo 'Claude AI usage limit reached|${reset}'; exit 1` });
    base.pick("a");
    base.pick("b");
    const wakes: number[] = [];
    const jobs = await work(
      { ...options(base), sleep: async (ms) => void wakes.push(Date.now() + ms) },
      () => false,
    );
    expect(jobs[0]).toMatchObject({ open: true, attempts: [] });
    expect(jobs[1]).toMatchObject({ open: false, attempts: [] });
    const dir = join(base.state, "running");
    const live = JSON.parse(readFileSync(join(dir, `${jobs[0].id}.json`), "utf8"));
    expect(live).toMatchObject({ turns: 2, waiting: "limited" });
    expect(wakes).toHaveLength(1);
    expect(Math.abs(wakes[0] - (reset * 1000 + 2 * MINUTE))).toBeLessThan(100);
    expect(status(base.state).workers[0]).toMatchObject({ reason: "limit 2 of 2" });
  });

  test("a pool into its reserve starts nothing until its 5-hour window resets", async () => {
    const base = setup(["a"]);
    agents({ claude: OK });
    base.pick("a");
    writeSettings(base.state, { ...readSettings(base.state), reserves: { claude: 5 } });
    const resets = Date.now() + 3_600_000;
    const wakes: number[] = [];
    const [job] = await work({
      ...options(base),
      usage: async () => ({ used: 96, resets }),
      sleep: async (ms) => void wakes.push(Date.now() + ms),
    });
    expect(wakes).toHaveLength(1);
    expect(Math.abs(wakes[0] - (resets + 2 * MINUTE))).toBeLessThan(100);
    expect(job.state).toBe("done");
    expect(status(base.state).pools).toEqual([{ name: "claude", limits: 0, used: 96 }]);
  });

  test("a pool below its reserve works on, and a failed usage read holds nothing", async () => {
    const base = setup(["a", "b"]);
    agents({ claude: OK });
    base.pick("a");
    base.pick("b");
    writeSettings(base.state, { ...readSettings(base.state), reserves: { claude: 5 } });
    const wakes: number[] = [];
    const jobs = await work({
      ...options(base),
      usage: async () => {
        throw new Error("401");
      },
      sleep: async (ms) => void wakes.push(ms),
    });
    expect(jobs.map((job) => job.state)).toEqual(["done", "done"]);
    expect(wakes).toHaveLength(0);
  });

  test("without a limit it waits for every reset", async () => {
    const base = setup(["a"]);
    const counter = join(scratch, `count-${Date.now()}`);
    agents({
      claude: `echo x >> ${counter}; [ $(wc -l < ${counter}) -gt 3 ] && { ${RESULT}; exit 0; }; echo 'Claude AI usage limit reached|1794801600'; exit 1`,
    });
    base.pick("a");
    const wakes: number[] = [];
    const [job] = await work({
      ...options(base),
      limit: null,
      sleep: async (ms) => void wakes.push(ms),
    });
    expect(job.attempts).toMatchObject([{ outcome: "done", turns: 4 }]);
    expect(wakes).toHaveLength(3);
  });

  test("three quick failures in a row stop the agent", async () => {
    const base = setup(["a", "b", "c"]);
    agents({ claude: "echo 'Not logged in'; exit 1" });
    for (const id of ["a", "b", "c"]) base.pick(id);
    const jobs = await work(options(base), () => false);
    expect(jobs.map((job) => job.attempts.length)).toEqual([2, 1, 0]);
    expect(status(base.state).workers[0].reason).toMatch(/^3 failures in a row/);
  });

  test("a repo that can't be set up fails the job with the reason in its log", async () => {
    const base = setup(["a", "b", "c"]);
    agents({ claude: OK });
    sh(base.repo, "git", "remote", "set-url", "origin", join(scratch, "gone"));
    for (const id of ["a", "b", "c"]) base.pick(id);
    const jobs = await work(options(base), () => false);
    expect(jobs.map((job) => job.attempts.length)).toEqual([2, 1, 0]);
    const attempt = jobs[0].attempts[0];
    expect(readFileSync(attempt.log, "utf8")).toBe(`${attempt.error}\n`);
  });

  test("kills an agent that runs past the timeout, children included", async () => {
    const base = setup(["a"]);
    const marker = join(scratch, `survived-${Date.now()}`);
    agents({ claude: `(sleep 1; touch ${marker}) & sleep 30` });
    base.pick("a");
    const [job] = await work({ ...options(base), idleMs: 300 });
    expect(job.attempts.map((attempt) => attempt.outcome)).toEqual(["timeout", "timeout"]);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(() => readFileSync(marker)).toThrow();
  });

  test("turning it off leaves the agent working, and the next run records what it did", async () => {
    const base = setup(["a"]);
    const started = join(scratch, `started-${Date.now()}`);
    agents({ claude: `touch ${started}; sleep 1; echo x > left.txt; ${OK}` });
    base.pick("a");
    const [running] = await work(options(base), () => existsSync(started));
    expect(running).toMatchObject({ state: "running", attempts: [] });
    const [job] = await work(options(base));
    expect(job.attempts).toMatchObject([
      { outcome: "done", url: "https://github.com/o/r/pull/7", branch: `factory/${job.id}-1` },
    ]);
  });

  test("turning it off with kill stops the agent and puts its job back, its work kept", async () => {
    const base = setup(["a"]);
    const started = join(scratch, `started-${Date.now()}`);
    agents({ claude: `echo x > left.txt; touch ${started}; sleep 30` });
    base.pick("a");
    const [job] = await work(options(base), () => existsSync(started), "kill");
    expect(job).toMatchObject({
      state: "queued",
      agent: "claude",
      attempts: [{ outcome: "stopped", branch: `factory/${job.id}-1` }],
    });
  });
});

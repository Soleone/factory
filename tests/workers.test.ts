import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { readJobs, record } from "../src/backend/jobs.ts";
import { makeSlots, piSettingsWarnings } from "../src/backend/loop.ts";
import { checkSettings, readSettings } from "../src/backend/state.ts";
import {
  scratch,
  sh,
  agents,
  setup,
  options,
  work,
  status,
  RESULT,
  report,
  tiered,
} from "./harness.ts";

describe("the factory", () => {
  test("a tier runs on the first preset in its list whose pool isn't limited", async () => {
    const base = setup(["a", "b"]);
    agents({
      pi: "echo 'You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.'; exit 1",
      claude: `echo "args: $*"; ${RESULT}`,
    });
    tiered(base.state, {
      presets: [
        { agent: "pi", model: "openai-codex/luna", id: "luna" },
        { agent: "claude", model: "haiku", id: "haiku" },
      ],
      tiers: { communicator: [], builder: [], grunt: ["luna", "haiku"] },
    });
    const first = base.pick("a", { tier: "grunt" });
    base.pick("b", { tier: "grunt" });
    const jobs = await work({ ...options(base, {}), limit: 1 }, (jobs) => jobs[1].state === "done");
    expect(jobs[0]).toMatchObject({ id: first.id, state: "queued", open: true });
    expect(jobs[1].attempts).toMatchObject([{ outcome: "done", agent: "claude", preset: "haiku" }]);
    expect(readFileSync(jobs[1].attempts[0].log, "utf8")).toContain(
      "--autocompact 90000 --model haiku",
    );
    expect(status(base.state).pools).toMatchObject([
      { name: "openai-codex", limits: 1, stopped: "limit 1 of 1" },
      { name: "claude", limits: 0 },
    ]);
  });

  test("a preset's workers run jobs side by side in worktrees of their own; overlapping touches wait", async () => {
    const base = setup(["a", "b", "c"]);
    const times = mkdtempSync(join(scratch, "times-"));
    agents({
      claude: `echo "start $(date +%s%N) $(pwd)" >> ${times}/$FACTORY_JOB; sleep 0.4; echo "end $(date +%s%N)" >> ${times}/$FACTORY_JOB; ${RESULT}`,
    });
    tiered(base.state, {
      presets: [{ agent: "claude", id: "c", workers: 2 }],
      tiers: { communicator: [], builder: ["c"], grunt: [] },
    });
    const a = base.pick("a", { tier: "builder", touches: ["src/a/**"] });
    const b = base.pick("b", { tier: "builder", touches: ["docs/**"] });
    const c = base.pick("c", { tier: "builder", touches: ["src/**"] });
    const jobs = await work(options(base, {}));
    expect(jobs.map((job) => job.state)).toEqual(["done", "done", "done"]);
    const read = (id: string) => {
      const [start, end] = readFileSync(join(times, id), "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(" "));
      return { start: Number(start[1]), end: Number(end[1]), dir: start[2] };
    };
    const [ta, tb, tc] = [read(a.id), read(b.id), read(c.id)];
    expect(tb.start).toBeLessThan(ta.end);
    expect(ta.dir).not.toBe(tb.dir);
    expect(tc.start).toBeGreaterThan(ta.end);
    expect(sh(base.repo, "git", "worktree", "list").trim().split("\n")).toHaveLength(3);
  });

  test("untiered jobs go to the first free worker in settings order, tiers' presets included", async () => {
    const base = setup(["a"]);
    agents({ pi: RESULT, claude: RESULT });
    tiered(base.state, {
      presets: [
        { agent: "pi", model: "openai-codex/luna", id: "luna" },
        { agent: "claude", id: "c" },
      ],
      tiers: { communicator: [], builder: [], grunt: ["luna"] },
    });
    base.pick("a");
    const [job] = await work(options(base, {}));
    expect(job.attempts).toMatchObject([{ outcome: "done", preset: "luna" }]);
  });

  test("a pin on a worker this run doesn't have runs on a free worker of its agent, with its tuning", async () => {
    const base = setup(["a"]);
    agents({ claude: `echo "args: $*"; ${RESULT}` });
    tiered(base.state, {
      presets: [
        { agent: "claude", id: "c" },
        { agent: "claude", model: "opus", effort: "high", id: "big", workers: 0 },
      ],
    });
    base.pick("a", { preset: "big", agent: "claude", model: "opus", effort: "high" });
    const [job] = await work(options(base, {}));
    expect(job.attempts).toMatchObject([{ outcome: "done", preset: "c", model: "opus" }]);
  });

  test("a pinned-only worker takes the jobs pinned to it and leaves the queue's and its role's", async () => {
    const base = setup(["a", "b", "c"]);
    agents({ claude: RESULT });
    tiered(base.state, {
      presets: [
        { agent: "claude", model: "haiku", id: "haiku", pinnedOnly: true },
        { agent: "claude", id: "c" },
      ],
      tiers: { communicator: [], builder: [], grunt: ["haiku", "c"] },
    });
    base.pick("a");
    base.pick("b", { tier: "grunt" });
    base.pick("c", { preset: "haiku", agent: "claude", model: "haiku" });
    const jobs = await work(options(base, {}));
    expect(jobs.map((job) => job.attempts[0].preset)).toEqual(["c", "c", "haiku"]);
  });

  test("agents and gates get the repo's env, with {worktree} filled in", async () => {
    const base = setup(["a"]);
    agents({ claude: `echo "target=$CARGO_TARGET_DIR"; ${RESULT}` });
    tiered(base.state, { env: { [base.repo]: { CARGO_TARGET_DIR: "{worktree}/target" } } });
    base.pick("a", { gates: ['test "$CARGO_TARGET_DIR" = "$(pwd)/target"'] });
    const [job] = await work(options(base));
    expect(job.state).toBe("done");
    expect(readFileSync(job.attempts[0].log, "utf8")).toMatch(/target=.*worktrees\/\w+\/1\/target/);
  });

  test("needs no worker has: the agent is told, and the job waits for the user to verify", async () => {
    const base = setup(["a"]);
    agents({
      claude: `case "$prompt" in *"needs gpu"*) ;; *) exit 1 ;; esac; ${report(base.state, { kind: "result", text: "did it", unverified: ["shader output"] })}`,
    });
    tiered(base.state, { capabilities: ["display"] });
    const job = base.pick("a", { needs: ["display", "gpu"] });
    const [done] = await work(options(base));
    expect(done).toMatchObject({ state: "done", unverified: ["shader output", "gpu"] });
    record(base.state, { type: "verify", id: job.id, need: "gpu" });
    expect(readJobs(base.state)[0].unverified).toEqual(["shader output"]);
    record(base.state, { type: "verify", id: job.id });
    expect(readJobs(base.state)[0].unverified).toEqual([]);
  });

  test("pi's compaction threshold: a warning with the settings to add when they don't match", () => {
    const dir = mkdtempSync(join(scratch, "pi-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const presets = [
        { agent: "pi", model: "openai-codex/sol" },
        { agent: "pi", model: "x/luna", compactAt: 150_000 },
      ];
      const windows = { "openai-codex/sol": 1_000_000, "x/luna": 400_000 };
      const [first, second] = piSettingsWarnings(presets, windows);
      expect(first).toContain(
        '{"compaction":{"modelOverrides":{"openai-codex/sol":{"reserveTokens":800000}}}}',
      );
      expect(second).toContain('"reserveTokens":250000');
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({
          compaction: { modelOverrides: { "openai-codex/sol": { reserveTokens: 800_000 } } },
        }),
      );
      expect(piSettingsWarnings(presets, windows)).toHaveLength(1);
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });

  test("workers: each preset's, one by default, with the run's counts over the settings'", () => {
    const settings = {
      ...readSettings(mkdtempSync(join(scratch, "state-"))),
      presets: [
        { agent: "pi", model: "p/a", id: "a" },
        { agent: "pi", model: "p/b", id: "b", workers: 0 },
        { agent: "claude", model: "haiku", id: "h", workers: 2 },
      ],
    };
    expect(makeSlots(settings).map((slot) => [slot.worker.id, slot.worker.pool])).toEqual([
      ["a#1", "p"],
      ["h#1", "claude"],
      ["h#2", "claude"],
    ]);
    expect(makeSlots(settings, { a: 0, b: 1 }).map((slot) => slot.worker.id)).toEqual([
      "b#1",
      "h#1",
      "h#2",
    ]);
  });

  test("old settings: the run agents become the first workers, merged into a preset with their tuning", () => {
    const settings = checkSettings({
      agents: { claude: { model: "opus" }, pi: {} },
      presets: [
        { agent: "pi", model: "p/luna", id: "luna" },
        { agent: "claude", model: "opus" },
        { agent: "claude", model: "haiku" },
      ],
      tiers: { communicator: [], builder: [], grunt: ["luna"] },
    });
    expect(settings.presets).toEqual([
      { agent: "claude", model: "opus", workers: 1 },
      { agent: "pi", workers: 1 },
      { agent: "pi", model: "p/luna", id: "luna", workers: 1 },
      { agent: "claude", model: "haiku", workers: 0 },
    ]);
  });
});

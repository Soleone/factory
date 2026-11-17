import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "vite-plus/test";
import { agent, classify, resetTime } from "../src/backend/agents.ts";
import {
  addJobs,
  autoPicks,
  moveJob,
  order,
  readJobs,
  removeJob,
  retryJob,
} from "../src/backend/jobs.ts";
import { run, type RunOptions } from "../src/backend/loop.ts";
import { readSettings, writeSettings } from "../src/backend/state.ts";
import type { Item, Job, Snapshot, Status } from "../src/backend/types.ts";
import { serve } from "../src/backend/web.ts";

const scratch = mkdtempSync(join(tmpdir(), "factory-test-"));
const NOW = Date.parse("2026-11-16T04:00:00Z");
const MINUTE = 60_000;

beforeAll(() => {
  // Isolate git from the user's config (hooks, signing).
  const gitconfig = join(scratch, "gitconfig");
  writeFileSync(
    gitconfig,
    "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n",
  );
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

describe("limit messages", () => {
  test("reset times in every format the agents print", () => {
    expect(resetTime("Claude AI usage limit reached|1794801600", NOW)).toBe(1794801600_000);
    expect(resetTime("You've hit your session limit · resets 3pm (Europe/Berlin)", NOW)).toBe(
      Date.parse("2026-11-16T14:00:00Z"),
    );
    expect(
      resetTime("You've hit your weekly limit · resets Nov 20, 5pm (Europe/Berlin)", NOW),
    ).toBe(Date.parse("2026-11-20T16:00:00Z"));
    expect(resetTime("You've hit your limit · resets 3:30pm (America/New_York)", NOW)).toBe(
      Date.parse("2026-11-16T20:30:00Z"),
    );
    // Already past today in that zone, so tomorrow.
    expect(resetTime("You've hit your session limit · resets 3am (UTC)", NOW)).toBe(
      Date.parse("2026-11-17T03:00:00Z"),
    );
    const local = new Date(NOW);
    local.setHours(3, 0, 0, 0);
    if (local.getTime() <= NOW) local.setDate(local.getDate() + 1);
    expect(resetTime("5-hour limit reached ∙ resets 3am", NOW)).toBe(local.getTime());
    expect(
      resetTime("You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.", NOW),
    ).toBe(NOW + 42 * MINUTE);
    expect(resetTime("You've hit your usage limit. Try again in 5 minutes.", NOW)).toBe(
      NOW + 5 * MINUTE,
    );
    expect(
      resetTime('{"error":{"type":"usage_limit_reached","resets_in_seconds":3600}}', NOW),
    ).toBe(NOW + 3600_000);
    expect(resetTime('{"type":"usage_limit_reached","resets_at": 1794801600}', NOW)).toBe(
      1794801600_000,
    );
  });

  test("no reset time when the message has none or names an unknown zone", () => {
    expect(resetTime("You've hit your monthly spend limit.", NOW)).toBeUndefined();
    expect(resetTime("You've hit your limit · resets 3pm (Mars/Olympus)", NOW)).toBeUndefined();
  });

  test("classify reads the exit code and the end of the log", () => {
    const claude = agent("claude");
    const pi = agent("pi");
    const result = (isError: boolean, text: string) =>
      JSON.stringify({ type: "result", is_error: isError, result: text });
    expect(classify(claude, 0, result(false, "Opened a PR"))).toBe("done");
    expect(
      classify(
        claude,
        1,
        result(true, "You've hit your session limit · resets 3pm (Europe/Berlin)"),
      ),
    ).toBe("limited");
    expect(classify(claude, 0, result(true, "API Error: 500"))).toBe("failed");
    expect(classify(claude, 1, "Claude AI usage limit reached|1794801600")).toBe("limited");
    expect(
      classify(
        pi,
        1,
        "Error: You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.",
      ),
    ).toBe("limited");
    expect(classify(pi, 1, '{"code":"usage_limit_reached"}')).toBe("limited");
    expect(classify(pi, 1, "Error: ENOENT")).toBe("failed");
    // A limit the agent read about early in a successful run isn't one.
    expect(classify(pi, 0, `docs: usage limit reached\n${"work\n".repeat(3000)}done`)).toBe("done");
  });
});

const item = (repo: string, id: string, level = "skim", play = "fake"): Item => ({
  repo,
  label: repo,
  id,
  play,
  level,
  title: `fix ${id}`,
});

describe("queue", () => {
  test("cheapest attention first, taking turns between repos, only the wanted levels", () => {
    const items = [
      item("a", "a1"),
      item("a", "a2"),
      item("a", "a3"),
      item("b", "b1"),
      item("a", "a4", "auto"),
      item("b", "b2", "decide"),
      item("c", "c1"),
    ];
    expect(order(items, ["auto", "skim", "decide"]).map((item) => item.id)).toEqual([
      "a4",
      "a1",
      "b1",
      "c1",
      "a2",
      "a3",
      "b2",
    ]);
    expect(order(items, ["auto"]).map((item) => item.id)).toEqual(["a4"]);
  });

  test("auto mode takes only the chosen repos and plays, none chosen meaning all", () => {
    const items = [item("a", "a1"), item("b", "b1", "skim", "simplify"), item("c", "c1")];
    const ids = (auto: { plays: string[]; repos: string[] }) =>
      autoPicks(items, [], { levels: ["skim"], ...auto }, 5).map((item) => item.id);
    expect(ids({ plays: [], repos: [] })).toEqual(["a1", "b1", "c1"]);
    expect(ids({ plays: [], repos: ["a", "b"] })).toEqual(["a1", "b1"]);
    expect(ids({ plays: ["simplify"], repos: ["a", "b"] })).toEqual(["b1"]);
  });

  test("picks come before auto jobs, in the order the user gives them", async () => {
    const state = mkdtempSync(join(scratch, "state-"));
    addJobs(state, [item("r", "auto1")], "auto");
    const [a, b, c] = addJobs(state, [item("r", "a"), item("r", "b"), item("r", "c")], "pick");
    moveJob(state, c.id, 0);
    await removeJob(state, b.id);
    const ids = (jobs: Job[]) =>
      jobs.filter((job) => job.state === "queued").map((job) => job.item.id);
    expect(ids(readJobs(state))).toEqual(["c", "a", "auto1"]);
    moveJob(state, c.id, 1);
    expect(ids(readJobs(state))).toEqual(["a", "c", "auto1"]);
    await expect(removeJob(state, b.id)).rejects.toThrow("is removed");
    expect(() => retryJob(state, a.id)).toThrow("is queued");
  });
});

describe("the factory", () => {
  const path = process.env.PATH;
  afterEach(() => {
    process.env.PATH = path;
  });

  function sh(cwd: string, command: string, ...args: string[]): string {
    return execFileSync(command, args, { cwd, encoding: "utf8" });
  }

  function script(dir: string, name: string, body: string): void {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }

  /** Fake claude and pi on PATH; each reads its prompt and runs its body. */
  function agents(bodies: { claude?: string; pi?: string }): void {
    const bin = mkdtempSync(join(scratch, "bin-"));
    for (const [name, body] of Object.entries(bodies)) script(bin, name, `cat >/dev/null\n${body}`);
    process.env.PATH = `${bin}:${process.env.PATH}`;
  }

  /** A fake gh on PATH: `pr list` and `pr view` print list.json and view.json from its folder; every call is logged to calls. */
  function gh(view: Record<string, unknown> = {}, list: { url: string }[] = []) {
    const bin = mkdtempSync(join(scratch, "gh-"));
    writeFileSync(join(bin, "list.json"), JSON.stringify(list));
    const answer = (view: Record<string, unknown>) =>
      writeFileSync(join(bin, "view.json"), JSON.stringify({ ...OPEN_PR, ...view }));
    answer(view);
    script(
      bin,
      "gh",
      `echo "$*" >> ${bin}/calls\ncase "$1 $2" in\n"pr list") cat ${bin}/list.json ;;\n"pr view") cat ${bin}/view.json ;;\nesac`,
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;
    return { calls: () => readFileSync(join(bin, "calls"), "utf8"), answer };
  }

  /** A clone with a remote, and a fake workwork offering the given ids in it. */
  function setup(ids: string[]) {
    gh();
    const origin = mkdtempSync(join(scratch, "origin-"));
    sh(origin, "git", "init", "-q", "--bare");
    const repo = mkdtempSync(join(scratch, "repo-"));
    sh(repo, "git", "clone", "-q", origin, ".");
    sh(repo, "git", "commit", "-q", "--allow-empty", "-m", "start");
    sh(repo, "git", "push", "-q", "origin", "main");
    const items = ids.map((id) => ({ ...item(repo, id), label: "repo" }));
    const bin = mkdtempSync(join(scratch, "bin-"));
    script(
      bin,
      "workwork",
      `if [ "$1" = prompt ]; then echo "do $2"; else echo '${JSON.stringify(items)}'; fi`,
    );
    const state = mkdtempSync(join(scratch, "state-"));
    const pick = (id: string, pin = {}) =>
      addJobs(state, [items.find((item) => item.id === id)!], "pick", pin)[0];
    return { repo, state, workwork: join(bin, "workwork"), items, pick };
  }

  const options = (
    base: { state: string; workwork: string },
    agents: RunOptions["agents"] = { claude: {} },
  ): RunOptions => ({ ...base, agents, limit: 2, timeoutMs: 60_000, pollMs: 20 });

  const busy = (jobs: Job[]) =>
    jobs.some((job) => job.state === "queued" || job.state === "running");

  /** Runs the factory until it turns itself off or `done` holds, then turns it off. */
  async function work(options: RunOptions, done = (jobs: Job[]) => !busy(jobs)): Promise<Job[]> {
    const controller = new AbortController();
    let finished = false;
    const running = run({ ...options, signal: controller.signal }).finally(() => (finished = true));
    while (!finished) {
      if (done(readJobs(options.state))) controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await running;
    return readJobs(options.state);
  }

  const status = (state: string): Status =>
    JSON.parse(readFileSync(join(state, "status.json"), "utf8"));
  const OK = "echo 'opened https://github.com/o/r/pull/7'";
  const OPEN_PR = {
    state: "OPEN",
    isDraft: false,
    title: "fix: a",
    body: "## Summary\nMakes a simpler.\n\n## Changes\nNone\n\nLevel: skim\nPlay: simplify",
    additions: 3,
    deletions: 9,
    files: [{ path: "a.ts" }],
    mergeable: "MERGEABLE",
    statusCheckRollup: [{ conclusion: "SUCCESS" }, { state: "SUCCESS" }],
  };

  test("does picks before auto jobs, links the PR and reuses one worktree per agent and repo", async () => {
    const base = setup(["a", "b", "c"]);
    agents({ claude: OK });
    base.pick("b");
    writeSettings(base.state, {
      ...readSettings(base.state),
      auto: { on: true, levels: ["skim"], plays: [], repos: [] },
    });
    const jobs = await work(
      options(base),
      (jobs) => jobs.filter((job) => job.state === "done").length === 3,
    );
    const attempts = jobs
      .flatMap((job) => job.attempts.map((attempt) => ({ id: job.item.id, ...attempt })))
      .sort((a, b) => a.start.localeCompare(b.start));
    expect(attempts.map((attempt) => [attempt.id, attempt.outcome, attempt.url])).toEqual([
      ["b", "done", "https://github.com/o/r/pull/7"],
      ["a", "done", "https://github.com/o/r/pull/7"],
      ["c", "done", "https://github.com/o/r/pull/7"],
    ]);
    expect(jobs.map((job) => job.source)).toEqual(["pick", "auto", "auto"]);
    expect(readFileSync(join(attempts[0].log, "..", "prompt.md"), "utf8")).toBe("do b\n");
    expect(sh(base.repo, "git", "worktree", "list").trim().split("\n")).toHaveLength(2);
  });

  test("keeps work an agent left unpushed on a branch and starts the next job clean", async () => {
    const base = setup(["a", "b"]);
    agents({ claude: "test -e left.txt && exit 1; echo x > left.txt" });
    const a = base.pick("a");
    const b = base.pick("b");
    const [first, second] = await work(options(base));
    expect([first.state, second.state]).toEqual(["done", "done"]);
    expect(first.attempts[0].branch).toBe(`factory/${a.id}-1`);
    expect(
      sh(base.repo, "git", "show", "--name-only", "--format=", first.attempts[0].branch!),
    ).toBe("left.txt\n");
    await removeJob(base.state, a.id);
    // b's stays, and the next checkout didn't save a's work a second time.
    expect(sh(base.repo, "git", "branch", "--list", "factory/*")).toBe(`  factory/${b.id}-1\n`);
  });

  test("links the PR GitHub has on workwork's branch over the log's last link", async () => {
    const base = setup(["a"]);
    const github = gh({}, [{ url: "https://github.com/o/r/pull/8" }]);
    agents({ claude: OK });
    base.pick("a");
    const [job] = await work(options(base));
    expect(job.attempts[0].url).toBe("https://github.com/o/r/pull/8");
    expect(github.calls()).toContain("pr list --head workwork/a --state all");
  });

  test("a job keeps its agent: one retry after a failure, then only by hand", async () => {
    const base = setup(["a"]);
    agents({ claude: "echo broken; exit 1", pi: OK });
    const job = base.pick("a");
    const [failed] = await work(options(base, { claude: {}, pi: {} }));
    expect(failed.attempts.map((attempt) => [attempt.agent, attempt.outcome])).toEqual([
      ["claude", "failed"],
      ["claude", "failed"],
    ]);
    expect(failed.state).toBe("failed");
    retryJob(base.state, job.id);
    agents({ claude: OK, pi: OK });
    const [done] = await work(options(base, { claude: {}, pi: {} }));
    expect(done.attempts.map((attempt) => attempt.agent)).toEqual(["claude", "claude", "claude"]);
    expect(done.state).toBe("done");
  });

  test("a job for an agent outside the run waits for it", async () => {
    const base = setup(["a", "b"]);
    agents({ claude: OK });
    base.pick("a", { agent: "pi" });
    base.pick("b");
    const jobs = await work(options(base), (jobs) => jobs[1].state === "done");
    expect(jobs.map((job) => job.state)).toEqual(["queued", "done"]);
  });

  test("the run's model and effort per agent, unless the job has its own", async () => {
    const base = setup(["a"]);
    agents({ claude: 'echo "args: $*"' });
    base.pick("a", { effort: "low" });
    const [job] = await work(options(base, { claude: { model: "opus", effort: "high" } }));
    expect(job.attempts[0]).toMatchObject({ model: "opus", effort: "low", outcome: "done" });
    expect(readFileSync(job.attempts[0].log, "utf8")).toContain("--model opus --effort low");
  });

  test("limit 1: an agent stops at its first limit hit and the factory turns off with no agent left", async () => {
    const base = setup(["a"]);
    agents({ claude: "echo 'Claude AI usage limit reached|1794801600'; exit 1" });
    base.pick("a");
    const wakes: number[] = [];
    const [job] = await work(
      { ...options(base), limit: 1, sleep: async (ms) => void wakes.push(ms) },
      () => false,
    );
    expect(job.state).toBe("queued");
    expect(job.agent).toBe("claude");
    expect(job.attempts.map((attempt) => attempt.outcome)).toEqual(["limited"]);
    expect(wakes).toHaveLength(0);
    expect(status(base.state).workers[0]).toMatchObject({
      state: "stopped",
      reason: "limit 1 of 1",
    });
  });

  test("sleeps until the parsed reset, keeps the job, and stops at its limit", async () => {
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
    expect(jobs[0].attempts.map((attempt) => attempt.outcome)).toEqual(["limited", "limited"]);
    expect(jobs[1].attempts).toEqual([]);
    expect(wakes).toHaveLength(1);
    expect(Math.abs(wakes[0] - (reset * 1000 + 2 * MINUTE))).toBeLessThan(100);
    expect(status(base.state).workers[0]).toMatchObject({ reason: "limit 2 of 2" });
  });

  test("without a limit it waits for every reset", async () => {
    const base = setup(["a"]);
    const counter = join(scratch, `count-${Date.now()}`);
    agents({
      claude: `echo x >> ${counter}; [ $(wc -l < ${counter}) -gt 3 ] && exit 0; echo 'Claude AI usage limit reached|1794801600'; exit 1`,
    });
    base.pick("a");
    const wakes: number[] = [];
    const [job] = await work({
      ...options(base),
      limit: null,
      sleep: async (ms) => void wakes.push(ms),
    });
    expect(job.attempts.map((attempt) => attempt.outcome)).toEqual([
      "limited",
      "limited",
      "limited",
      "done",
    ]);
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
    agents({ claude: `(sleep 2; touch ${marker}) & sleep 30` });
    base.pick("a");
    const [job] = await work({ ...options(base), timeoutMs: 300 });
    expect(job.attempts.map((attempt) => attempt.outcome)).toEqual(["timeout", "timeout"]);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(() => readFileSync(marker)).toThrow();
  });

  test("turning it off puts the job in progress back, with its agent", async () => {
    const base = setup(["a"]);
    agents({ claude: "sleep 30" });
    base.pick("a");
    const [job] = await work(options(base), (jobs) => jobs[0].state === "running");
    expect(job).toMatchObject({ state: "queued", agent: "claude", attempts: [] });
  });

  test("serve queues cached candidates and shows the results and their logs, nothing outside runs/", async () => {
    const base = setup(["a"]);
    agents({ claude: OK });
    writeFileSync(
      join(base.state, "candidates.json"),
      JSON.stringify({ at: new Date().toISOString(), items: base.items }),
    );
    const server = serve(base.state, 0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const url = (path: string) => `http://127.0.0.1:${port}${path}`;
    try {
      const post = (path: string, body: unknown) =>
        fetch(url(path), { method: "POST", body: JSON.stringify(body) });
      expect((await post("/api/jobs", { items: [{ repo: base.repo, id: "nope" }] })).status).toBe(
        400,
      );
      await post("/api/jobs", { items: [{ repo: base.repo, id: "a" }] });
      await work(options(base));
      const { jobs } = (await (await fetch(url("/api/state"))).json()) as { jobs: Job[] };
      expect(jobs.map((job) => [job.item.id, job.state])).toEqual([["a", "done"]]);
      expect(await (await fetch(url(`/${jobs[0].attempts[0].log}`))).text()).toContain("pull/7");
      expect(await (await fetch(url("/runs/%2E%2E/jobs.jsonl"))).text()).not.toContain('"add"');
    } finally {
      server.close();
    }
  });

  test("serve shows each job's PR and merges it only once GitHub says it's ready", async () => {
    const base = setup(["a"]);
    const github = gh({ statusCheckRollup: [{ conclusion: "" }] });
    agents({ claude: OK });
    const job = base.pick("a");
    await work(options(base));
    const server = serve(base.state, 0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const url = (path: string) => `http://127.0.0.1:${port}${path}`;
    const pr = "https://github.com/o/r/pull/7";
    try {
      let prs: Snapshot["prs"] = {};
      // The first poll starts asking gh; a later one has the answer.
      while (!prs[pr]) {
        prs = ((await (await fetch(url("/api/state"))).json()) as Snapshot).prs;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(prs[pr]).toMatchObject({
        summary: "Makes a simpler.",
        level: "skim",
        checks: "pending",
        files: ["a.ts"],
        conflicts: false,
      });
      const merge = () => fetch(url(`/api/jobs/${job.id}/merge`), { method: "POST" });
      expect(await (await merge()).json()).toEqual({
        error: `${pr} isn't ready to merge: see it on GitHub`,
      });
      github.answer({});
      expect((await merge()).status).toBe(200);
      expect(github.calls()).toContain(`pr merge ${pr} --squash --delete-branch`);
    } finally {
      server.close();
    }
  });
});

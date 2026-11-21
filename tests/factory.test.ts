import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "vite-plus/test";
import { agent, classify, resetTime } from "../src/backend/agents.ts";
import {
  addJobs,
  addNote,
  answer,
  autoPicks,
  endJob,
  moveJob,
  nextJob,
  queueFollowup,
  queueReview,
  order,
  readJobs,
  record,
  removeJob,
  retryJob,
  startJob,
} from "../src/backend/jobs.ts";
import {
  approveGoal,
  importPlan,
  importPlanText,
  newGoal,
  type Plan,
} from "../src/backend/goals.ts";
import { stringify as toYaml } from "yaml";
import { makeSlots, piSettingsWarnings, run, type RunOptions } from "../src/backend/loop.ts";
import { agentModels } from "../src/backend/models.ts";
import { readSettings, writeSettings } from "../src/backend/state.ts";
import {
  onTrain,
  type Item,
  type Job,
  type Settings,
  type Snapshot,
  type Status,
  type TrainCar,
} from "../src/backend/types.ts";
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

describe("jobs that wait on others", () => {
  test("a job waits for the one it comes after; the same play is queued once", () => {
    const state = mkdtempSync(join(scratch, "state-"));
    const [fix] = addJobs(state, [item("r", "a")], "pick", { agent: "claude" });
    expect(addJobs(state, [item("r", "a")], "pick")).toEqual([]);
    expect(() => queueReview(state, fix.id, "claude")).toThrow("claude's own");
    const review = queueReview(state, fix.id, "pi")!;
    expect(review).toMatchObject({
      after: [fix.id],
      agent: "pi",
      item: { id: "a", play: "review" },
    });
    expect(review.prompt).toContain("gh pr diff workwork/a");
    expect(queueReview(state, fix.id, "pi")).toBeUndefined();
    expect(nextJob(readJobs(state), "pi")).toBeUndefined();
    startJob(state, fix.id, "claude");
    endJob(state, fix.id, {
      run: "r",
      agent: "claude",
      start: "",
      end: "",
      outcome: "done",
      log: "",
    });
    expect(nextJob(readJobs(state), "pi")?.id).toBe(review.id);
  });

  test("a job waiting on one that failed is held, and goes on after a retry", () => {
    const state = mkdtempSync(join(scratch, "state-"));
    const [fix] = addJobs(state, [item("r", "a")], "pick", { agent: "claude" });
    const review = queueReview(state, fix.id, "pi")!;
    addJobs(state, [item("r", "b")], "pick", { after: [review.id] });
    for (let i = 0; i < 2; i++) {
      startJob(state, fix.id, "claude");
      endJob(state, fix.id, {
        run: "r",
        agent: "claude",
        start: "",
        end: "",
        outcome: "failed",
        log: "",
      });
    }
    const states = () => readJobs(state).map((job) => job.state);
    expect(states()).toEqual(["failed", "blocked", "blocked"]);
    expect(readJobs(state).map((job) => job.blocked)).toEqual([undefined, "held", "held"]);
    retryJob(state, fix.id);
    expect(states()).toEqual(["queued", "queued", "queued"]);
  });

  test("a follow-up an agent reported becomes its own job, once", () => {
    const state = mkdtempSync(join(scratch, "state-"));
    const [job] = addJobs(state, [item("r", "a")], "pick");
    startJob(state, job.id, "claude");
    addNote(state, job.id, { kind: "result", text: "done", followups: ["also b"] });
    expect(() => queueFollowup(state, job.id, "not reported")).toThrow("no follow-up");
    const followup = queueFollowup(state, job.id, "also b")!;
    expect(followup.item).toMatchObject({ id: "a+followup", play: "followup", title: "also b" });
    expect(followup.prompt).toMatch(/^also b\n/);
    expect(queueFollowup(state, job.id, "also b")).toBeUndefined();
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

  /** Fake claude and pi on PATH; each reads its prompt into $prompt and runs its body. */
  function agents(bodies: { claude?: string; pi?: string }): void {
    const bin = mkdtempSync(join(scratch, "bin-"));
    for (const [name, body] of Object.entries(bodies)) script(bin, name, `prompt=$(cat)\n${body}`);
    process.env.PATH = `${bin}:${process.env.PATH}`;
  }

  /** A fake gh on PATH: `pr list` and `pr view` print list.json and view.json from its folder; every call is logged to calls. */
  function gh(view: Record<string, unknown> = {}, list: { url: string }[] = []) {
    const bin = mkdtempSync(join(scratch, "gh-"));
    writeFileSync(join(bin, "list.json"), JSON.stringify(list));
    const answer = (view: Record<string, unknown>) =>
      writeFileSync(join(bin, "view.json"), JSON.stringify({ ...OPEN_PR, ...view }));
    const viewPath = join(bin, "view.json");
    answer(view);
    script(
      bin,
      "gh",
      `echo "$*" >> ${bin}/calls\ncase "$1 $2" in\n"pr list") cat ${bin}/list.json ;;\n"pr view") cat ${viewPath} ;;\n"pr diff") echo "+simpler a" ;;\n"pr create") n=$(($(cat ${bin}/n 2>/dev/null || echo 0) + 1)); echo $n > ${bin}/n; echo "https://github.com/o/r/pull/10$n" ;;\n"pr merge") sed 's/"state":"OPEN"/"state":"MERGED"/' ${viewPath} > ${viewPath}.new && mv ${viewPath}.new ${viewPath} ;;\nesac`,
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;
    return { calls: () => readFileSync(join(bin, "calls"), "utf8"), answer, viewPath };
  }

  function repoWithOrigin() {
    const origin = mkdtempSync(join(scratch, "origin-"));
    sh(origin, "git", "init", "-q", "--bare");
    const repo = mkdtempSync(join(scratch, "repo-"));
    sh(repo, "git", "init", "-q");
    sh(repo, "git", "commit", "-q", "--allow-empty", "-m", "start");
    sh(repo, "git", "remote", "add", "origin", origin);
    sh(repo, "git", "push", "-q", "-u", "origin", "main");
    return { repo, origin };
  }

  /** A repo with a remote, and a fake workwork offering the given ids in it. */
  function setup(ids: string[]) {
    gh();
    const { repo } = repoWithOrigin();
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
  ): RunOptions => ({ ...base, agents, limit: 2, idleMs: 60_000, pollMs: 20 });

  const busy = (jobs: Job[]) =>
    jobs.some((job) => job.state === "queued" || job.state === "running");

  /** Runs the factory until it turns itself off or `done` holds, then turns it off. */
  async function work(
    options: RunOptions,
    done = (jobs: Job[]) => !busy(jobs),
    how?: "kill",
  ): Promise<Job[]> {
    const controller = new AbortController();
    let finished = false;
    const running = run({ ...options, signal: controller.signal }).finally(() => (finished = true));
    while (!finished) {
      if (done(readJobs(options.state))) controller.abort(how);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await running;
    return readJobs(options.state);
  }

  const status = (state: string): Status =>
    JSON.parse(readFileSync(join(state, "status.json"), "utf8"));
  /** A shell line reporting a result for the job, from its worktree under state/worktrees/<repo>/<n>. */
  const RESULT = `echo '{"at":"2026-11-16T04:00:00Z","type":"note","id":"'$FACTORY_JOB'","note":{"kind":"result","text":"did it"}}' >> ../../../jobs.jsonl`;
  const OK = `${RESULT}; echo 'opened https://github.com/o/r/pull/7'`;
  const OPEN_PR = {
    state: "OPEN",
    isDraft: false,
    title: "fix: a",
    body: "## Summary\nMakes a simpler.\n\n## Changes\nNone\n\nLevel: skim\nPlay: simplify",
    additions: 3,
    deletions: 9,
    files: [{ path: "a.ts" }],
    mergeable: "MERGEABLE",
    baseRefName: "main",
    headRefName: "workwork/a",
    isCrossRepository: false,
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
    expect(readFileSync(join(attempts[0].log, "..", "prompt.md"), "utf8")).toMatch(
      /^do b\n\n---\n/,
    );
    expect(sh(base.repo, "git", "worktree", "list").trim().split("\n")).toHaveLength(2);
  });

  test("repos with the same label run in their own worktrees", async () => {
    const first = setup(["a"]);
    const second = setup(["b"]);
    agents({ claude: `git remote get-url origin; ${RESULT}` });
    first.pick("a");
    addJobs(first.state, second.items, "pick");

    const jobs = await work(options(first));
    expect(jobs.map((job) => job.state)).toEqual(["done", "done"]);
    for (const job of jobs)
      expect(readFileSync(job.attempts[0].log, "utf8")).toBe(
        sh(job.item.repo, "git", "remote", "get-url", "origin"),
      );
  });

  test("keeps work an agent left unpushed on a branch and starts the next job clean", async () => {
    const base = setup(["a", "b"]);
    agents({ claude: `test -e left.txt && exit 1; echo x > left.txt; ${RESULT}` });
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

  /** A shell line that reports on the job the way `factory note|ask|result` does. */
  const report = (state: string, note: Record<string, unknown>) =>
    `echo '{"at":"2026-11-16T04:00:00Z","type":"note","id":"'$FACTORY_JOB'","note":${JSON.stringify(note)}}' >> ${state}/jobs.jsonl`;

  test("a question pauses the attempt until answered; the same session goes on in the same worktree", async () => {
    const base = setup(["a"]);
    agents({
      claude: `if [ -e half.txt ]; then ${report(base.state, { kind: "result", text: "did A", url: "https://github.com/o/r/pull/9" })}; exit 0; fi
echo x > half.txt
${report(base.state, { kind: "note", text: "B breaks the API" })}
${report(base.state, { kind: "ask", text: "A or B?" })}`,
    });
    const job = base.pick("a");
    const [blocked] = await work(options(base));
    expect(blocked).toMatchObject({ state: "blocked", blocked: "asked", open: true, attempts: [] });
    expect(() => addNote(base.state, job.id, { kind: "note", text: "late" })).toThrow("is blocked");

    answer(base.state, job.id, "A");
    const [done] = await work(options(base));
    expect(done.state).toBe("done");
    expect(done.attempts).toMatchObject([
      { outcome: "done", turns: 2, url: "https://github.com/o/r/pull/9" },
    ]);
    expect(done.notes.map((note) => [note.attempt, note.kind, note.text])).toEqual([
      [1, "note", "B breaks the API"],
      [1, "ask", "A or B?"],
      [1, "answer", "A"],
      [1, "result", "did A"],
    ]);
    const turn = readFileSync(join(dirname(done.attempts[0].log), "turn-2.md"), "utf8");
    expect(turn).toContain("The user answered your question: A");
    expect(readFileSync(done.attempts[0].log, "utf8")).toBe("");
  });

  test("an unfinished exit or a failed gate gets a follow-up in the same session", async () => {
    const base = setup(["a"]);
    const turns = join(mkdtempSync(join(scratch, "turns-")), "n");
    // Turn 1 ends without a result; turn 2 reports one but leaves the gate failing; turn 3 fixes it.
    agents({
      claude: `n=$(($(cat ${turns} 2>/dev/null || echo 0) + 1)); echo $n > ${turns}; echo "args: $*"
[ $n -ge 2 ] && ${RESULT}
[ $n -ge 3 ] && touch fixed; exit 0`,
    });
    base.pick("a", { gates: ["test -e fixed || (echo not fixed; exit 1)"] });
    const [job] = await work(options(base));
    expect(job.state).toBe("done");
    expect(job.attempts).toMatchObject([{ outcome: "done", turns: 3, followups: 2 }]);
    expect(job.notes.filter((note) => note.kind === "factory").map((note) => note.text)).toEqual([
      expect.stringContaining("follow-up 1 of 2: You stopped without finishing"),
      expect.stringContaining("follow-up 2 of 2: The gate `test -e fixed"),
    ]);
    const dir = dirname(job.attempts[0].log);
    expect(readFileSync(join(dir, "turn-3.md"), "utf8")).toContain("not fixed");
    const log = readFileSync(job.attempts[0].log, "utf8");
    const session = /--session-id (\S+)/.exec(log)![1];
    expect(log.match(/--resume (\S+)/g)).toEqual([`--resume ${session}`, `--resume ${session}`]);
    expect(job.attempts[0].session).toBe(session);
  });

  test("follow-ups run out: the attempt fails, and the retry is a fresh session", async () => {
    const base = setup(["a"]);
    agents({ claude: 'echo "args: $*"; exit 1' });
    base.pick("a");
    const [job] = await work(options(base));
    expect(job.state).toBe("failed");
    expect(job.attempts.map((attempt) => [attempt.outcome, attempt.turns])).toEqual([
      ["failed", 3],
      ["failed", 3],
    ]);
    expect(job.attempts[0].session).not.toBe(job.attempts[1].session);
  });

  test("the stream gives the worker's activity, and the attempt its context, compactions and tokens", async () => {
    const base = setup(["a"]);
    const lines = [
      { type: "system", subtype: "init", session_id: "s-1" },
      {
        type: "assistant",
        message: {
          id: "m1",
          content: [{ type: "tool_use", name: "Bash", input: { command: "cargo test" } }],
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 90000,
            cache_creation_input_tokens: 0,
            output_tokens: 50,
          },
        },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 90010 },
      },
      {
        type: "assistant",
        message: {
          id: "m2",
          content: [{ type: "text", text: "all done" }],
          usage: {
            input_tokens: 5,
            cache_read_input_tokens: 20000,
            cache_creation_input_tokens: 0,
            output_tokens: 20,
          },
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "all done",
        session_id: "s-1",
      },
    ];
    const seen = join(mkdtempSync(join(scratch, "seen-")), "status");
    agents({
      claude: `echo '${JSON.stringify(lines[0])}'; echo '${JSON.stringify(lines[1])}'; sleep 0.3; cp ../../../status.json ${seen}
${lines
  .slice(2)
  .map((line) => `echo '${JSON.stringify(line)}'`)
  .join("; ")}; ${RESULT}`,
    });
    base.pick("a");
    const [job] = await work(options(base));
    expect(JSON.parse(readFileSync(seen, "utf8")).workers[0]).toMatchObject({
      activity: "running cargo test",
      context: 90010,
    });
    expect(job.attempts[0]).toMatchObject({
      session: "s-1",
      peak: 90010,
      compactions: 1,
      tokens: { input: 15, cached: 110000, output: 70 },
    });
  });

  test("an agent that goes quiet for the idle time times out; one that keeps talking doesn't", async () => {
    const base = setup(["a", "b"]);
    agents({
      claude: `if [ "$FACTORY_JOB" = "$(cat ../../../quiet)" ]; then sleep 5; fi; for i in 1 2 3 4 5 6; do echo tick; sleep 0.1; done; ${RESULT}`,
    });
    const quiet = base.pick("a");
    writeFileSync(join(base.state, "quiet"), quiet.id);
    base.pick("b");
    const jobs = await work({ ...options(base), idleMs: 400 });
    expect(jobs.map((job) => job.attempts.map((attempt) => attempt.outcome))).toEqual([
      ["timeout", "timeout"],
      ["done"],
    ]);
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
    agents({ claude: `echo "args: $*"; ${RESULT}` });
    base.pick("a", { effort: "low" });
    const [job] = await work(options(base, { claude: { model: "opus", effort: "high" } }));
    expect(job.attempts[0]).toMatchObject({ model: "opus", effort: "low", outcome: "done" });
    expect(readFileSync(job.attempts[0].log, "utf8")).toContain("--model opus --effort low");
  });

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
    agents({ claude: `(sleep 2; touch ${marker}) & sleep 30` });
    base.pick("a");
    const [job] = await work({ ...options(base), idleMs: 300 });
    expect(job.attempts.map((attempt) => attempt.outcome)).toEqual(["timeout", "timeout"]);
    await new Promise((resolve) => setTimeout(resolve, 2500));
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

  /** Settings with presets and tiers, for runs without agent workers. */
  function tiered(state: string, change: Partial<Settings>): void {
    writeSettings(state, { ...readSettings(state), ...change });
  }

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

  test("workers: one per run agent, and each preset's, by default one when a tier lists it", () => {
    const settings = {
      ...readSettings(mkdtempSync(join(scratch, "state-"))),
      presets: [
        { agent: "pi", model: "p/a", id: "a" },
        { agent: "pi", model: "p/b", id: "b" },
        { agent: "claude", model: "haiku", id: "h", workers: 2 },
      ],
      tiers: { communicator: [], builder: ["a"], grunt: [] },
    };
    expect(
      makeSlots({ claude: {} }, settings).map((slot) => [slot.worker.id, slot.worker.pool]),
    ).toEqual([
      ["claude#1", "claude"],
      ["a#1", "p"],
      ["h#1", "claude"],
      ["h#2", "claude"],
    ]);
  });

  /** A goal's plan for the scratch repo: nodes as given, every node delivering a file named after itself. */
  function plan(
    repo: string,
    nodes: Record<string, unknown>[],
    goal: Record<string, unknown> = {},
  ): Plan {
    return {
      format: "factory-plan/1",
      goal: {
        title: "Demo goal",
        repo,
        branch: "goal/demo",
        summary: "Make a demo.",
        gates: [],
        ...goal,
      },
      nodes: nodes.map((node) => ({
        tier: "builder",
        prompt: `Do ${String(node.key)}.`,
        title: String(node.key),
        after: [],
        touches: [],
        gates: [],
        ...node,
      })),
    } as unknown as Plan;
  }

  /** The fake agent of a goal node: commits <key>.txt on its branch and pushes it. */
  const NODE = `b=$(git rev-parse --abbrev-ref HEAD); key=$(basename $b)
echo "$key" > $key.txt; git add $key.txt; git commit -qm "$key"; git push -q origin HEAD:$b; ${RESULT}`;

  function goalRepo() {
    const github = gh();
    const { repo, origin } = repoWithOrigin();
    const state = mkdtempSync(join(scratch, "state-"));
    const files = (branch: string) =>
      sh(origin, "git", "ls-tree", "--name-only", "-r", branch).trim().split("\n");
    return { repo, origin, state, github, files, base: { state, workwork: "false" } };
  }

  test("a goal: waits for approval, merges each node into its integration branch in order, then opens the final PR", async () => {
    const { repo, state, github, files, base } = goalRepo();
    agents({ claude: NODE });
    const goal = await importPlan(
      state,
      plan(
        repo,
        [
          { key: "a", gates: ["test -e a.txt"] },
          { key: "b", after: ["a"] },
        ],
        { gates: ["test -e .factory/demo.md"] },
      ),
    );
    expect(files("goal/demo")).toEqual([".factory/demo.md", ".factory/demo.plan.json"]);
    expect(readJobs(state).find((job) => job.id === goal.id)).toMatchObject({
      state: "blocked",
      blocked: "checkpoint",
    });
    const quiet = Date.now() + 300;
    expect(
      (await work(options(base), () => Date.now() > quiet)).filter((job) => job.attempts.length),
    ).toEqual([]);

    approveGoal(state, goal.id);
    const jobs = await work(
      options(base),
      (jobs) => jobs.find((job) => job.id === goal.id)!.state === "done",
    );
    expect(jobs.filter((job) => job.of).map((job) => [job.key, job.state])).toEqual([
      ["a", "done"],
      ["b", "done"],
    ]);
    expect(files("goal/demo")).toEqual([
      ".factory/demo.md",
      ".factory/demo.plan.json",
      "a.txt",
      "b.txt",
    ]);
    const calls = github.calls();
    expect(calls).toContain("pr create --base goal/demo --head node/demo/a");
    expect(calls).toContain("pr create --base goal/demo --head node/demo/b");
    expect(calls).toContain("pr create --base main --head goal/demo --title Demo goal");
    const prompt = readFileSync(
      join(dirname(jobs.find((job) => job.key === "b")!.attempts[0].log), "prompt.md"),
      "utf8",
    );
    expect(prompt).toContain("Read `.factory/demo.md` first");
    expect(prompt).toContain("You're on branch `node/demo/b`");
    expect(prompt).toMatch(
      /## What this builds on\n\n- a: did it \(https:\/\/github.com\/o\/r\/pull\/10\d\)/,
    );
  });

  test("a node that no longer rebases gets a conflicts job on its branch, then merges", async () => {
    const { repo, state, files, base } = goalRepo();
    const script = `b=$(git rev-parse --abbrev-ref HEAD); key=$(basename $b)
case "$prompt" in
  *"no longer rebases cleanly"*) git rebase -q origin/goal/demo || { echo both > same.txt; git add same.txt; GIT_EDITOR=true git rebase --continue; }; git push -qf origin HEAD:$b ;;
  *) echo "$key" > same.txt; git add same.txt; git commit -qm "$key"; sleep 0.3; git push -q origin HEAD:$b ;;
esac; ${RESULT}`;
    agents({ claude: script, pi: script });
    const goal = await importPlan(
      state,
      plan(repo, [
        { key: "a", touches: ["a/**"] },
        { key: "b", touches: ["b/**"] },
      ]),
    );
    approveGoal(state, goal.id);
    const jobs = await work(
      options(base, { claude: {}, pi: {} }),
      (jobs) => jobs.find((job) => job.id === goal.id)!.state === "done",
    );
    const conflicts = jobs.filter((job) => job.item.play === "conflicts");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ state: "done", front: true });
    expect(sh(repo, "git", "show", "origin/goal/demo:same.txt")).toBe("both\n");
    expect(files("goal/demo")).toContain("same.txt");
  });

  test("a red integration branch pauses the goal and queues a fix at the front", async () => {
    const { repo, state, files, base } = goalRepo();
    agents({
      claude: `b=$(git rev-parse --abbrev-ref HEAD)
case "$prompt" in
  *"integration branch"*"fails"*) git rm -q bad.txt; git commit -qm fix ;;
  *) echo bad > bad.txt; git add bad.txt; git commit -qm bad ;;
esac; git push -q origin HEAD:$b; ${RESULT}`,
    });
    const goal = await importPlan(
      state,
      plan(repo, [{ key: "a" }, { key: "b", after: ["a"] }], { gates: ["test ! -e bad.txt"] }),
    );
    approveGoal(state, goal.id);
    const jobs = await work(
      options(base),
      (jobs) => jobs.find((job) => job.id === goal.id)!.state === "done",
    );
    const goalJob = jobs.find((job) => job.id === goal.id)!;
    expect(goalJob.notes.map((note) => note.text)).toContain(
      "goal/demo fails `test ! -e bad.txt` after merging a",
    );
    expect(jobs.filter((job) => job.item.play === "red").map((job) => job.state)).toEqual([
      "done",
      "done",
    ]);
    expect(files("goal/demo")).not.toContain("bad.txt");
  });

  test("a node with a review: its findings become a fix on its branch before it merges", async () => {
    const { repo, state, base } = goalRepo();
    agents({
      claude: `b=$(git rev-parse --abbrev-ref HEAD)
case "$prompt" in
  *"Review the work"*) ${report(state, { kind: "result", text: "one finding", followups: ["a.txt says a, should say A"] })} ;;
  *"A review of branch"*) echo A > a.txt; git commit -qam fix; git push -q origin HEAD:$b; ${RESULT} ;;
  *) ${NODE} ;;
esac`,
    });
    const goal = await importPlan(state, plan(repo, [{ key: "a", review: "builder" }]));
    approveGoal(state, goal.id);
    const jobs = await work(
      options(base),
      (jobs) => jobs.find((job) => job.id === goal.id)!.state === "done",
    );
    expect(jobs.filter((job) => job.of).map((job) => [job.item.play, job.state])).toEqual([
      ["review", "done"],
      ["fix", "done"],
      ["goal", "done"],
    ]);
    expect(sh(repo, "git", "show", "origin/goal/demo:a.txt")).toBe("A\n");
  });

  test("a pasted plan imports from YAML, and one with problems lists them and changes nothing", async () => {
    const { repo, state } = goalRepo();
    await expect(
      importPlanText(state, toYaml(plan(repo, [{ key: "a", after: ["x"] }]))),
    ).rejects.toThrow(/problems:\n- .*x/);
    expect(readJobs(state)).toEqual([]);
    const goal = await importPlanText(state, toYaml(plan(repo, [{ key: "a" }])));
    expect(
      readJobs(state)
        .filter((job) => job.of === goal.id)
        .map((job) => job.key),
    ).toEqual(["a"]);
  });

  test("goal new: the decomposer writes a plan, gets a follow-up while it's invalid, and the goal waits with it", async () => {
    const { repo, state, base } = goalRepo();
    const turns = join(mkdtempSync(join(scratch, "turns-")), "n");
    const valid = plan(repo, [{ key: "a" }, { key: "b", after: ["a"] }]);
    agents({
      claude: `n=$(($(cat ${turns} 2>/dev/null || echo 0) + 1)); echo $n > ${turns}; mkdir -p .factory
if [ $n = 1 ]; then echo '{"format":"factory-plan/1","nodes":[]}' > .factory/demo-goal.plan.json; else echo '${JSON.stringify(valid)}' > .factory/demo-goal.plan.json; fi; ${RESULT}`,
    });
    const goal = await newGoal(state, "Demo goal", repo, "Make a demo.");
    const jobs = await work(options(base), (jobs) => jobs.some((job) => job.key === "b"));
    const decompose = jobs.find((job) => job.item.play === "decompose")!;
    expect(decompose).toMatchObject({ state: "done", tier: "communicator" });
    expect(decompose.notes.find((note) => note.kind === "factory")?.text).toContain(
      "has problems; fix them all:",
    );
    expect(readFileSync(join(dirname(decompose.attempts[0].log), "prompt.md"), "utf8")).toContain(
      "Write the plan to `.factory/demo-goal.plan.json`",
    );
    expect(jobs.find((job) => job.id === goal.id)).toMatchObject({
      state: "blocked",
      blocked: "checkpoint",
    });
    expect(jobs.filter((job) => job.key).map((job) => job.key)).toEqual(["a", "b"]);
  });

  test("a node failed for good queues a replan; a replan may change what hasn't started, and a big one waits for approval", async () => {
    const { repo, state, base } = goalRepo();
    const replanned = plan(repo, [
      { key: "a", tier: "communicator" },
      { key: "c", prompt: "Do c instead." },
      { key: "d", after: ["c"] },
    ]);
    agents({
      claude: `case "$prompt" in
  *"Replan the goal"*) mkdir -p .factory; echo '${JSON.stringify(replanned)}' > .factory/demo.replan.json; ${RESULT} ;;
  *) exit 1 ;;
esac`,
    });
    const goal = await importPlan(
      state,
      plan(repo, [{ key: "a", tier: "communicator" }, { key: "b", after: ["a"] }, { key: "c" }]),
    );
    approveGoal(state, goal.id);
    const jobs = await work(options(base), (jobs) =>
      jobs.some((job) => job.item.play === "replan" && job.state === "done"),
    );
    const nodes = jobs.filter((job) => job.key).sort((x, y) => x.key!.localeCompare(y.key!));
    expect(nodes.map((job) => [job.key, job.state])).toEqual([
      ["a", "failed"],
      ["b", "removed"],
      ["c", "queued"],
      ["d", "queued"],
    ]);
    expect(jobs.find((job) => job.key === "c")!.prompt).toBe("Do c instead.");
    expect(jobs.find((job) => job.id === goal.id)).toMatchObject({
      state: "blocked",
      blocked: "checkpoint",
    });
  });

  test("a goal at its attempt budget waits; approving gives it the budget again", async () => {
    const { repo, state, base } = goalRepo();
    agents({ claude: NODE });
    const goal = await importPlan(
      state,
      plan(repo, [{ key: "a" }, { key: "b" }], { budget: { attempts: 1 } }),
    );
    approveGoal(state, goal.id);
    let jobs = await work(
      options(base),
      (jobs) => jobs.find((job) => job.id === goal.id)!.blocked === "checkpoint",
    );
    expect(jobs.filter((job) => job.state === "done" && job.key)).toHaveLength(1);
    approveGoal(state, goal.id);
    jobs = await work(
      options(base),
      (jobs) => jobs.find((job) => job.id === goal.id)!.state !== "queued",
    );
    expect(jobs.filter((job) => job.key).map((job) => job.state)).toEqual(["done", "done"]);
  });

  test("serve lists a newly cloned repo even when workwork finds no candidates", async () => {
    const source = mkdtempSync(join(scratch, "src-"));
    const state = mkdtempSync(join(scratch, "state-"));
    const { origin } = repoWithOrigin();
    const bin = mkdtempSync(join(scratch, "bin-"));
    script(bin, "gh", `git clone -q '${origin}' "$4"`);
    script(bin, "workwork", "echo '[]'");
    process.env.PATH = `${bin}:${process.env.PATH}`;
    const previousSource = process.env.SRC;
    process.env.SRC = source;
    const server = serve(state, 0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/api`;
    const candidates = async () => (await fetch(`${url}/candidates`)).json();
    try {
      expect(await candidates()).toEqual({ at: null, items: [], repos: [], root: source });
      const response = await fetch(`${url}/repos/clone`, {
        method: "POST",
        body: JSON.stringify({ name: "owner/new-app" }),
      });
      expect(response.status).toBe(200);
      const repos = [join(source, "new-app")];
      expect(await candidates()).toMatchObject({ items: [], repos });
      await expect
        .poll(candidates)
        .toEqual({ at: expect.any(String), items: [], repos, root: source });
    } finally {
      server.close();
      if (previousSource === undefined) delete process.env.SRC;
      else process.env.SRC = previousSource;
    }
  });

  test("serve starts a goal in a new project: the repo under $SRC, pushed to a new origin", async () => {
    const source = mkdtempSync(join(scratch, "src-"));
    const state = mkdtempSync(join(scratch, "state-"));
    const origin = join(mkdtempSync(join(scratch, "origin-")), "units.git");
    sh(scratch, "git", "init", "-q", "--bare", origin);
    const bin = mkdtempSync(join(scratch, "bin-"));
    script(bin, "gh", `git remote add origin '${origin}' && git push -q -u origin main`);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    const previousSource = process.env.SRC;
    process.env.SRC = source;
    const server = serve(state, 0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const post = (body: object) =>
      fetch(`http://127.0.0.1:${port}/api/goals`, { method: "POST", body: JSON.stringify(body) });
    try {
      const response = await post({ title: "Units", brief: "Convert units.", project: "units" });
      expect(response.status).toBe(200);
      const goal = readJobs(state).find((job) => job.goal)!;
      expect(goal.goal).toMatchObject({ repo: join(source, "units"), summary: "Convert units." });
      expect(sh(origin, "git", "log", "--format=%s", "main")).toBe("init\n");
      expect((await post({ title: "Again", brief: "", project: "units" })).status).toBe(400);
    } finally {
      server.close();
      if (previousSource === undefined) delete process.env.SRC;
      else process.env.SRC = previousSource;
    }
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
        level: "skim",
        checks: "pending",
        files: ["a.ts"],
        conflicts: false,
      });
      expect(await (await fetch(url(`/api/jobs/${job.id}/pr`))).json()).toEqual({
        body: OPEN_PR.body,
        diff: "+simpler a\n",
      });
      const merge = () => fetch(url(`/api/jobs/${job.id}/merge`), { method: "POST" });
      expect(await (await merge()).json()).toEqual({
        error: `${pr} isn't ready to merge: see it on GitHub`,
      });
      github.answer({ mergeable: "UNKNOWN" });
      expect((await merge()).status).toBe(400);
      github.answer({});
      expect((await merge()).status).toBe(200);
      expect(github.calls()).toContain(`pr merge ${pr} --squash --delete-branch`);
      const after = (await (await fetch(url("/api/state"))).json()) as Snapshot;
      expect(after.prs[pr].state).toBe("MERGED");
    } finally {
      server.close();
    }
  });

  test("the merge train merges one PR at a time and skips one that's no longer open", async () => {
    const base = setup(["a", "b"]);
    const github = gh();
    const count = join(mkdtempSync(join(scratch, "count-")), "n");
    agents({
      claude: `n=$(($(cat ${count} 2>/dev/null || echo 0) + 1)); echo $n > ${count}; echo "opened https://github.com/o/r/pull/$n"; ${RESULT}`,
    });
    const jobs = [base.pick("a"), base.pick("b")];
    await work(options(base));
    const server = serve(base.state, 0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const url = (path: string) => `http://127.0.0.1:${port}${path}`;
    try {
      const start = await fetch(url("/api/train"), {
        method: "POST",
        body: JSON.stringify({ ids: jobs.map((job) => job.id) }),
      });
      expect(start.status, await start.text()).toBe(200);
      let train: Snapshot["train"] = {};
      while (Object.keys(train).length < 2 || Object.values(train).some(onTrain)) {
        train = ((await (await fetch(url("/api/state"))).json()) as Snapshot).train;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // The fake gh answers the same for every PR, so the first merge closes the second.
      expect(train).toEqual({
        [jobs[0].id]: { step: "merged" },
        [jobs[1].id]: { step: "skipped", reason: "already merged" },
      });
      expect(github.calls().match(/pr merge/g)).toHaveLength(1);
      const said = readJobs(base.state).map((job) =>
        job.notes.filter((note) => note.kind === "train").map((note) => note.text),
      );
      expect(said).toEqual([["merged"], ["skipped: already merged"]]);
    } finally {
      server.close();
    }
  });

  /** Starts serve with a fake agent on PATH; `page` opens the Plan chat's event stream. */
  async function chatServer(
    name: string,
    fake: string,
    chat: Settings["chat"],
    state = setup([]).state,
  ) {
    writeSettings(state, { ...readSettings(state), chat });
    const bin = mkdtempSync(join(scratch, `${name}-`));
    script(bin, name, fake);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    const server = serve(state, 0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/api/chat`;
    /** `until` resolves with the records up to the first of that type. */
    async function page() {
      const reader = (await fetch(url)).body!.pipeThrough(new TextDecoderStream()).getReader();
      let text = "";
      return async (type: string) => {
        for (;;) {
          const records = [...text.matchAll(/^data: (.*)$/gm)].map(([, json]) => JSON.parse(json));
          const end = records.findIndex((record) => record.type === type);
          if (end >= 0) return records.slice(0, end + 1);
          text += (await reader.read()).value;
        }
      };
    }
    const prompt = (message: string) =>
      fetch(url, { method: "POST", body: JSON.stringify({ message }) });
    const close = () => {
      server.closeAllConnections();
      server.close();
    };
    return { state, url, page, prompt, close };
  }

  test("the Plan chat streams Pi's records to every page and replays them to a page that opens later", async () => {
    // Pi in RPC mode: one JSON record per line each way.
    const reply = '{"role":"assistant","content":[{"type":"text","text":"Queue a"}]}';
    const args = join(scratch, "pi-args");
    const chat = await chatServer(
      "pi",
      `echo "$@" > ${args}; while read -r line; do case "$line" in
*'"prompt"'*) echo '{"type":"agent_start"}'; echo '{"type":"message_end","message":${reply}}'; echo '{"type":"agent_settled"}' ;;
esac; done`,
      { agent: "pi", model: "openai/gpt-6.2-sol", effort: "low" },
    );
    try {
      const first = await chat.page();
      await chat.prompt("what next?");
      const types = ["agent_start", "message_end", "agent_settled"];
      expect((await first("agent_settled")).map((record) => record.type)).toEqual(types);
      const later = await chat.page();
      const replay = await later("agent_settled");
      expect(replay.map((record) => record.type)).toEqual(types);
      expect(replay[1].message.content[0].text).toBe("Queue a");
      await fetch(`${chat.url}/reset`, { method: "POST" });
      expect((await first("reset")).at(-1).type).toBe("reset");
      expect(readFileSync(args, "utf8")).toMatch(/--model openai\/gpt-6.2-sol --thinking low/);
    } finally {
      chat.close();
    }
  });

  test("the Plan chat survives a restart of serve: the page gets it back and the agent resumes its session", async () => {
    const args = join(scratch, "claude-resume-args");
    const reply = { type: "user", message: { content: "hello" } };
    const fake = `echo "$@" >> ${args}; while read -r line; do case "$line" in
*'"user"'*) echo '${JSON.stringify(reply)}'; echo '{"type":"result","is_error":false}' ;;
esac; done`;
    const settings = { agent: "claude" };
    const first = await chatServer("claude", fake, settings);
    try {
      const page = await first.page();
      await first.prompt("hello");
      await page("agent_settled");
    } finally {
      first.close();
    }
    const second = await chatServer("claude", fake, settings, first.state);
    try {
      const replay = await (await second.page())("exit");
      expect(replay.map((record) => record.type)).toEqual([
        "agent_start",
        "message_start",
        "message_end",
        "agent_settled",
        "exit",
      ]);
      await second.prompt("again");
      await (
        await second.page()
      )("agent_settled");
      const launches = readFileSync(args, "utf8");
      const id = /--session-id (\S+)/.exec(launches)![1];
      expect(launches).toContain(`--resume ${id}`);
      await fetch(`${second.url}/reset`, { method: "POST" });
      expect(existsSync(join(first.state, "chat.jsonl"))).toBe(false);
    } finally {
      second.close();
    }
  });

  test("a question from one of Pi's extensions reaches the page, and its answer reaches Pi", async () => {
    const answers = join(scratch, "pi-answers");
    const chat = await chatServer(
      "pi",
      `while read -r line; do case "$line" in
*'"prompt"'*) echo '{"type":"extension_ui_request","id":"q","method":"confirm","title":"Allow?"}' ;;
*extension_ui_response*) echo "$line" > ${answers}; echo '{"type":"agent_settled"}' ;;
esac; done`,
      { agent: "pi" },
    );
    try {
      const page = await chat.page();
      await chat.prompt("go");
      expect((await page("extension_ui_request")).at(-1)).toMatchObject({
        id: "q",
        title: "Allow?",
      });
      await fetch(`${chat.url}/answer`, {
        method: "POST",
        body: JSON.stringify({ id: "q", confirmed: true }),
      });
      expect((await page("extension_ui_answered")).at(-1).id).toBe("q");
      await page("agent_settled");
      expect(JSON.parse(readFileSync(answers, "utf8"))).toEqual({
        type: "extension_ui_response",
        id: "q",
        confirmed: true,
      });
    } finally {
      chat.close();
    }
  });

  test("Pi offers its scoped models in their order, then the rest, each with its efforts", async () => {
    const dir = mkdtempSync(join(scratch, "pi-models-"));
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ enabledModels: ["openai/sol", "local/*", "luna"] }),
    );
    const model = (provider: string, id: string, extra = {}) => ({
      provider,
      id,
      name: id,
      reasoning: true,
      ...extra,
    });
    const models = [
      model("openrouter", "openai/sol"),
      model("openai", "sol", { thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh" } }),
      model("local", "qwen", { reasoning: false }),
      model("codex", "luna"),
    ];
    const answer = { type: "response", command: "get_available_models", data: { models } };
    script(dir, "pi", `read -r line; echo '${JSON.stringify(answer)}'`);
    process.env.PATH = `${dir}:${process.env.PATH}`;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      expect(await agentModels("pi")).toEqual([
        {
          value: "openai/sol",
          label: "sol",
          efforts: ["low", "medium", "high", "xhigh"],
          scoped: true,
        },
        { value: "local/qwen", label: "qwen", efforts: ["off"], scoped: true },
        {
          value: "codex/luna",
          label: "luna",
          efforts: ["off", "minimal", "low", "medium", "high"],
          scoped: true,
        },
        {
          value: "openrouter/openai/sol",
          label: "openai/sol",
          efforts: ["off", "minimal", "low", "medium", "high"],
          scoped: false,
        },
      ]);
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });

  test("the Plan chat speaks to Claude Code in stream-json and gives the page Pi's records", async () => {
    const out = (...records: object[]) =>
      records.map((record) => `echo '${JSON.stringify(record)}'`).join("; ");
    const event = (record: object) => ({ type: "stream_event", event: record });
    const args = join(scratch, "claude-args");
    const chat = await chatServer(
      "claude",
      `echo "$@" > ${args}; while read -r line; do case "$line" in
*'"user"'*) ${out(
        { type: "system", subtype: "init", model: "claude-opus-5-5" },
        { type: "user", message: { content: "what next?" } },
        event({ type: "message_start" }),
        event({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
        event({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Queue a" },
        }),
        { type: "assistant", message: { content: [{ type: "text", text: "Queue a" }] } },
        event({
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "t", name: "Read" },
        }),
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "t", name: "Read", input: { file_path: "jobs.jsonl" } },
            ],
          },
        },
        event({ type: "message_stop" }),
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
        },
        { type: "result", is_error: false },
      )} ;;
esac; done`,
      { agent: "claude", model: "opus", effort: "high" },
    );
    try {
      const first = await chat.page();
      await chat.prompt("what next?");
      const records = await first("agent_settled");
      expect(records.map((record) => record.type)).toEqual([
        "agent_start",
        "response",
        "message_start",
        "message_end",
        "message_start",
        "message_update",
        "message_update",
        "message_update",
        "message_update",
        "message_end",
        "message_start",
        "message_end",
        "agent_settled",
      ]);
      expect(records[1].data).toEqual({
        model: { name: "claude-opus-5-5" },
        thinkingLevel: "high",
      });
      expect(records[3].message).toEqual({ role: "user", content: "what next?" });
      expect(records[9].message.content).toEqual([
        { type: "text", text: "Queue a" },
        {
          type: "toolCall",
          id: "t",
          name: "read",
          arguments: { file_path: "jobs.jsonl", path: "jobs.jsonl" },
        },
      ]);
      expect(records[11].message).toMatchObject({
        role: "toolResult",
        toolCallId: "t",
        isError: false,
      });
      expect(readFileSync(args, "utf8")).toMatch(/--model opus --effort high/);
      // The streamed deltas are dropped once the reply ended.
      const replay = await (await chat.page())("agent_settled");
      expect(replay.filter((record) => record.type === "message_update")).toEqual([]);
    } finally {
      chat.close();
    }
  });

  test.each([false, true])(
    "serve rebases a PR without guessing conflict resolutions (conflict: %s)",
    async (conflict) => {
      const base = setup(["a"]);
      const { repo } = base;
      const origin = sh(repo, "git", "remote", "get-url", "origin").trim();
      const name = conflict ? "rebase-conflict" : "rebase-clear";
      const pr = `https://github.com/o/${name}/pull/7`;
      sh(
        repo,
        "git",
        "config",
        "--global",
        `url.file://${origin}.insteadOf`,
        `https://github.com/o/${name}.git`,
      );
      const github = gh({ mergeable: "CONFLICTING" });
      agents({ claude: `echo 'opened ${pr}'; ${RESULT}` });
      const job = base.pick("a");

      writeFileSync(join(repo, "shared.txt"), "original\n");
      sh(repo, "git", "add", ".");
      sh(repo, "git", "commit", "-qm", "common base");
      sh(repo, "git", "checkout", "-qb", "workwork/a");
      writeFileSync(join(repo, "shared.txt"), "PR edit\n");
      sh(repo, "git", "commit", "-qam", "PR edit");
      sh(
        repo,
        "git",
        "push",
        "-q",
        "origin",
        "HEAD:refs/heads/workwork/a",
        "HEAD:refs/pull/7/head",
      );
      const before = sh(repo, "git", "rev-parse", "HEAD");
      sh(repo, "git", "checkout", "-q", "main");
      writeFileSync(join(repo, conflict ? "shared.txt" : "other.txt"), "base edit\n");
      sh(repo, "git", "add", ".");
      sh(repo, "git", "commit", "-qm", "base edit");
      sh(repo, "git", "push", "-q", "origin", "main");
      await work(options(base));

      script(
        join(origin, "hooks"),
        "post-receive",
        `printf '%s\\n' '${JSON.stringify(OPEN_PR)}' > ${github.viewPath}`,
      );
      const server = serve(base.state, 0, "127.0.0.1");
      await once(server, "listening");
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}`;
      try {
        const response = await fetch(`${url}/api/jobs/${job.id}/rebase`, { method: "POST" });
        const after = sh(origin, "git", "rev-parse", "refs/heads/workwork/a");
        if (conflict) {
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({
            error:
              "Rebase stopped. Resolve these conflicts manually; no changes were pushed:\nshared.txt",
          });
          expect(after).toBe(before);

          // The train skips it the same way and queues an agent to resolve the conflicts, once.
          for (let start = 0; start < 2; start++) {
            await fetch(`${url}/api/train`, {
              method: "POST",
              body: JSON.stringify({ ids: [job.id] }),
            });
            let car: TrainCar | undefined;
            while (!car || onTrain(car)) {
              car = ((await (await fetch(`${url}/api/state`)).json()) as Snapshot).train[job.id];
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            expect(car).toEqual({
              step: "skipped",
              reason: "conflicts in shared.txt; a job to resolve them is queued",
            });
          }
          const fixes = readJobs(base.state).filter((other) => other.item.play === "conflicts");
          expect(fixes.map((fix) => [fix.state, fix.item.title])).toEqual([
            ["queued", "Resolve conflicts: fix a"],
          ]);
          const [fix] = await work(options(base)).then((jobs) =>
            jobs.filter((other) => other.id === fixes[0].id),
          );
          const prompt = readFileSync(join(dirname(fix.attempts[0].log), "prompt.md"), "utf8");
          expect(prompt.startsWith(fixes[0].prompt!)).toBe(true);
          expect(prompt).toContain(`gh pr checkout ${pr}`);
          expect(prompt).toContain("- shared.txt");
          expect(fix.attempts[0].url).toBe(pr);
        } else {
          expect(response.status, await response.text()).toBe(200);
          expect(after).not.toBe(before);
          sh(origin, "git", "merge-base", "--is-ancestor", "main", after.trim());
          expect(sh(origin, "git", "show", `${after.trim()}:shared.txt`)).toBe("PR edit\n");
          expect(sh(repo, "git", "branch", "--show-current").trim()).toBe("main");
          const snapshot = (await (await fetch(`${url}/api/state`)).json()) as Snapshot;
          expect(snapshot.prs[pr]).toMatchObject({ state: "OPEN", conflicts: false });
        }
      } finally {
        server.close();
      }
    },
  );
});

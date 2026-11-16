import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { beforeAll, describe, expect, test } from "vite-plus/test";
import { agent, classify, resetTime, type Agent } from "../src/agents.ts";
import { run, type Options } from "../src/loop.ts";
import { approve, preview, readQueue, stage } from "../src/stage.ts";
import { order, readLedger, replay, type Entry, type Item } from "../src/state.ts";

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

describe("queue", () => {
  const item = (repo: string, id: string, level: string): Item => ({
    repo,
    label: repo,
    id,
    play: id,
    level,
  });

  test("cheapest attention first, taking turns between repos, only the wanted levels", () => {
    const items = [
      item("a", "a1", "skim"),
      item("a", "a2", "skim"),
      item("a", "a3", "skim"),
      item("b", "b1", "skim"),
      item("a", "a4", "auto"),
      item("b", "b2", "decide"),
      item("c", "c1", "skim"),
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

  test("replay skips done and twice-failed items and remembers who failed", () => {
    const entry = (id: string, agent: string, outcome: Entry["outcome"]) =>
      ({ repo: "r", id, agent, outcome }) as Entry;
    const { finished, failedBy } = replay([
      entry("done", "claude", "done"),
      entry("twice", "claude", "failed"),
      entry("twice", "pi", "timeout"),
      entry("once", "claude", "failed"),
      entry("limited", "pi", "limited"),
    ]);
    expect([...finished].sort()).toEqual(["r done", "r twice"]);
    expect(failedBy.get("r once")).toEqual(["claude"]);
    expect(failedBy.has("r limited")).toBe(false);
  });
});

function sh(cwd: string, command: string, ...args: string[]): string {
  return execFileSync(command, args, { cwd, encoding: "utf8" });
}

function script(name: string, body: string): string {
  const path = join(mkdtempSync(join(scratch, "bin-")), name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A clone with a remote, and a fake workwork offering the given ids in it (findings, unless kinds says). */
function setup(
  ids: string[],
  kinds: Record<string, string> = {},
): { repo: string; origin: string; state: string; workwork: string } {
  const origin = mkdtempSync(join(scratch, "origin-"));
  sh(origin, "git", "init", "-q", "--bare");
  const repo = mkdtempSync(join(scratch, "repo-"));
  sh(repo, "git", "clone", "-q", origin, ".");
  sh(repo, "git", "commit", "-q", "--allow-empty", "-m", "start");
  sh(repo, "git", "push", "-q", "origin", "main");
  sh(repo, "git", "remote", "set-head", "origin", "main");
  const items = ids.map((id) => ({
    repo,
    label: "repo",
    id,
    play: "fake",
    level: "skim",
    kind: kinds[id] ?? "finding",
    title: `title of ${id}`,
  }));
  const workwork = script(
    "workwork",
    `if [ "$1" = prompt ]; then echo "do $2"; else echo '${JSON.stringify(items)}'; fi`,
  );
  return { repo, origin, state: mkdtempSync(join(scratch, "state-")), workwork };
}

function fake(name: string, body: string): Agent {
  return {
    name,
    command: script(name, `cat >/dev/null\n${body}`),
    args: [],
    limit: agent("claude").limit,
  };
}

const options = (base: { state: string; workwork: string }, agents: Agent[]): Options => ({
  ...base,
  agents,
  levels: ["skim"],
  windows: 2,
  timeoutMs: 60_000,
});

const OK = fake("ok", "echo 'opened https://github.com/o/r/pull/7'");

describe("the loop", () => {
  test("does each item once, links the PR and removes clean worktrees", async () => {
    const base = setup(["fix/a.ts", "fix/b.ts"]);
    await run(options(base, [OK]));
    const ledger = readLedger(base.state);
    expect(ledger.map((entry) => [entry.id, entry.outcome, entry.url])).toEqual([
      ["fix/a.ts", "done", "https://github.com/o/r/pull/7"],
      ["fix/b.ts", "done", "https://github.com/o/r/pull/7"],
    ]);
    expect(readFileSync(join(ledger[0].log, "..", "prompt.md"), "utf8")).toBe("do fix/a.ts\n");
    expect(sh(base.repo, "git", "worktree", "list").trim().split("\n")).toHaveLength(1);
    const status = JSON.parse(readFileSync(join(base.state, "status.json"), "utf8"));
    expect(status.workers[0]).toMatchObject({ state: "stopped", reason: "nothing left to do" });

    await run(options(base, [OK]));
    expect(readLedger(base.state)).toHaveLength(2);
  });

  test("keeps a worktree with unpushed commits", async () => {
    const base = setup(["fix/a.ts"]);
    await run(options(base, [fake("ok", "git commit -q --allow-empty -m wip")]));
    const [entry] = readLedger(base.state);
    expect(entry.outcome).toBe("done");
    expect(existsSync(entry.worktree!)).toBe(true);
  });

  test("a failed item goes to the other agent once, then never again", async () => {
    const base = setup(["fix/a.ts"]);
    const fail = (name: string) => fake(name, "exit 1");
    await run(options(base, [fail("claude")]));
    await run(options(base, [fail("claude")]));
    expect(readLedger(base.state).map((entry) => entry.outcome)).toEqual(["failed"]);
    await run(options(base, [fail("pi")]));
    await run(options(base, [OK]));
    expect(readLedger(base.state).map((entry) => [entry.agent, entry.outcome])).toEqual([
      ["claude", "failed"],
      ["pi", "failed"],
    ]);
  });

  test("one window stops at the first limit without sleeping and leaves the item for a later run", async () => {
    const base = setup(["fix/a.ts"]);
    const wakes: number[] = [];
    await run({
      ...options(base, [fake("claude", "echo 'Claude AI usage limit reached|1794801600'; exit 1")]),
      windows: 1,
      sleep: async (ms) => void wakes.push(ms),
    });
    expect(readLedger(base.state).map((entry) => entry.outcome)).toEqual(["limited"]);
    expect(wakes).toHaveLength(0);
    const status = JSON.parse(readFileSync(join(base.state, "status.json"), "utf8"));
    expect(status.workers[0]).toMatchObject({ state: "stopped", reason: "limit 1 of 1" });
    await run(options(base, [OK]));
    expect(readLedger(base.state).map((entry) => entry.outcome)).toEqual(["limited", "done"]);
  });

  test("sleeps until the parsed reset, puts the item back, and stops after its windows", async () => {
    const base = setup(["fix/a.ts", "fix/b.ts"]);
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const wakes: number[] = [];
    await run({
      ...options(base, [fake("claude", `echo 'Claude AI usage limit reached|${reset}'; exit 1`)]),
      sleep: async (ms) => void wakes.push(Date.now() + ms),
    });
    const ledger = readLedger(base.state);
    // The same item again after the wait: it went back to the front.
    expect(ledger.map((entry) => [entry.id, entry.outcome])).toEqual([
      ["fix/a.ts", "limited"],
      ["fix/a.ts", "limited"],
    ]);
    expect(wakes).toHaveLength(1);
    expect(Math.abs(wakes[0] - (reset * 1000 + 2 * MINUTE))).toBeLessThan(100);
    const status = JSON.parse(readFileSync(join(base.state, "status.json"), "utf8"));
    expect(status.workers[0]).toMatchObject({ state: "stopped", reason: "limit 2 of 2" });
  });

  test("three quick failures in a row count as a limit", async () => {
    const base = setup(["fix/a.ts", "fix/b.ts", "fix/c.ts", "fix/d.ts"]);
    await run({ ...options(base, [fake("claude", "echo 'Not logged in'; exit 1")]), windows: 1 });
    expect(readLedger(base.state).map((entry) => entry.outcome)).toEqual([
      "failed",
      "failed",
      "failed",
    ]);
  });

  test("kills an agent that runs past the timeout, children included", async () => {
    const base = setup(["fix/a.ts"]);
    const marker = join(scratch, "survived");
    await run({
      ...options(base, [fake("claude", `(sleep 2; touch ${marker}) & sleep 30`)]),
      timeoutMs: 300,
    });
    expect(readLedger(base.state).map((entry) => entry.outcome)).toEqual(["timeout"]);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(existsSync(marker)).toBe(false);
  });

  test("--max-items stops after starting that many", async () => {
    const base = setup(["fix/a.ts", "fix/b.ts"]);
    await run({ ...options(base, [OK]), maxItems: 1 });
    expect(readLedger(base.state)).toHaveLength(1);
  });
});

describe("staging", () => {
  const ALL = ["auto", "skim", "decide"];
  const stageOptions = (base: { repo: string; state: string; workwork: string }) => ({
    repos: [base.repo],
    levels: ALL,
    kinds: ["finding", "scan"],
    limit: 10,
    pull: true,
    state: base.state,
    workwork: base.workwork,
  });

  /** A commit pushed to origin from another clone, so the checkout is behind. */
  function pushElsewhere(origin: string): string {
    const other = mkdtempSync(join(scratch, "other-"));
    sh(other, "git", "clone", "-q", origin, ".");
    sh(other, "git", "commit", "-q", "--allow-empty", "-m", "newer");
    sh(other, "git", "push", "-q", "origin", "main");
    return sh(other, "git", "rev-parse", "HEAD").trim();
  }

  test("pulls only the picked repo, then saves its findings and scans, findings first, up to the limit", async () => {
    const base = setup(["clarify/x.ts", "bug-sweep/.", "dep-patch/a", "todo/b"], {
      "clarify/x.ts": "rotation",
      "bug-sweep/.": "scan",
    });
    const latest = pushElsewhere(base.origin);
    const ran = join(scratch, "workwork-ran-in");
    // Fails unless asked about this one repo, never --all.
    const workwork = script(
      "workwork",
      `[ "$1" = --json ] && [ -z "$2" ] || exit 9\npwd > ${ran}\nexec ${base.workwork} "$@"`,
    );
    const staged = await stage({ ...stageOptions(base), workwork, limit: 2 });

    expect(sh(base.repo, "git", "rev-parse", "HEAD").trim()).toBe(latest);
    expect(staged.repos).toEqual([{ repo: base.repo, head: latest.slice(0, 7) }]);
    expect(readFileSync(ran, "utf8").trim()).toBe(base.repo);
    expect(staged.items.map((item) => item.id)).toEqual(["dep-patch/a", "todo/b"]);
    expect(staged.left).toEqual({ limit: 1, kinds: { rotation: 1 } });
    expect(JSON.parse(readFileSync(join(base.state, "stage.json"), "utf8"))).toEqual(staged);

    const text = preview(base.state);
    expect(text).toMatch(/^ {3}1 {2}repo-\w+ {2}dep-patch\/a {2}finding +title of dep-patch\/a$/m);
    expect(text).toContain("finding: a tool reported this exact thing");
    expect(text).toContain("Not staged: 1 past --limit, 1 rotation (--kinds)");
    expect(text).not.toContain("Approved");
  });

  test("won't move a checkout that isn't a clean default branch it can fast-forward", async () => {
    const base = setup(["todo/a"]);
    pushElsewhere(base.origin);
    sh(base.repo, "git", "switch", "-q", "-c", "mine");
    await expect(stage(stageOptions(base))).rejects.toThrow("is on mine, not main");
    // As it is, without pulling, it stages fine.
    expect((await stage({ ...stageOptions(base), pull: false })).items).toHaveLength(1);

    sh(base.repo, "git", "switch", "-q", "main");
    writeFileSync(join(base.repo, "notes.txt"), "draft\n");
    sh(base.repo, "git", "add", "notes.txt");
    await expect(stage(stageOptions(base))).rejects.toThrow("has uncommitted changes");

    sh(base.repo, "git", "commit", "-q", "-m", "local only");
    await expect(stage(stageOptions(base))).rejects.toThrow("can't fast-forward main");
    expect(sh(base.repo, "git", "log", "--format=%s", "-1").trim()).toBe("local only");
  });

  test("approve takes exactly the numbered items, and a queue run does only those", async () => {
    const base = setup(["todo/a", "todo/b", "todo/c"]);
    await stage(stageOptions(base));
    expect(() => approve(base.state, ["4"])).toThrow("no staged item 4");
    expect(() => approve(base.state, [])).toThrow("approve which?");
    expect(approve(base.state, ["1,3"]).items.map((item) => item.id)).toEqual(["todo/a", "todo/c"]);

    // workwork still offers all three; only the approved two run.
    await run({ ...options(base, [OK]), approved: readQueue(base.state).items });
    expect(readLedger(base.state).map((entry) => [entry.id, entry.outcome])).toEqual([
      ["todo/a", "done"],
      ["todo/c", "done"],
    ]);
    const text = preview(base.state);
    expect(text).toMatch(/^\* {2}1 .*todo\/a .* → done https:\/\/github\.com\/o\/r\/pull\/7$/m);
    expect(text).toMatch(/^ {3}2 .*todo\/b {2}finding +title of todo\/b$/m);
    expect(text).toContain("Approved");
    // Staging again leaves out what's done.
    expect((await stage(stageOptions(base))).items.map((item) => item.id)).toEqual(["todo/b"]);
  });

  test("the CLI end to end: stage, preview, approve, then run --queue with pi and claude", () => {
    const base = setup(["todo/a", "todo/b", "clarify/x.ts"], { "clarify/x.ts": "rotation" });
    const bin = mkdtempSync(join(scratch, "path-"));
    const calls = join(scratch, "agent-calls");
    for (const name of ["pi", "claude"]) {
      writeFileSync(
        join(bin, name),
        `#!/bin/sh\ncat >/dev/null\necho ${name} >> ${calls}\necho 'opened https://github.com/o/r/pull/9'\n`,
      );
      chmodSync(join(bin, name), 0o755);
    }
    execFileSync("cp", [base.workwork, join(bin, "workwork")]);
    const data = mkdtempSync(join(scratch, "data-"));
    // Only the fakes, node and the system tools: the real agents can't be reached.
    const env = {
      ...process.env,
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      DATA: data,
      SRC: dirname(base.repo),
    };
    const cli = (...args: string[]) =>
      execFileSync(process.execPath, [join(import.meta.dirname, "../src/cli.ts"), ...args], {
        env,
        encoding: "utf8",
      });

    const staged = cli("stage", "--repo", basename(base.repo));
    expect(staged).toContain("todo/a");
    expect(staged).not.toContain("clarify/x.ts");
    expect(cli("preview")).toBe(staged);
    expect(cli("approve", "2")).toContain("Approved 1: todo/b");
    cli("run", "--queue", "--agents", "pi,claude", "--windows", "3");
    const ledger = readLedger(join(data, "apps", "factory"));
    expect(ledger.map((entry) => [entry.id, entry.outcome])).toEqual([["todo/b", "done"]]);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
    expect(cli("status")).toContain("the 1 approved items");
  });
});

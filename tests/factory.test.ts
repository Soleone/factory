import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vite-plus/test";
import { agent, classify, resetTime, type Agent } from "../src/agents.ts";
import { run, type Options } from "../src/loop.ts";
import { order, readLedger, replay, type Entry, type Item } from "../src/state.ts";
import { serve } from "../src/web.ts";

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
    title: "",
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

describe("the loop", () => {
  function sh(cwd: string, command: string, ...args: string[]): string {
    return execFileSync(command, args, { cwd, encoding: "utf8" });
  }

  function script(name: string, body: string): string {
    const path = join(mkdtempSync(join(scratch, "bin-")), name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  /** A clone with a remote, and a fake workwork offering the given ids in it. */
  function setup(ids: string[]): { repo: string; state: string; workwork: string } {
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
      title: `fix ${id}`,
    }));
    const workwork = script(
      "workwork",
      `if [ "$1" = prompt ]; then echo "do $2"; else echo '${JSON.stringify(items)}'; fi`,
    );
    return { repo, state: mkdtempSync(join(scratch, "state-")), workwork };
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
    const status = JSON.parse(readFileSync(join(base.state, "status.json"), "utf8"));
    expect(status.queue.map((item: Item) => item.title)).toEqual(["fix fix/b.ts"]);
  });

  test("serve shows the results and their logs, and nothing outside runs/", async () => {
    const base = setup(["fix/a.ts"]);
    await run(options(base, [OK]));
    const server = serve(base.state, 0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);
    try {
      const { results } = (await (await get("/state.json")).json()) as { results: Entry[] };
      expect(results.map((entry) => [entry.title, entry.outcome])).toEqual([
        ["fix fix/a.ts", "done"],
      ]);
      expect(await (await get(`/${results[0].log}`)).text()).toContain("pull/7");
      expect((await get("/runs/%2E%2E/ledger.jsonl")).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

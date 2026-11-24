import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { addJobs, addNote, answer, removeJob, retryJob } from "../src/backend/jobs.ts";
import { readSettings, writeSettings } from "../src/backend/state.ts";
import {
  scratch,
  sh,
  agents,
  gh,
  setup,
  options,
  work,
  RESULT,
  OK,
  report,
  tiered,
} from "./harness.ts";

describe("the factory", () => {
  test("does picks before auto jobs, links the PR and reuses one worktree per agent and repo", async () => {
    const base = setup(["a", "b", "c"]);
    agents({ claude: OK });
    base.pick("b");
    writeFileSync(
      join(base.state, "candidates.json"),
      JSON.stringify({ at: new Date().toISOString(), items: base.items }),
    );
    writeSettings(base.state, {
      ...readSettings(base.state),
      auto: { on: true, attention: ["skim"], blueprints: [], repos: [] },
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
    expect(
      sh(
        base.repo,
        "git",
        "show",
        "-s",
        "--format=%an <%ae> / %cn <%ce>",
        second.attempts[0].branch!,
      ),
    ).toBe("Test <test@example.com> / Test <test@example.com>\n");
    // b's stays, and the next checkout didn't save a's work a second time.
    expect(sh(base.repo, "git", "branch", "--list", "factory/*")).toBe(`  factory/${b.id}-1\n`);
  });

  test("requires Git identity before launching an agent and uses the saved identity when unblocked", async () => {
    const base = setup(["a"]);
    base.pick("a");
    const previousConfig = process.env.GIT_CONFIG_GLOBAL;
    const noIdentity = join(scratch, "require-explicit.gitconfig");
    writeFileSync(noIdentity, "[user]\n\tuseConfigOnly = true\n");
    const repoConfig = sh(base.repo, "git", "config", "--local", "--list");
    const launched = join(base.state, "launched");
    agents({
      claude: `touch '${launched}'; git commit -q --allow-empty -m agent || exit 1; echo x > left.txt; ${RESULT}`,
    });
    try {
      process.env.GIT_CONFIG_GLOBAL = noIdentity;
      const [blocked] = await work(options(base));
      expect(blocked).toMatchObject({ state: "blocked", blocked: "setup" });
      expect(blocked.why).toContain("Settings → GitHub");
      expect(blocked.attempts).toMatchObject([{ setupFailed: true }]);
      expect(existsSync(launched)).toBe(false);

      const commitIdentity = { name: "Factory Test", email: "factory@example.com" };
      writeSettings(base.state, { ...readSettings(base.state), commitIdentity });
      const [finished] = await work(options(base), (jobs) => jobs[0].state === "done");
      expect(finished.state).toBe("done");
      expect(finished.attempts).toHaveLength(2);
      expect(existsSync(launched)).toBe(true);
      expect(
        sh(
          base.repo,
          "git",
          "log",
          "-2",
          "--format=%s: %an <%ae> / %cn <%ce>",
          finished.attempts[1].branch!,
        )
          .trim()
          .split("\n"),
      ).toEqual([
        "factory: changes the agent left uncommitted: Factory Test <factory@example.com> / Factory Test <factory@example.com>",
        "agent: Factory Test <factory@example.com> / Factory Test <factory@example.com>",
      ]);
      expect(sh(base.repo, "git", "config", "--local", "--list")).toBe(repoConfig);
      expect(sh(base.repo, "git", "log", "-1", "--format=%s")).toBe("start\n");
      expect(readFileSync(noIdentity, "utf8")).toBe("[user]\n\tuseConfigOnly = true\n");
    } finally {
      process.env.GIT_CONFIG_GLOBAL = previousConfig;
    }
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

  test("a question nobody answers holds the job only so long, then the agent goes with its recommendation", async () => {
    const base = setup(["a"]);
    agents({
      claude: `case "$prompt" in *"Nobody answered"*) ${RESULT}; exit 0 ;; esac
${report(base.state, { kind: "ask", text: "A or B? A, I think" }, "2026-11-16T04:00:00Z")}`,
    });
    base.pick("a");
    const [job] = await work(options(base));
    expect(job.state).toBe("done");
    expect(job.attempts).toMatchObject([{ outcome: "done", turns: 2 }]);
    expect(job.notes.map((note) => note.kind)).toEqual(["ask", "answer", "result"]);
    const turn = readFileSync(join(dirname(job.attempts[0].log), "turn-2.md"), "utf8");
    expect(turn).toContain("Go with your recommendation");
  });

  test("a session that was never saved starts over from the prompt instead of failing the job", async () => {
    const base = setup(["a"]);
    // Like claude when the session to resume doesn't exist: an error result, exit 0.
    const lost = JSON.stringify({
      type: "result",
      is_error: true,
      errors: ["No conversation found with session ID: x"],
    });
    agents({
      claude: `echo "args: $*"
case "$*" in *--resume*) echo 'No conversation found with session ID: x'; echo '${lost}'; exit 0 ;; esac
case "$prompt" in *"do a"*"You stopped without finishing"*) ${RESULT} ;; esac`,
    });
    base.pick("a");
    const [job] = await work(options(base));
    expect(job.state).toBe("done");
    expect(job.attempts).toMatchObject([{ outcome: "done", turns: 3, followups: 1 }]);
    const log = readFileSync(job.attempts[0].log, "utf8");
    const sessions = [...log.matchAll(/--session-id (\S+)/g)].map((match) => match[1]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).not.toBe(sessions[1]);
    expect(job.attempts[0].session).toBe(sessions[1]);
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
    const [failed] = await work(options(base, {}));
    expect(failed.attempts.map((attempt) => [attempt.agent, attempt.outcome])).toEqual([
      ["claude", "failed"],
      ["claude", "failed"],
    ]);
    expect(failed.state).toBe("failed");
    retryJob(base.state, job.id);
    agents({ claude: OK, pi: OK });
    const [done] = await work(options(base, {}));
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

  test("the worker's model and effort, unless the job has its own", async () => {
    const base = setup(["a"]);
    agents({ claude: `echo "args: $*"; ${RESULT}` });
    tiered(base.state, { presets: [{ agent: "claude", model: "opus", effort: "high" }] });
    base.pick("a", { effort: "low" });
    const [job] = await work(options(base, {}));
    expect(job.attempts[0]).toMatchObject({ model: "opus", effort: "low", outcome: "done" });
    expect(readFileSync(job.attempts[0].log, "utf8")).toContain("--model opus --effort low");
  });
});

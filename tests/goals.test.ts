import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, relative } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { addJobs, readJobs, type Event } from "../src/backend/jobs.ts";
import {
  approveGoal,
  cancelGoal,
  dropNode,
  importPlan,
  importPlanText,
  newGoal,
  retierNode,
  type Plan,
} from "../src/backend/goals.ts";
import { exportGoal } from "../src/backend/goalExport.ts";
import { stringify as toYaml } from "yaml";
import type { Job } from "../src/backend/types.ts";
import {
  item,
  scratch,
  script,
  sh,
  agents,
  gh,
  repoWithOrigin,
  options,
  work,
  RESULT,
  report,
} from "./harness.ts";

/** Whether `command` is an executable on PATH. */
const onPath = (command: string) =>
  (process.env.PATH ?? "").split(delimiter).some((dir) => dir && existsSync(join(dir, command)));

describe("the factory", () => {
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

  test("before it starts, a node can move to another tier or be dropped, and what waited on it waits on what it waited on", async () => {
    const { repo, state } = goalRepo();
    const goal = await importPlan(
      state,
      plan(repo, [{ key: "a" }, { key: "b", after: ["a"] }, { key: "c", after: ["b"] }]),
    );
    const id = (key: string) =>
      readJobs(state).find((job) => job.of === goal.id && job.key === key)!.id;
    retierNode(state, id("c"), "grunt");
    dropNode(state, id("b"));
    const nodes = readJobs(state).filter((job) => job.of === goal.id && job.state !== "removed");
    expect(nodes.map((node) => [node.key, node.tier, node.after])).toEqual([
      ["a", "builder", []],
      ["c", "grunt", [id("a")]],
    ]);
  });

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

  test("canceling a goal while a node runs doesn't deliver or reopen it", async () => {
    const { repo, state, files, base } = goalRepo();
    const gate = mkdtempSync(join(scratch, "cancel-"));
    const started = join(gate, "started");
    const released = join(gate, "released");
    agents({
      claude: `touch ${started}; while [ ! -e ${released} ]; do sleep 0.02; done; ${NODE}`,
    });
    const goal = await importPlan(state, plan(repo, [{ key: "a" }]));
    approveGoal(state, goal.id);
    let releasedAgent = false;
    const running = work(
      options(base),
      (jobs) => releasedAgent && !jobs.some((job) => job.of === goal.id && job.state === "running"),
    );
    try {
      for (let i = 0; i < 250 && !existsSync(started); i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(existsSync(started)).toBe(true);
      cancelGoal(state, goal.id);
    } finally {
      writeFileSync(released, "");
      releasedAgent = true;
      await running;
    }
    expect(readJobs(state).find((job) => job.id === goal.id)?.state).toBe("removed");
    expect(readJobs(state).find((job) => job.key === "a")).toMatchObject({
      state: "removed",
      attempts: [expect.objectContaining({ outcome: "done" })],
    });
    expect(files("goal/demo")).not.toContain("a.txt");
  });

  test("canceling a goal while its node asks removes the waiting job", async () => {
    const { repo, state, base } = goalRepo();
    const gate = mkdtempSync(join(scratch, "cancel-ask-"));
    const started = join(gate, "started");
    const released = join(gate, "released");
    agents({
      claude: `touch ${started}; while [ ! -e ${released} ]; do sleep 0.02; done; echo '{"at":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","type":"note","id":"'$FACTORY_JOB'","note":{"kind":"ask","text":"which?"}}' >> ../../../jobs.jsonl`,
    });
    const goal = await importPlan(state, plan(repo, [{ key: "a" }]));
    approveGoal(state, goal.id);
    let releasedAgent = false;
    const running = work(
      options(base),
      (jobs) => releasedAgent && !jobs.some((job) => job.of === goal.id && job.state === "running"),
    );
    try {
      for (let i = 0; i < 250 && !existsSync(started); i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(existsSync(started)).toBe(true);
      cancelGoal(state, goal.id);
    } finally {
      writeFileSync(released, "");
      releasedAgent = true;
      await running;
    }
    expect(readJobs(state).find((job) => job.id === goal.id)?.state).toBe("removed");
    expect(readJobs(state).find((job) => job.key === "a")).toMatchObject({
      state: "removed",
      notes: expect.arrayContaining([expect.objectContaining({ kind: "ask", text: "which?" })]),
    });
  });

  /** Runs a one-node goal to done and exports it to a fresh `goal.zip`. */
  async function exportedGoal() {
    const { repo, state, base } = goalRepo();
    agents({ claude: NODE });
    const goal = await importPlan(state, plan(repo, [{ key: "a" }]));
    approveGoal(state, goal.id);
    const jobs = await work(
      options(base),
      (jobs) => jobs.find((job) => job.id === goal.id)!.state === "done",
    );
    const node = jobs.find((job) => job.key === "a")!;
    // A job outside the goal, which the export leaves out.
    addJobs(state, [item(repo, "elsewhere")], "pick");
    const out = join(mkdtempSync(join(scratch, "export-")), "goal.zip");
    await exportGoal(
      state,
      readJobs(state).find((job) => job.id === goal.id)!,
      out,
    );
    return { goal, node, out };
  }

  const exportEntries = (node: Job) => [
    "REVIEW.md",
    "summary.txt",
    "goal.json",
    "jobs.json",
    "events.jsonl",
    "settings.json",
    `attempts/${node.id}-1/prompt.md`,
    `attempts/${node.id}-1/agent.log`,
    "repo/memory.md",
    "repo/plan.json",
    "repo/git-log.txt",
    "prs/101.json",
    "prs/101.diff",
  ];

  function expectExportContents(goal: Job, node: Job, read: (path: string) => string): void {
    expect(JSON.parse(read("jobs.json")).map((job: Job) => job.key)).toEqual(["a"]);
    const ids = read("events.jsonl")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Event)
      .map((event) => ("job" in event ? event.job.id : event.id));
    expect(ids[0]).toBe(goal.id);
    expect(new Set(ids)).toEqual(new Set([goal.id, node.id]));
  }

  test("a goal's export stages its jobs, events, attempt folders, memory, plan and PRs for zip", async () => {
    // A fake zip on PATH copies what it was asked to archive to <out>.d, so this runs without zip.
    const bin = mkdtempSync(join(scratch, "zip-"));
    script(bin, "zip", `[ "$1 $3" = "-qr ." ] || exit 2; cp -R . "$2.d" && : > "$2"`);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    const { goal, node, out } = await exportedGoal();
    expect(existsSync(out)).toBe(true);
    const staged = `${out}.d`;
    const entries = readdirSync(staged, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(staged, join(entry.parentPath, entry.name)));
    expect(entries).toEqual(expect.arrayContaining(exportEntries(node)));
    expectExportContents(goal, node, (path) => readFileSync(join(staged, path), "utf8"));
  });

  // Needs zip and unzip on PATH, and is reported as skipped without them:
  // `vp test run tests/factory.test.ts -t "real zip"`.
  test.skipIf(!onPath("zip") || !onPath("unzip"))(
    "a goal's export is a real zip archive (needs zip and unzip on PATH)",
    async () => {
      const { goal, node, out } = await exportedGoal();
      const entries = sh(scratch, "unzip", "-Z1", out).trim().split("\n");
      expect(entries).toEqual(expect.arrayContaining(exportEntries(node)));
      expectExportContents(goal, node, (path) => sh(scratch, "unzip", "-p", out, path));
    },
  );

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
      options(base, {}),
      (jobs) => jobs.find((job) => job.id === goal.id)!.state === "done",
    );
    const conflicts = jobs.filter((job) => job.item.blueprint === "conflicts");
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
    expect(jobs.filter((job) => job.item.blueprint === "red").map((job) => job.state)).toEqual([
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
    expect(jobs.filter((job) => job.of).map((job) => [job.item.blueprint, job.state])).toEqual([
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
    // Nothing to approve until the plan is in.
    expect(readJobs(state).find((job) => job.id === goal.id)?.blocked).toBeUndefined();
    const jobs = await work(options(base), (jobs) => jobs.some((job) => job.key === "b"));
    const decompose = jobs.find((job) => job.item.blueprint === "decompose")!;
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
      jobs.some((job) => job.item.blueprint === "replan" && job.state === "done"),
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

  test("a goal whose replan is the last job to finish still opens its final PR", async () => {
    const { repo, state, github, base } = goalRepo();
    const nodes = [
      { key: "m" },
      { key: "a", parent: "m", touches: ["a/**"] },
      { key: "b", touches: ["b/**"] },
    ];
    // m is done once a merges, which queues a replan; b merges meanwhile, so the replan ends last.
    const replanned = plan(repo, nodes);
    const script = `case "$prompt" in
  *"Replan the goal"*) sleep 0.5; mkdir -p .factory; echo '${JSON.stringify(replanned)}' > .factory/demo.replan.json; ${RESULT} ;;
  *) ${NODE} ;;
esac`;
    agents({ claude: script, pi: script });
    const goal = await importPlan(state, plan(repo, nodes));
    approveGoal(state, goal.id);
    const jobs = await work(
      options(base, {}),
      (jobs) => jobs.find((job) => job.id === goal.id)!.state === "done",
    );
    expect(jobs.filter((job) => job.item.blueprint === "replan").map((job) => job.state)).toEqual([
      "done",
    ]);
    expect(github.calls()).toContain("pr create --base main --head goal/demo --title Demo goal");
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
});

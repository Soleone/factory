import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { addJob, newId, readJobs, record, type Change, type NewJob } from "./jobs.ts";
import { checkout, originHead } from "./git.ts";
import { createPr } from "./review.ts";
import { output } from "./state.ts";
import {
  critical,
  depths,
  PLANNING,
  prUrl,
  TIERS,
  type Goal,
  type Item,
  type Job,
  type Tier,
} from "./types.ts";

const PLAN_FORMAT = "factory-plan/1";

/** The import format for goals; spec/plan-format.md describes it for other tools. */
export type Plan = {
  format: typeof PLAN_FORMAT;
  goal: {
    title: string;
    repo: string;
    branch?: string;
    summary: string;
    gates: string[];
    budget?: { attempts: number };
    allowUp?: boolean;
    replanTier?: Tier;
  };
  nodes: PlanNode[];
};

/** A milestone (a node others name as `parent`) never runs, so it needs no tier, prompt, touches or gates. */
type PlanNode = {
  key: string;
  title: string;
  tier?: Tier;
  prompt?: string;
  after: string[];
  touches?: string[];
  gates?: string[];
  needs?: string[];
  checkpoint?: boolean;
  parent?: string;
  review?: Tier;
};

/** Factory's own jobs inside a goal, told apart by their blueprint. */
const [DECOMPOSE, REPLAN] = PLANNING;
const REVIEW = "review";
const FIX = "fix";
const CONFLICTS = "conflicts";
const RED = "red";
const MAIN = "rebase-main";

function parsePlan(text: string, file: string): unknown {
  return /\.ya?ml$/i.test(file) ? parseYaml(text) : JSON.parse(text);
}

const KEY = /^[a-z0-9][a-z0-9._-]*$/;
const isTier = (value: unknown): value is Tier => (TIERS as readonly unknown[]).includes(value);
const strings = (value: unknown) =>
  Array.isArray(value) && value.every((each) => typeof each === "string");

/** Every problem with a plan, so whoever wrote it can fix them in one pass; empty when it's valid. */
export function checkPlan(raw: unknown): string[] {
  const problems: string[] = [];
  const plan = raw as Plan;
  if (!plan || typeof plan !== "object") return ["a plan is a JSON object"];
  if (plan.format !== PLAN_FORMAT) problems.push(`format must be "${String(PLAN_FORMAT)}"`);
  const goal = plan.goal;
  if (!goal || typeof goal !== "object") problems.push("goal is missing");
  else {
    if (typeof goal.title !== "string" || !goal.title.trim()) problems.push("goal.title is empty");
    if (typeof goal.repo !== "string" || !existsSync(join(goal.repo, ".git")))
      problems.push(`goal.repo ${goal.repo} is not a git repository`);
    if (typeof goal.summary !== "string" || !goal.summary.trim())
      problems.push("goal.summary is empty");
    if (!strings(goal.gates)) problems.push("goal.gates must be a list of commands");
    if (goal.branch !== undefined && !/^goal\/[a-z0-9][a-z0-9._-]*$/.test(goal.branch))
      problems.push(`goal.branch must look like goal/<slug>, got ${goal.branch}`);
    if (
      goal.budget !== undefined &&
      !(Number.isInteger(goal.budget?.attempts) && goal.budget.attempts > 0)
    )
      problems.push("goal.budget.attempts must be a whole number above 0");
    if (goal.replanTier !== undefined && !isTier(goal.replanTier))
      problems.push(`goal.replanTier ${String(goal.replanTier)} is not one of ${TIERS.join(", ")}`);
  }
  if (!Array.isArray(plan.nodes) || plan.nodes.length === 0) return [...problems, "nodes is empty"];
  const keys = new Set<string>();
  const milestones = new Set(plan.nodes.map((node) => node?.parent));
  for (const [index, node] of plan.nodes.entries()) {
    const runs = !milestones.has(node?.key);
    const at = `nodes[${index}]${typeof node?.key === "string" ? ` (${node.key})` : ""}`;
    if (typeof node?.key !== "string" || !KEY.test(node.key))
      problems.push(`${at}: key must be lowercase letters, digits, . _ -`);
    else if (keys.has(node.key)) problems.push(`${at}: key is used twice`);
    else keys.add(node.key);
    if (typeof node?.title !== "string" || !node.title.trim())
      problems.push(`${at}: title is empty`);
    if (runs && (typeof node?.prompt !== "string" || !node.prompt.trim()))
      problems.push(`${at}: prompt is empty`);
    if ((runs || node?.tier !== undefined) && !isTier(node?.tier))
      problems.push(`${at}: tier must be one of ${TIERS.join(", ")}`);
    if (node?.review !== undefined && !isTier(node.review))
      problems.push(`${at}: review must be a tier`);
    if (!strings(node?.after)) problems.push(`${at}: after must be a list of keys`);
    if ((runs || node?.touches !== undefined) && !strings(node?.touches))
      problems.push(`${at}: touches must be a list of globs (empty: anything)`);
    if ((runs || node?.gates !== undefined) && !strings(node?.gates))
      problems.push(`${at}: gates must be a list of commands`);
    if (node?.needs !== undefined && !strings(node.needs))
      problems.push(`${at}: needs must be a list`);
  }
  for (const node of plan.nodes) {
    for (const key of strings(node.after) ? node.after : [])
      if (!keys.has(key)) problems.push(`${node.key}: after names no node ${key}`);
    if (node.parent !== undefined && !keys.has(node.parent))
      problems.push(`${node.key}: parent names no node ${node.parent}`);
    if (node.parent === node.key) problems.push(`${node.key}: is its own parent`);
  }
  if (problems.length === 0) problems.push(...cycles(plan.nodes), ...waitsOnItsGroup(plan.nodes));
  return problems;
}

/** A node can't come after one of its own milestones: a milestone is done only when its nodes are. */
function waitsOnItsGroup(nodes: PlanNode[]): string[] {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  return nodes.flatMap((node) => {
    const above: string[] = [];
    for (let up = node.parent; up && !above.includes(up); up = byKey.get(up)?.parent)
      above.push(up);
    return node.after
      .filter((key) => above.includes(key))
      .map(
        (key) =>
          `${node.key} comes after ${key}, which contains it; drop it (a milestone's nodes already wait for what the milestone comes after)`,
      );
  });
}

function cycles(nodes: PlanNode[]): string[] {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const problems: string[] = [];
  for (const [field, next] of [
    ["after", (node: PlanNode) => node.after],
    ["parent", (node: PlanNode) => (node.parent ? [node.parent] : [])],
  ] as const) {
    const done = new Set<string>();
    const visit = (key: string, path: string[]): void => {
      if (path.includes(key)) {
        problems.push(
          `${field} has a cycle: ${[...path.slice(path.indexOf(key)), key].join(" -> ")}`,
        );
        return;
      }
      if (done.has(key)) return;
      for (const other of next(byKey.get(key)!)) visit(other, [...path, key]);
      done.add(key);
    };
    for (const node of nodes) visit(node.key, []);
  }
  return [...new Set(problems)];
}

const slugOf = (plan: Plan) =>
  plan.goal.branch?.slice("goal/".length) ??
  plan.goal.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

const memoryPath = (slug: string) => `.factory/${slug}.md`;
const planPath = (slug: string) => `.factory/${slug}.plan.json`;
const replanPath = (slug: string) => `.factory/${slug}.replan.json`;
const integration = (goal: Goal) => `goal/${goal.slug}`;
const nodeBranch = (goal: Goal, key: string) => `node/${goal.slug}/${key}`;

const goalItem = (repo: string, id: string, blueprint: string, title: string): Item => ({
  repo,
  label: basename(repo),
  id,
  blueprint,
  attention: "decide",
  title,
});

/**
 * Imports a valid plan: a goal waiting at a checkpoint, its nodes, and the integration branch with the
 * plan and the goal memory committed. Into an existing goal (the decomposer's plan), only the nodes.
 */
export async function importPlan(state: string, plan: Plan, into?: Job): Promise<Job> {
  const slug = into?.goal?.slug ?? slugOf(plan);
  const goal: Goal = into?.goal ?? {
    repo: plan.goal.repo,
    slug,
    summary: plan.goal.summary,
    gates: plan.goal.gates,
    budget: plan.goal.budget,
    allowUp: plan.goal.allowUp ?? false,
    replanTier: plan.goal.replanTier,
  };
  if (
    !into &&
    readJobs(state).some(
      (job) => job.goal?.slug === slug && job.goal.repo === goal.repo && job.state !== "removed",
    )
  )
    throw new Error(`a goal ${slug} already exists in ${goal.repo}`);
  const job =
    into ??
    addJob(state, {
      id: newId(),
      item: goalItem(goal.repo, `goal/${slug}`, "goal", plan.goal.title),
      source: "goal",
      goal,
    });
  if (!into) {
    checkpoint(state, job.id, planReady(plan));
    await createBranch(goal);
  }
  await commitFiles(goal, `factory: plan for ${plan.goal.title}`, {
    [planPath(slug)]: `${JSON.stringify(plan, null, 2)}\n`,
    ...(into
      ? {}
      : {
          [memoryPath(slug)]:
            `# ${plan.goal.title}\n\n${plan.goal.summary.trim()}\n\n## Decisions\n`,
        }),
  });
  addNodes(state, job, plan.nodes);
  return job;
}

/** The plan's nodes as jobs of the goal; keys become ids in `after` and `parent`, known ones kept. */
function addNodes(
  state: string,
  goal: Job,
  nodes: PlanNode[],
  known = new Map<string, string>(),
): void {
  const ids = new Map(known);
  for (const node of nodes) ids.set(node.key, ids.get(node.key) ?? newId());
  for (const node of nodes)
    addJob(state, { id: ids.get(node.key)!, ...nodeFields(goal, node, ids) });
}

function nodeFields(goal: Job, node: PlanNode, ids: Map<string, string>): Omit<NewJob, "id"> {
  return {
    item: goalItem(goal.goal!.repo, node.key, "goal", node.title),
    source: "goal",
    of: goal.id,
    key: node.key,
    tier: node.tier,
    prompt: node.prompt ?? "",
    after: node.after.map((key) => ids.get(key)!),
    parent: node.parent ? ids.get(node.parent) : undefined,
    gates: node.gates ?? [],
    touches: node.touches ?? [],
    needs: node.needs ?? [],
    checkpoint: node.checkpoint || undefined,
    review: node.review,
  };
}

/** Creates goal/<slug> on origin from origin's default branch. */
async function createBranch(goal: Goal): Promise<void> {
  const head = await originHead(goal.repo);
  await output(
    "git",
    ["push", "--quiet", "origin", `refs/remotes/origin/${head}:refs/heads/${integration(goal)}`],
    goal.repo,
  );
}

/** Commits files onto the integration branch from a scratch worktree, and pushes. */
async function commitFiles(
  goal: Goal,
  message: string,
  files: Record<string, string>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "factory-goal-"));
  const git = (...args: string[]) => output("git", args, dir);
  try {
    await output("git", ["fetch", "--quiet", "origin"], goal.repo);
    await output(
      "git",
      ["worktree", "add", "--quiet", "--detach", dir, `origin/${integration(goal)}`],
      goal.repo,
    );
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    await git("add", "-A");
    await git("commit", "--quiet", "--no-verify", "-m", message);
    await git("push", "--quiet", "origin", `HEAD:${integration(goal)}`);
  } finally {
    await output("git", ["worktree", "remove", "--force", dir], goal.repo).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `factory goal new`: a goal with one job for the communicator, to decompose it; it waits for approval once the plan is in. */
export async function newGoal(
  state: string,
  title: string,
  repo: string,
  brief: string,
): Promise<Job> {
  if (!existsSync(join(repo, ".git"))) throw new Error(`${repo} is not a git repository`);
  const summary = brief.trim() || title;
  const slug = slugOf({
    format: PLAN_FORMAT,
    goal: { title, repo, summary, gates: [] },
    nodes: [],
  });
  if (
    readJobs(state).some(
      (job) => job.goal?.slug === slug && job.goal.repo === repo && job.state !== "removed",
    )
  )
    throw new Error(`a goal ${slug} already exists in ${repo}`);
  const goal: Goal = { repo, slug, summary, gates: [], allowUp: false };
  const job = addJob(state, {
    id: newId(),
    item: goalItem(repo, `goal/${slug}`, "goal", title),
    source: "goal",
    goal,
  });
  await createBranch(goal);
  await commitFiles(goal, `factory: goal ${title}`, {
    [memoryPath(slug)]: `# ${title}\n\n${summary}\n\n## Decisions\n`,
  });
  addJob(state, {
    id: newId(),
    item: goalItem(repo, DECOMPOSE, DECOMPOSE, `Decompose: ${title}`),
    source: "goal",
    of: job.id,
    tier: "communicator",
    front: true,
    prompt: decomposePrompt(title, repo, slug, brief),
  });
  return job;
}

const TIER_RUBRIC = `Pick the lowest tier that will get each node right; tiers are the main lever on cost.
- communicator (the most capable and most limited model): the decomposition itself, UX and visual design, user-facing copy, anything the user judges by taste.
- builder (intelligent and thorough, not a great communicator): architecture, foundations other nodes build on, tricky logic, reviews.
- grunt (follows a detailed spec, little judgment, very cheap): anything a detailed prompt makes mechanical, like porting a spec'd component, writing tests from a spec, wiring, renames. Writing a grunt prompt in more detail is cheaper than running the node on a higher tier.`;

const PLAN_SPEC = `A plan is JSON:
{
  "format": "${PLAN_FORMAT}",
  "goal": { "title", "repo" (absolute path), "summary" (markdown: what done looks like, constraints, links), "gates": [commands run on the integration branch after every merge], "budget"?: { "attempts": N }, "allowUp"?: bool },
  "nodes": [{
    "key": unique, lowercase, "title", "tier": "communicator" | "builder" | "grunt",
    "prompt": markdown, self-contained: what to build, where, how to verify, what not to touch,
    "after": [keys it depends on], "touches": [globs of files it changes; empty means anything, so it runs alone],
    "gates": [commands run in its worktree before it merges], "needs"?: ["display" | "gpu" | ...],
    "checkpoint"?: true to pause the goal for the user's approval once it's done,
    "parent"?: a key, which makes that node a milestone (a milestone's nodes wait for what it comes after; never list your own milestone in after), "review"?: a tier that reviews it before it merges
  }]
}
A milestone never runs: give it only "key", "title" and "after".
Rules: keys unique, no cycles, every reference resolves; every node that runs has a tier, a non-empty prompt, and touches and gates (may be empty lists). Nodes whose touches overlap never run at the same time, so precise touches buy parallelism. Each node should fit comfortably in one session of its tier (under about 200k tokens of context).`;

function decomposePrompt(title: string, repo: string, slug: string, brief: string): string {
  return `Decompose this goal into a plan of nodes for factory, which runs them with coding agents of three tiers, in parallel where the dependencies allow.

# ${title}

Repo: ${repo}

${brief || "(no brief beyond the title)"}

## The plan format

${PLAN_SPEC}

## Tiers

${TIER_RUBRIC}

## What to do

Read the repo enough to plan well. Write the plan to \`${planPath(slug)}\` in this folder, with goal.repo "${repo}" and goal.branch "goal/${slug}". Don't commit it: factory validates it, imports it and shows it to the user for approval. Prefer more, smaller nodes with precise touches over a few big ones, put the foundations first, and give each node gates that prove it works (build, tests, lint). A plan has nothing for the user to check by hand, so don't pass \`--unverified\`; say what you're unsure of in your result.`;
}

/** Checks factory itself runs after the agent says it's done, before the job's gates: the plan files. */
export function builtinCheck(job: Job, jobs: Job[], worktree: string): string | undefined {
  const goal = jobs.find((each) => each.id === job.of)?.goal;
  if (!goal || (job.item.blueprint !== DECOMPOSE && job.item.blueprint !== REPLAN))
    return undefined;
  const path = join(
    worktree,
    job.item.blueprint === DECOMPOSE ? planPath(goal.slug) : replanPath(goal.slug),
  );
  if (!existsSync(path)) return `There's no plan at ${path}. Write it there.`;
  let plan: unknown;
  try {
    plan = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return `${path} isn't valid JSON: ${(error as Error).message}`;
  }
  const problems = [
    ...checkPlan(plan),
    ...(job.item.blueprint === REPLAN ? replanProblems(plan as Plan, job, jobs) : []),
  ];
  if (problems.length)
    return `The plan at ${path} has problems; fix them all:\n${problems.map((each) => `- ${each}`).join("\n")}`;
}

/** The prompt for a job: workwork's, or a goal node's with its goal, memory and dependencies; checks out its worktree. */
export async function prepare(
  state: string,
  job: Job,
  jobs: Job[],
  worktree: string,
  workwork: string,
): Promise<string> {
  const goalJob = jobs.find((each) => each.id === job.of);
  if (!goalJob?.goal) {
    const head = await originHead(job.item.repo);
    await checkout(worktree, job.item.repo, `origin/${head}`);
    return job.prompt ?? (await output(workwork, ["prompt", job.item.id], job.item.repo));
  }
  const goal = goalJob.goal;
  const branch = branchFor(job, jobs, goal);
  await output("git", ["fetch", "--quiet", "origin"], goal.repo);
  const remote = await output("git", ["ls-remote", "--heads", "origin", branch], goal.repo);
  await checkout(
    worktree,
    goal.repo,
    remote.trim() ? `origin/${branch}` : `origin/${integration(goal)}`,
  );
  await output("git", ["checkout", "--quiet", "-B", branch], worktree);
  if (job.item.blueprint === DECOMPOSE || job.item.blueprint === REVIEW) return job.prompt!;
  if (job.item.blueprint === REPLAN) return job.prompt!;
  return nodePrompt(job, jobs, goalJob, branch);
}

/** The branch a goal job works on: its own, or for factory's helpers the one they serve. */
function branchFor(job: Job, jobs: Job[], goal: Goal): string {
  const served = job.branchOf && jobs.find((each) => each.id === job.branchOf);
  if (served) return nodeBranch(goal, served.key!);
  return nodeBranch(goal, job.key ?? `${job.item.blueprint}-${job.id}`);
}

function nodePrompt(job: Job, jobs: Job[], goalJob: Job, branch: string): string {
  const goal = goalJob.goal!;
  const deps = job.after.flatMap((id) => {
    const dep = jobs.find((each) => each.id === id);
    if (!dep) return [];
    const said = dep.notes.findLast((note) => note.kind === "result");
    return [
      `- ${dep.item.title}${said ? `: ${said.text}` : ""}${prUrl(dep) ? ` (${prUrl(dep)})` : ""}`,
    ];
  });
  return `# ${goalJob.item.title}: ${job.item.title}

${job.prompt}

## The goal

${goal.summary}

Read \`${memoryPath(goal.slug)}\` first: the goal's memory, with the decisions, conventions and traps earlier nodes left. When you commit, append to it what the next node needs to know. The whole plan is in \`${planPath(goal.slug)}\`; read it, but leave it to factory.
${deps.length ? `\n## What this builds on\n\n${deps.join("\n")}\n` : ""}
## How to deliver

You're on branch \`${branch}\`, started from the goal's integration branch \`${integration(goal)}\`. Commit your work there and push it with \`git push -u origin ${branch}\`. Don't open a pull request: factory runs the checks below when you stop, opens it and merges it.
${job.gates.length ? `\nChecks: ${job.gates.map((gate) => `\`${gate}\``).join(", ")}\n` : ""}${job.touches?.length ? `\nOther nodes work in parallel; keep your changes to ${job.touches.map((glob) => `\`${glob}\``).join(", ")}.\n` : ""}`;
}

type Log = (message: string) => void;

/**
 * What follows an attempt of a goal job: a done node's branch merges into the integration branch,
 * a decomposer's plan is imported, a replan applied, a review's findings become a fix; a node failed
 * for good queues a replan; the goal's budget is checked. Runs in the attempt's worktree.
 */
export async function afterAttempt(
  state: string,
  id: string,
  worktree: string,
  log: Log,
): Promise<void> {
  const jobs = readJobs(state);
  const job = jobs.find((each) => each.id === id)!;
  const goalJob = jobs.find((each) => each.id === job.of);
  if (!goalJob?.goal) return;
  try {
    if (job.state === "failed")
      queueReplan(
        state,
        goalJob,
        `${job.item.title} failed for good: ${job.attempts.at(-1)?.error ?? "see its notes"}`,
      );
    else if (job.attempts.at(-1)?.outcome === "done")
      await delivered(state, job, jobs, goalJob, worktree, log);
    checkBudget(state, goalJob.id);
  } catch (error) {
    const message = (error as Error).message.trim().split("\n").slice(0, 5).join("\n");
    log(`goal ${goalJob.goal.slug}: ${job.id} didn't deliver: ${message}`);
    record(state, {
      type: "note",
      id: job.id,
      note: { kind: "factory", text: `delivery failed: ${message}` },
    });
  }
}

async function delivered(
  state: string,
  job: Job,
  jobs: Job[],
  goalJob: Job,
  worktree: string,
  log: Log,
): Promise<void> {
  const goal = goalJob.goal!;
  const blueprint = job.item.blueprint;
  if (blueprint === DECOMPOSE) {
    const plan = JSON.parse(readFileSync(join(worktree, planPath(goal.slug)), "utf8")) as Plan;
    const { summary, gates, budget, allowUp, replanTier } = plan.goal;
    record(state, {
      type: "update",
      id: goalJob.id,
      change: { goal: { ...goal, summary, gates, budget, allowUp: allowUp ?? false, replanTier } },
    });
    // Before the nodes land, so none of them starts before the user approves.
    checkpoint(state, goalJob.id, planReady(plan));
    await importPlan(state, plan, goalJob);
    record(state, { type: "merged", id: job.id });
    return;
  }
  if (blueprint === REPLAN) return applyReplan(state, job, jobs, goalJob, worktree);
  if (blueprint === MAIN) {
    // Its branch is the integration branch moved onto main, so it replaces it.
    await output(
      "git",
      ["push", "--quiet", "--force", "origin", `HEAD:${integration(goal)}`],
      worktree,
    );
    record(state, { type: "merged", id: job.id });
    return afterMerge(state, job, goalJob.id, worktree, log);
  }
  const served = job.branchOf ? jobs.find((each) => each.id === job.branchOf)! : job;
  if (blueprint === REVIEW) {
    const findings = job.notes.findLast((note) => note.kind === "result")?.followups ?? [];
    record(state, { type: "merged", id: job.id });
    if (findings.length === 0) return merge(state, served, goalJob, worktree, log);
    addJob(
      state,
      helper(
        served,
        goalJob,
        FIX,
        `Fix review findings: ${served.item.title}`,
        served.tier!,
        `A review of branch \`${nodeBranch(goal, served.key!)}\` found:\n\n${findings.map((each) => `- ${each}`).join("\n")}\n\nFix each one on that branch (it's checked out here), run the checks, commit and push. Don't open a pull request, and keep what the branch added to the goal memory, \`${memoryPath(goal.slug)}\`.\n\nThe original task:\n\n${served.prompt}`,
      ),
    );
    return;
  }
  if (
    served === job &&
    job.review &&
    !jobs.some((each) => each.branchOf === job.id && each.item.blueprint === REVIEW)
  ) {
    await output(
      "git",
      ["push", "--quiet", "--force-with-lease", "origin", `HEAD:${nodeBranch(goal, job.key!)}`],
      worktree,
    );
    addJob(
      state,
      helper(
        job,
        goalJob,
        REVIEW,
        `Review: ${job.item.title}`,
        job.review,
        reviewPrompt(job, goal),
      ),
    );
    return;
  }
  return merge(state, served, goalJob, worktree, log, job === served ? undefined : job);
}

/** One of factory's jobs for a node's branch, at the front of the goal. */
function helper(
  node: Job,
  goalJob: Job,
  blueprint: string,
  title: string,
  tier: Tier,
  prompt: string,
): NewJob {
  return {
    id: newId(),
    item: goalItem(
      goalJob.goal!.repo,
      `${node.key ?? node.item.id}+${blueprint}`,
      blueprint,
      title,
    ),
    source: "goal",
    of: goalJob.id,
    parent: node.parent,
    branchOf: node.id,
    tier,
    front: true,
    prompt,
    gates: blueprint === REVIEW ? [] : node.gates,
    touches: node.touches,
    needs: node.needs,
  };
}

function reviewPrompt(job: Job, goal: Goal): string {
  return `Review the work on branch \`${nodeBranch(goal, job.key!)}\` (checked out here) against its task below, before factory merges it into \`${integration(goal)}\`. See the change with \`git diff origin/${integration(goal)}...HEAD\`.

1. Run its checks${job.gates.length ? ` (${job.gates.map((gate) => `\`${gate}\``).join(", ")})` : ""} and read the change against the task.
2. Look for bugs, missed cases and changes nobody asked for. Skip style the linters already cover. Additions to the goal memory, \`${memoryPath(goal.slug)}\`, are expected: every node records its decisions there. A change to the plan, \`${planPath(goal.slug)}\`, is a finding.
3. Report with \`factory result "<summary>"\`, adding \`--followup "<finding: file, line, why it matters>"\` for each finding worth fixing. No findings: no --followup. Don't change or push anything.

## The task

${job.prompt}`;
}

/**
 * Merges a node's branch into the integration branch from the worktree that has it checked out:
 * rebase onto the integration head, gates again, push, factory's PR, fast-forward. A rebase that
 * stops on conflicts queues a conflicts job instead; red goal gates pause the goal and queue a fix.
 */
async function merge(
  state: string,
  node: Job,
  goalJob: Job,
  worktree: string,
  log: Log,
  by?: Job,
): Promise<void> {
  const goal = goalJob.goal!;
  const git = (...args: string[]) => output("git", args, worktree);
  const branch = nodeBranch(goal, node.key ?? `${node.item.blueprint}-${node.id}`);
  const base = integration(goal);
  for (let tries = 0; ; tries++) {
    await git("fetch", "--quiet", "origin");
    try {
      await git("rebase", "--quiet", `origin/${base}`);
    } catch {
      await git("rebase", "--abort").catch(() => undefined);
      await git("push", "--quiet", "--force-with-lease", "origin", `HEAD:${branch}`);
      addJob(
        state,
        helper(
          node,
          goalJob,
          CONFLICTS,
          `Resolve conflicts: ${node.item.title}`,
          node.tier ?? "builder",
          `Branch \`${branch}\` (checked out here) no longer rebases cleanly onto \`origin/${base}\`. Rebase it, resolving each conflict so the intent of both sides survives (read the commits on both sides first), run the checks, and push with \`git push --force-with-lease origin ${branch}\`. Don't open a pull request.\n\nThe branch's task:\n\n${node.prompt}`,
        ),
      );
      log(`goal ${goal.slug}: ${node.key} conflicts with ${base}`);
      return;
    }
    const failed = await gatesFail(node.gates, worktree);
    if (failed) {
      addJob(
        state,
        helper(
          node,
          goalJob,
          FIX,
          `Fix after rebase: ${node.item.title}`,
          node.tier ?? "builder",
          `Branch \`${branch}\` (checked out here) fails \`${failed.gate}\` after rebasing onto \`origin/${base}\`:\n\n\`\`\`\n${failed.output}\n\`\`\`\n\nRebase it onto \`origin/${base}\` again, fix it, commit and push with \`git push --force-with-lease origin ${branch}\`. Don't open a pull request.`,
        ),
      );
      return;
    }
    await git("push", "--quiet", "--force-with-lease", "origin", `HEAD:${branch}`);
    try {
      await git("push", "--quiet", "origin", `HEAD:${base}`);
      break;
    } catch (error) {
      // Another node merged meanwhile: rebase onto it and try again.
      if (tries >= 3) throw error;
    }
  }
  const said = (by ?? node).notes.findLast((note) => note.kind === "result");
  const url =
    node.item.blueprint === MAIN
      ? undefined
      : await createPr(
          goal.repo,
          base,
          branch,
          `${node.item.title}`,
          `${said?.text ?? node.item.title}\n\nPart of goal ${goalJob.item.title}; factory merged it into ${base}.`,
        ).catch(() => undefined);
  record(state, {
    type: "note",
    id: node.id,
    note: { kind: "factory", text: `merged into ${base}`, url },
  });
  record(state, { type: "merged", id: node.id });
  if (by) record(state, { type: "merged", id: by.id });
  log(`goal ${goal.slug}: merged ${node.key ?? node.item.id}`);
  await remember(goal, node, worktree);
  await afterMerge(state, node, goalJob.id, worktree, log);
}

/** Factory's notes on the node go into the goal memory, in a commit of its own. */
async function remember(goal: Goal, node: Job, worktree: string): Promise<void> {
  const said = node.notes.filter(
    (note) => note.kind === "factory" && !note.text.startsWith("merged"),
  );
  if (said.length === 0) return;
  const path = join(worktree, memoryPath(goal.slug));
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const heading = before.includes("## Factory notes") ? "" : "\n## Factory notes\n";
  writeFileSync(
    path,
    `${before.trimEnd()}\n${heading}${said.map((note) => `- ${node.key ?? node.item.id}: ${note.text}`).join("\n")}\n`,
  );
  await output(
    "git",
    ["commit", "--quiet", "--no-verify", "-am", `factory: notes on ${node.key ?? node.item.id}`],
    worktree,
  );
  await output("git", ["push", "--quiet", "origin", `HEAD:${integration(goal)}`], worktree);
}

/** After a merge: the goal's gates, checkpoints, milestones, a red goal turning green, the final PR. */
async function afterMerge(
  state: string,
  node: Job,
  goalId: string,
  worktree: string,
  log: Log,
): Promise<void> {
  const jobs = readJobs(state);
  const goalJob = jobs.find((each) => each.id === goalId)!;
  const goal = goalJob.goal!;
  const failed = await gatesFail(goal.gates, worktree);
  if (failed) {
    record(state, { type: "block", id: goalId, reason: "red" });
    record(state, {
      type: "note",
      id: goalId,
      note: {
        kind: "factory",
        text: `${integration(goal)} fails \`${failed.gate}\` after merging ${node.key}`,
      },
    });
    addJob(state, {
      id: newId(),
      item: goalItem(
        goal.repo,
        `${RED}-${newId()}`,
        RED,
        `Fix ${integration(goal)}: ${failed.gate}`,
      ),
      source: "goal",
      of: goalId,
      tier: "builder",
      front: true,
      prompt: `The goal's integration branch \`${integration(goal)}\` fails \`${failed.gate}\` after merging "${node.item.title}":\n\n\`\`\`\n${failed.output}\n\`\`\`\n\nFix it on this branch (started from the integration branch), commit and push. Don't open a pull request; factory merges it and runs the goal's checks again.`,
      gates: goal.gates,
      touches: [],
    });
    log(`goal ${goal.slug} is red: ${failed.gate}`);
    return;
  }
  if (goalJob.state === "blocked" && goalJob.blocked === "red")
    record(state, { type: "unblock", id: goalId });
  if (node.checkpoint)
    checkpoint(
      state,
      goalId,
      `${node.item.title} is merged into ${integration(goal)}, and the plan stops here so you can check it. Approving starts the rest`,
    );
  const parent = node.parent && readJobs(state).find((each) => each.id === node.parent);
  if (parent && parent.state === "done") {
    await rebaseOntoMain(state, goalJob, worktree, log);
    queueReplan(state, goalJob, `milestone ${parent.item.title} is done`);
  }
  const rest = readJobs(state).filter((each) => each.of === goalId && each.state !== "removed");
  if (rest.length > 0 && rest.every((each) => each.state === "done")) {
    const main = await originHead(goal.repo);
    const unverified = rest.flatMap((each) =>
      each.unverified.map((need) => `- [ ] ${each.item.title}: ${need}`),
    );
    const url = await createPr(
      goal.repo,
      main,
      integration(goal),
      goalJob.item.title,
      `${goal.summary}\n${unverified.length ? `\n## Unverified\n\n${unverified.join("\n")}\n` : ""}\nFactory worked this goal; merging it is yours.`,
    );
    record(state, {
      type: "note",
      id: goalId,
      note: { kind: "factory", text: `every node is done; the final PR is open`, url },
    });
    record(state, { type: "merged", id: goalId });
    log(`goal ${goal.slug} is done: ${url}`);
  }
}

/** At a milestone the integration branch moves onto main, so it never drifts far; conflicts go to a builder. */
async function rebaseOntoMain(
  state: string,
  goalJob: Job,
  worktree: string,
  log: Log,
): Promise<void> {
  const goal = goalJob.goal!;
  const git = (...args: string[]) => output("git", args, worktree);
  const main = await originHead(goal.repo);
  await git("checkout", "--quiet", "--detach", `origin/${integration(goal)}`);
  try {
    await git("rebase", "--quiet", `origin/${main}`);
    await git("push", "--quiet", "--force-with-lease", "origin", `HEAD:${integration(goal)}`);
  } catch {
    await git("rebase", "--abort").catch(() => undefined);
    addJob(state, {
      id: newId(),
      item: goalItem(
        goal.repo,
        `${MAIN}-${newId()}`,
        MAIN,
        `Rebase ${integration(goal)} onto ${main}`,
      ),
      source: "goal",
      of: goalJob.id,
      tier: "builder",
      front: true,
      prompt: `The goal's integration branch \`${integration(goal)}\` no longer rebases cleanly onto \`origin/${main}\`. On this branch (started from it), rebase onto \`origin/${main}\`, resolving each conflict so the intent of both sides survives, run the checks, commit and push. Don't open a pull request; factory moves the integration branch to your branch.`,
      gates: goal.gates,
      touches: [],
    });
    log(`goal ${goal.slug}: ${integration(goal)} conflicts with ${main}`);
  }
}

async function gatesFail(
  gates: string[],
  cwd: string,
): Promise<{ gate: string; output: string } | undefined> {
  for (const gate of gates) {
    try {
      await output("sh", ["-c", gate], cwd);
    } catch (error) {
      const text = `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}`;
      return { gate, output: text.split("\n").slice(-200).join("\n") || (error as Error).message };
    }
  }
}

/** Queues a replan of the goal, unless one waits already. */
export function queueReplan(state: string, goalJob: Job, why: string): Job | undefined {
  const jobs = readJobs(state);
  if (
    jobs.some(
      (each) =>
        each.of === goalJob.id &&
        each.item.blueprint === REPLAN &&
        ["queued", "running"].includes(each.state),
    )
  )
    return undefined;
  const goal = goalJob.goal!;
  return addJob(state, {
    id: newId(),
    item: goalItem(goal.repo, `${REPLAN}-${newId()}`, REPLAN, `Replan: ${goalJob.item.title}`),
    source: "goal",
    of: goalJob.id,
    tier: goal.replanTier ?? "builder",
    front: true,
    prompt: replanPrompt(goalJob, jobs, why),
  });
}

function replanPrompt(goalJob: Job, jobs: Job[], why: string): string {
  const goal = goalJob.goal!;
  const nodes = jobs.filter((each) => each.of === goalJob.id && each.key);
  const keyOf = (id: string) => jobs.find((each) => each.id === id)?.key ?? id;
  const state = nodes.map((node) => ({
    key: node.key,
    title: node.item.title,
    state: node.state,
    tier: node.tier,
    after: node.after.map(keyOf),
    parent: node.parent ? keyOf(node.parent) : undefined,
    attempts: node.attempts.map((attempt) => ({
      outcome: attempt.outcome,
      peak: attempt.peak,
      compactions: attempt.compactions,
      error: attempt.error?.split("\n")[0],
    })),
    heavy: node.attempts.some((attempt) => (attempt.compactions ?? 0) > 2) || undefined,
    result: node.notes.findLast((note) => note.kind === "result")?.text,
  }));
  return `Replan the goal "${goalJob.item.title}" because ${why}.

## The goal

${goal.summary}

## Where it stands

\`\`\`json
${JSON.stringify(state, null, 2)}
\`\`\`

Nodes marked heavy compacted their context more than twice: split similar work smaller. The current plan is \`${planPath(goal.slug)}\` on this branch.

## What to do

Write the whole plan, as it should be from now on, to \`${replanPath(goal.slug)}\` in this folder (don't commit it). Keep every node that is done, running, or waiting to merge exactly as it is now. You may add nodes and change or drop those that haven't started. Changing or dropping more than a quarter of the unstarted ones stops the goal for the user's approval. A plan has nothing for the user to check by hand, so don't pass \`--unverified\`; say what you're unsure of in your result.

${PLAN_SPEC}

${TIER_RUBRIC}`;
}

/** Done, running and merging nodes are fixed; a replan has to keep them as they are. */
function replanProblems(plan: Plan, job: Job, jobs: Job[]): string[] {
  const nodes = jobs.filter((each) => each.of === job.of && each.key);
  const planned = new Map((plan.nodes ?? []).map((node) => [node.key, node]));
  const keyOf = (id: string) => jobs.find((each) => each.id === id)?.key ?? id;
  return nodes.flatMap((node) => {
    if (!started(node)) return [];
    const now = planned.get(node.key!);
    if (!now) return [`${node.key} is ${node.state} and has to stay in the plan`];
    const same =
      (now.prompt ?? "") === node.prompt &&
      now.tier === node.tier &&
      JSON.stringify([...now.after].sort()) === JSON.stringify(node.after.map(keyOf).sort());
    return same
      ? []
      : [`${node.key} is ${node.state}; its prompt, tier and after have to stay as they are`];
  });
}

const started = (node: Job) =>
  node.state !== "queued" && !(node.state === "blocked" && node.blocked === "held");

function applyReplan(state: string, job: Job, jobs: Job[], goalJob: Job, worktree: string): void {
  const goal = goalJob.goal!;
  const plan = JSON.parse(readFileSync(join(worktree, replanPath(goal.slug)), "utf8")) as Plan;
  const nodes = jobs.filter((each) => each.of === goalJob.id && each.key);
  const byKey = new Map(nodes.map((node) => [node.key!, node]));
  const ids = new Map(nodes.map((node) => [node.key!, node.id]));
  for (const node of plan.nodes) ids.set(node.key, ids.get(node.key) ?? newId());
  const unstarted = nodes.filter((node) => !started(node) && node.state !== "removed");
  let changed = 0;
  for (const node of unstarted)
    if (!plan.nodes.some((each) => each.key === node.key)) {
      record(state, { type: "remove", id: node.id });
      changed++;
    }
  for (const planned of plan.nodes) {
    const existing = byKey.get(planned.key);
    if (!existing) continue;
    if (started(existing)) continue;
    const fields = nodeFields(goalJob, planned, ids);
    const change: Change = {};
    for (const field of [
      "item",
      "tier",
      "prompt",
      "after",
      "parent",
      "gates",
      "touches",
      "needs",
      "checkpoint",
      "review",
    ] as const)
      if (JSON.stringify(fields[field]) !== JSON.stringify(existing[field]))
        (change as Record<string, unknown>)[field] = fields[field];
    if (Object.keys(change).length) {
      record(state, { type: "update", id: existing.id, change });
      changed++;
    }
  }
  addNodes(
    state,
    goalJob,
    plan.nodes.filter((node) => !byKey.has(node.key)),
    ids,
  );
  record(state, { type: "merged", id: job.id });
  const note = `replanned: ${plan.nodes.filter((node) => !byKey.has(node.key)).length} new, ${changed} changed or dropped`;
  record(state, { type: "note", id: goalJob.id, note: { kind: "factory", text: note } });
  if (changed > unstarted.length / 4)
    checkpoint(
      state,
      goalJob.id,
      "the replan changed more than a quarter of what's left; approve it to go on",
    );
}

const planReady = (plan: Plan) =>
  `the plan has ${plan.nodes.length} jobs, shown below. Approving starts them, and nothing runs until then; replan first if it needs changes`;

/** Stops the goal for the user's approval, saying why on the goal and in its notes. */
function checkpoint(state: string, id: string, why: string): void {
  record(state, { type: "block", id, reason: "checkpoint", why });
  record(state, { type: "note", id, note: { kind: "factory", text: why } });
}

/** At its attempt budget a goal waits at a checkpoint; approving gives it the same budget again. */
function checkBudget(state: string, goalId: string): void {
  const jobs = readJobs(state);
  const goalJob = jobs.find((each) => each.id === goalId)!;
  const budget = goalJob.goal!.budget?.attempts;
  if (!budget || goalJob.state === "blocked" || goalJob.state === "done") return;
  const used = attemptsUsed(jobs, goalId);
  const allowed =
    budget *
    (1 +
      goalJob.notes.filter(
        (note) => note.kind === "factory" && note.text.startsWith("budget raised"),
      ).length);
  if (used < allowed) return;
  checkpoint(
    state,
    goalId,
    `the goal used ${used} of its ${allowed} attempts. Approving gives it ${budget} more; pause or cancel it if it's going nowhere`,
  );
}

const attemptsUsed = (jobs: Job[], goalId: string) =>
  jobs.filter((each) => each.of === goalId).reduce((sum, each) => sum + each.attempts.length, 0);

/** The user's go: after the plan, a checkpoint or a used budget. */
export function approveGoal(state: string, goalId: string): void {
  const goalJob = findGoal(state, goalId);
  if (goalJob.state !== "blocked" || goalJob.blocked !== "checkpoint")
    throw new Error(`goal ${goalId} isn't waiting for approval`);
  const budget = goalJob.goal!.budget?.attempts;
  const allowed = budget
    ? budget * (1 + goalJob.notes.filter((note) => note.text.startsWith("budget raised")).length)
    : Infinity;
  if (budget && attemptsUsed(readJobs(state), goalId) >= allowed)
    record(state, {
      type: "note",
      id: goalId,
      note: { kind: "factory", text: `budget raised by ${budget}` },
    });
  record(state, { type: "unblock", id: goalId });
}

export function pauseGoal(state: string, goalId: string): void {
  findGoal(state, goalId);
  record(state, { type: "block", id: goalId, reason: "paused" });
}

export function resumeGoal(state: string, goalId: string): void {
  const goalJob = findGoal(state, goalId);
  if (goalJob.blocked !== "paused") throw new Error(`goal ${goalId} isn't paused`);
  record(state, { type: "unblock", id: goalId });
}

/** Removes the goal and everything under it that hasn't finished; running agents finish their turn. */
export function cancelGoal(state: string, goalId: string): void {
  findGoal(state, goalId);
  for (const job of readJobs(state))
    if (
      job.of === goalId &&
      job.state !== "done" &&
      job.state !== "removed" &&
      job.state !== "running"
    )
      record(state, { type: "remove", id: job.id });
  record(state, { type: "remove", id: goalId });
}

export function findGoal(state: string, idOrSlug: string): Job {
  const goalJob = readJobs(state).find(
    (job) =>
      job.goal && (job.id === idOrSlug || job.goal.slug === idOrSlug) && job.state !== "removed",
  );
  if (!goalJob) throw new Error(`no goal ${idOrSlug}; factory goal show lists them`);
  return goalJob;
}

/** The graph as `goal show` prints it: layers by dependency depth, states, tiers, the critical path. */
export function showGoal(jobs: Job[], goalJob: Job): string {
  const nodes = jobs.filter((job) => job.of === goalJob.id && job.state !== "removed");
  const path = critical(nodes);
  const depth = depths(nodes);
  const lines = [
    `${goalJob.item.title} (${goalJob.goal!.slug}) ${goalJob.state}${goalJob.blocked ? `: ${goalJob.blocked}` : ""}`,
    `  ${nodes.filter((node) => node.state === "done").length}/${nodes.length} done, ${attemptsUsed(jobs, goalJob.id)}${goalJob.goal!.budget ? `/${goalJob.goal!.budget.attempts}` : ""} attempts, branch goal/${goalJob.goal!.slug}`,
    `  estimate: ${TIERS.map((tier) => `${nodes.filter((node) => node.tier === tier && node.state !== "done").length} ${tier}`).join(", ")} attempts to go`,
  ];
  for (const layer of [...new Set(depth.values())].sort((a, b) => a - b)) {
    lines.push(`  layer ${layer}`);
    for (const node of nodes.filter((each) => depth.get(each.id) === layer)) {
      const onPath = path.has(node.id) ? " *" : "";
      const heavy = node.attempts.some((attempt) => (attempt.compactions ?? 0) > 2) ? " heavy" : "";
      lines.push(
        `    ${node.id} ${(node.key ?? node.item.id).padEnd(24)} ${(node.tier ?? "").padEnd(12)} ${node.state}${node.blocked ? `:${node.blocked}` : ""}${heavy}${onPath}`,
      );
    }
  }
  const unverified = nodes.flatMap((node) =>
    node.unverified.map((need) => `  [ ] ${node.item.title}: ${need}`),
  );
  if (unverified.length) lines.push("unverified:", ...unverified);
  const assumed = nodes.flatMap((node) =>
    node.notes
      .filter((note) => note.kind === "assume")
      .map((note) => `  ${node.item.title}: assumed ${note.assumed}, asked ${note.text}`),
  );
  if (assumed.length) lines.push("assumptions:", ...assumed);
  lines.push("  * on the critical path");
  return lines.join("\n");
}

/** Reads a plan file for import or check. */
export function readPlan(file: string): unknown {
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`no plan file ${file}`);
  return parsePlan(readFileSync(file, "utf8"), file);
}

/** A pasted plan, JSON or YAML (YAML reads both), imported once it's valid. */
export async function importPlanText(state: string, text: string): Promise<Job> {
  const plan = parseYaml(text);
  const problems = checkPlan(plan);
  if (problems.length)
    throw new Error(`the plan has problems:\n${problems.map((each) => `- ${each}`).join("\n")}`);
  return importPlan(state, plan as Plan);
}

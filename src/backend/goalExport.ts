import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { originHead } from "./git.ts";
import { integration, memoryPath, planPath, replanPath, showGoal } from "./goals.ts";
import { readEvents, readJobs } from "./jobs.ts";
import { output, readSettings } from "./state.ts";
import type { Job } from "./types.ts";

const REVIEW = `# Goal export

Everything factory knows about one goal, so you can judge whether the process worked: how the goal
was broken into jobs, how those jobs ran, and where it went wrong or took longer than it should have.

## What's here

- \`summary.txt\`: the graph as \`factory goal show\` prints it.
- \`goal.json\`: the goal job, as factory sees it now.
- \`jobs.json\`: every job under the goal (nodes, the decomposer, replans, reviews, fixes,
  conflict jobs), removed ones included, with their attempts and notes.
- \`events.jsonl\`: the raw event log for these jobs, in order. \`jobs.json\` is what replaying it gives.
- \`attempts/<job>-<n>/\`: each attempt's folder: \`prompt.md\` (what the agent was told),
  \`turn-<n>.md\` (what factory said in later turns), \`agent.log\` (the agent's output).
- \`repo/\`: from the goal's integration branch: \`memory.md\` (decisions the nodes left for each
  other), \`plan.json\` (the plan), \`replan.json\` if there was one, and \`git-log.txt\` (its commits).
  \`missing.txt\` lists what wasn't there.
- \`prs/<number>.json\` and \`.diff\`: each PR the goal opened, with comments and reviews;
  \`.error.txt\` when GitHub couldn't be asked.
- \`settings.json\`: factory's settings at export time, with env values left out.

## What to look for

- The plan: jobs too big or too small for their tier, missing or needless dependencies, \`touches\`
  that didn't match what the job changed, gates that couldn't catch the real problems.
- Runs: failures, timeouts, retries and escalations, follow-up turns after failed gates, heavy
  context (\`peak\`, \`compactions\`), questions and assumptions that a better prompt would have
  answered up front.
- Merging: conflicts between nodes, review findings, red integration branch, replans and why.
- The memory: did later nodes use what earlier ones wrote, or redo or contradict it?
- Anything surprising in the event order or timing.

Say what went well too, and suggest concrete changes to how factory plans and runs goals.
`;

/** Every job under a goal, its attempt folders, memory, plan and PRs, zipped to `out`. */
export async function exportGoal(state: string, goal: Job, out: string): Promise<void> {
  const jobs = readJobs(state).filter((job) => job.of === goal.id);
  const ids = new Set([goal.id, ...jobs.map((job) => job.id)]);
  const dir = mkdtempSync(join(tmpdir(), "factory-export-"));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  try {
    write("REVIEW.md", REVIEW);
    write("summary.txt", `${showGoal([goal, ...jobs], goal)}\n`);
    write("goal.json", json(goal));
    write("jobs.json", json(jobs));
    const events = readEvents(state).filter((event) =>
      ids.has("job" in event ? event.job.id : event.id),
    );
    write("events.jsonl", events.map((event) => `${JSON.stringify(event)}\n`).join(""));
    const settings = readSettings(state);
    const env = Object.fromEntries(
      Object.entries(settings.env).map(([repo, vars]) => [repo, Object.keys(vars)]),
    );
    write("settings.json", json({ ...settings, env }));
    for (const job of [goal, ...jobs])
      for (const attempt of job.attempts) {
        const from = dirname(attempt.log);
        if (existsSync(from))
          cpSync(from, join(dir, "attempts", basename(from)), { recursive: true });
      }
    await writeRepoFiles(goal, write);
    await writePrs([goal, ...jobs], write);
    rmSync(out, { force: true });
    await output("zip", ["-qr", out, "."], dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Write = (path: string, text: string) => void;

async function writeRepoFiles(goal: Job, write: Write): Promise<void> {
  const { repo, slug } = goal.goal!;
  const head = await originHead(repo);
  const branch = `origin/${integration(goal.goal!)}`;
  const missing: string[] = [];
  // Once the goal's PR merged its branch may be gone, and the files live on the default branch.
  const show = async (path: string, as: string) => {
    for (const ref of [branch, `origin/${head}`]) {
      const text = await output("git", ["show", `${ref}:${path}`], repo).catch(() => undefined);
      if (text !== undefined) return write(`repo/${as}`, text);
    }
    missing.push(`${path}: on neither ${branch} nor origin/${head}`);
  };
  await show(memoryPath(slug), "memory.md");
  await show(planPath(slug), "plan.json");
  await show(replanPath(slug), "replan.json");
  const log = await output(
    "git",
    ["log", "--stat", "--format=fuller", `origin/${head}..${branch}`],
    repo,
  ).catch(() => undefined);
  if (log === undefined) missing.push(`git log: no branch ${branch}`);
  else write("repo/git-log.txt", log);
  if (missing.length) write("repo/missing.txt", `${missing.join("\n")}\n`);
}

const PR_FIELDS =
  "number,url,title,body,state,isDraft,author,createdAt,mergedAt,closedAt,baseRefName,headRefName,additions,deletions,files,commits,comments,reviews,statusCheckRollup";

async function writePrs(jobs: Job[], write: Write): Promise<void> {
  const urls = new Set(
    jobs.flatMap((job) =>
      [...job.attempts, ...job.notes].flatMap((each) =>
        each.url?.includes("/pull/") ? [each.url] : [],
      ),
    ),
  );
  for (const url of urls) {
    const name = `prs/${url.split("/").at(-1)}`;
    try {
      write(`${name}.json`, await output("gh", ["pr", "view", url, "--json", PR_FIELDS], tmpdir()));
      write(`${name}.diff`, await output("gh", ["pr", "diff", url], tmpdir()));
    } catch (error) {
      write(`${name}.error.txt`, `${url}\n${(error as Error).message}\n`);
    }
  }
}

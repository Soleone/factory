import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll } from "vite-plus/test";
import { addJobs, readJobs } from "../src/backend/jobs.ts";
import { run, type RunOptions } from "../src/backend/loop.ts";
import { readSettings, writeSettings } from "../src/backend/state.ts";
import type { Item, Job, Settings, Status } from "../src/backend/types.ts";

export const scratch = mkdtempSync(join(tmpdir(), "factory-test-"));
export const NOW = Date.parse("2026-11-16T04:00:00Z");
export const MINUTE = 60_000;

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

export const item = (repo: string, id: string, attention = "skim", blueprint = "fake"): Item => ({
  repo,
  label: repo,
  id,
  blueprint,
  attention,
  title: `fix ${id}`,
});

const path = process.env.PATH;
afterEach(() => {
  process.env.PATH = path;
});

export function sh(cwd: string, command: string, ...args: string[]): string {
  return execFileSync(command, args, { cwd, encoding: "utf8" });
}

export function script(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}

/** Fake claude and pi on PATH; each reads its prompt into $prompt and runs its body. */
export function agents(bodies: { claude?: string; pi?: string }): void {
  const bin = mkdtempSync(join(scratch, "bin-"));
  for (const [name, body] of Object.entries(bodies)) script(bin, name, `prompt=$(cat)\n${body}`);
  process.env.PATH = `${bin}:${process.env.PATH}`;
}

/** A fake gh on PATH: `pr list` and `pr view` print list.json and view.json from its folder; every call is logged to calls. */
export function gh(view: Record<string, unknown> = {}, list: { url: string }[] = []) {
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

export function repoWithOrigin() {
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
export function setup(ids: string[]) {
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

export const options = (
  base: { state: string; workwork: string },
  workers: RunOptions["workers"] = { pi: 0 },
): RunOptions => ({
  ...base,
  workers,
  limit: 2,
  idleMs: 60_000,
  pollMs: 20,
  watch: async () => [],
});

const busy = (jobs: Job[]) => jobs.some((job) => job.state === "queued" || job.state === "running");

/** Runs the factory until it turns itself off or `done` holds, then turns it off. */
export async function work(
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

export const status = (state: string): Status =>
  JSON.parse(readFileSync(join(state, "status.json"), "utf8"));
/** A shell line reporting a result for the job, from its worktree under state/worktrees/<repo>/<n>. */
export const RESULT = `echo '{"at":"2026-11-16T04:00:00Z","type":"note","id":"'$FACTORY_JOB'","note":{"kind":"result","text":"did it"}}' >> ../../../jobs.jsonl`;
export const OK = `${RESULT}; echo 'opened https://github.com/o/r/pull/7'`;
export const LIMIT_ERROR = "You've hit your monthly spend limit · try again in 1 hour";
const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
export const STARTUP_LIMIT = `
cat <<'JSON'
${[
  { type: "system", subtype: "init", session_id: "startup" },
  { type: "rate_limit_event", rate_limit_info: { status: "rejected" } },
  {
    type: "assistant",
    message: {
      model: "<synthetic>",
      usage: ZERO_USAGE,
      content: [{ type: "text", text: LIMIT_ERROR }],
    },
  },
  { type: "result", subtype: "success", is_error: true, result: LIMIT_ERROR, usage: ZERO_USAGE },
]
  .map((event) => JSON.stringify(event))
  .join("\n")}
JSON
exit 0`;
export const AUTH_ERROR = "Invalid API key · Please run /login";
/** Claude Code reports authentication failures in a structured assistant record. */
export const AUTH_FAILED = `
cat <<'JSON'
${[
  { type: "system", subtype: "init", session_id: "auth" },
  {
    type: "assistant",
    error: "authentication_failed",
    message: {
      model: "<synthetic>",
      usage: ZERO_USAGE,
      content: [{ type: "text", text: AUTH_ERROR }],
    },
  },
  { type: "result", subtype: "success", is_error: true, result: AUTH_ERROR, usage: ZERO_USAGE },
]
  .map((event) => JSON.stringify(event))
  .join("\n")}
JSON
exit 1`;
export const OPEN_PR = {
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

/** A shell line that reports on the job the way `factory note|ask|result` does. */
export const report = (state: string, note: Record<string, unknown>, at = "$(date -u +%FT%TZ)") =>
  `echo '{"at":"'${at}'","type":"note","id":"'$FACTORY_JOB'","note":${JSON.stringify(note)}}' >> ${state}/jobs.jsonl`;

/** Settings with presets and tiers, for runs without agent workers. */
export function tiered(state: string, change: Partial<Settings>): void {
  writeSettings(state, { ...readSettings(state), ...change });
}

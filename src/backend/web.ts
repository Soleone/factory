import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_NAMES } from "./agents.ts";
import { chat } from "./chat.ts";
import { clonableRepos, cloneRepo, createRepo, localRepos, sourceRoot } from "./repos.ts";
import { agentModels } from "./models.ts";
import {
  addJobs,
  addNote,
  addOwnJob,
  answer,
  moveJob,
  queueConflicts,
  queueFollowup,
  pinJob,
  queueReview,
  readJobs,
  record,
  removeJob,
  retryJob,
} from "./jobs.ts";
import { turnOff, turnOn } from "./power.ts";
import { closePr, mergePr, prCache, readPrDetails, rebasePr } from "./review.ts";
import {
  approveGoal,
  cancelGoal,
  dropNode,
  retierNode,
  findGoal,
  importPlanText,
  newGoal,
  pauseGoal,
  queueReplan,
  resumeGoal,
} from "./goals.ts";
import { mirrorTasks } from "./tasksStore.ts";
import { mergeTrain } from "./train.ts";
import { piProvider, usageCache } from "./usage.ts";
import {
  checkSettings,
  output,
  readCandidates,
  readSettings,
  refreshCandidates,
  refreshingCandidates,
  runningPid,
  writeSettings,
} from "./state.ts";
import {
  canMerge,
  canRebase,
  itemKey,
  prUrl,
  type Model,
  type Blueprint,
  type Item,
  type Pin,
  type Preset,
  poolOf,
  workersOf,
  presetId,
  type RunRequest,
  type Settings,
  type Snapshot,
  type Status,
  type Tier,
  USAGE_POOLS,
} from "./types.ts";

/** The built page; under pn dev, Vite serves it instead and proxies /api and /runs here. */
const WEB = fileURLToPath(new URL("./web", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/** The page and the API it uses: the same state and commands as the CLI, nothing more. */
// Tests pass their own usage, so they never read the real accounts.
export function serve(
  state: string,
  port: number,
  host: string,
  usage = usageCache(join(state, "usage.json")),
): Server {
  const prs = prCache();
  const train = mergeTrain(
    prs,
    (id, url, files) => queueConflicts(state, id, url, files),
    (id, text) => addNote(state, id, { kind: "train", text }),
  );
  const planner = chat(state, () => {
    const { port } = server.address() as AddressInfo;
    return `http://${host}:${port}`;
  });
  let stopMirror = mirrorTasks(state, readSettings(state), console.log);
  // Listing takes a second or two per agent, and the lists rarely change while serve runs.
  const models = new Map<string, Promise<Model[]>>();
  function modelsOf(name: string): Promise<Model[]> {
    if (!models.has(name))
      models.set(
        name,
        agentModels(name).catch((error: Error) => {
          // Not installed, say: the page offers the default model only, and asks again next time.
          console.error(`factory: can't list ${name}'s models: ${error.message}`);
          models.delete(name);
          return [];
        }),
      );
    return models.get(name)!;
  }
  function refresh() {
    void refreshCandidates(state, "workwork").catch((error: Error) =>
      console.error(`factory: workwork failed: ${error.message}`),
    );
  }
  /** Only cached candidates, so the page can't queue or run workwork for anything it names. */
  function candidates(wanted: { repo: string; id: string }[]) {
    const cached = new Map(readCandidates(state)?.items.map((item) => [itemKey(item), item]));
    return wanted.map((each) => {
      const item = cached.get(itemKey(each));
      if (!item) throw new Error(`no candidate ${each.id} in ${each.repo}`);
      return item;
    });
  }
  /** What the agent was told, kept with its first run: workwork drops a candidate once it's done. */
  function jobPrompt(id: string) {
    const job = readJobs(state).find((job) => job.id === id);
    if (!job) throw new Error(`no job ${id}`);
    if (job.prompt) return job.prompt;
    const run = job.attempts[0] && join(dirname(job.attempts[0].log), "prompt.md");
    if (run && existsSync(run)) return readFileSync(run, "utf8");
    const [item] = candidates([job.item]);
    return output("workwork", ["prompt", item.id], item.repo);
  }
  function jobPr(id: string) {
    const job = readJobs(state).find((job) => job.id === id);
    const url = job && prUrl(job);
    if (!url) throw new Error(`job ${id} has no PR`);
    return url;
  }
  /** The job's PR, checked with GitHub just now. */
  async function openPr(id: string) {
    const url = jobPr(id);
    const pr = await prs.fresh(url);
    if (pr.state !== "OPEN") throw new Error(`${url} is already ${pr.state.toLowerCase()}`);
    return { url, pr };
  }
  const routes: Record<string, (body: never, id: string) => unknown> = {
    "GET /api/state": () => snapshot(state, (urls) => prs.get(urls), train.cars(), usage),
    "GET /api/candidates": () => {
      const cached = readCandidates(state);
      const items = cached?.items ?? [];
      const repos = [...new Set([...localRepos(), ...items.map((item) => item.repo)])].sort();
      return { at: cached?.at ?? null, items, repos, root: sourceRoot() };
    },
    "POST /api/candidates/refresh": () => {
      refresh();
    },
    "GET /api/repos": () => clonableRepos(),
    "POST /api/repos/clone": async (body: { name: string }) => {
      await cloneRepo(body.name);
      refresh();
    },
    /** A goal from a brief, in a repo under $SRC or, with `project`, a new one. */
    "POST /api/goals": async (body: {
      title: string;
      brief: string;
      repo?: string;
      project?: string;
    }) => {
      const repo = body.project ? await createRepo(body.project) : body.repo;
      if (!body.title?.trim() || !repo) throw new Error("a goal wants a title and a repo");
      return newGoal(state, body.title.trim(), repo, body.brief ?? "");
    },
    "POST /api/goals/import": (body: { plan: string }) => importPlanText(state, body.plan),
    // Read fresh each time: it's quick, and the user may have just edited a blueprint of their own.
    "GET /api/blueprints": async (): Promise<Blueprint[]> =>
      JSON.parse(await output("workwork", ["blueprints", "--json"], process.cwd())),
    // Saving or deleting one changes what every repo's candidates are.
    "PUT /api/blueprints": async (body: Omit<Blueprint, "custom">) => {
      await output("workwork", ["blueprints", "save"], process.cwd(), JSON.stringify(body));
      refresh();
    },
    "POST /api/blueprints/delete": async (body: { name: string }) => {
      await output("workwork", ["blueprints", "delete", body.name], process.cwd());
      refresh();
    },
    "POST /api/blueprints/run": async (body: { name: string; repo: string }) => {
      const found: Item[] = JSON.parse(
        await output("workwork", ["--blueprint", body.name, "--json"], body.repo),
      );
      if (found.length === 0) throw new Error(`${body.name} finds nothing to do in ${body.repo}`);
      return addJobs(state, found, "pick");
    },
    "POST /api/candidates/prompt": (body: { repo: string; id: string }) => {
      const [item] = candidates([body]);
      return output("workwork", ["prompt", item.id], item.repo);
    },
    "POST /api/jobs": ({
      items,
      pin = {},
    }: {
      items: { repo: string; id: string }[];
      pin?: Pin;
    }) => {
      const { agent, model, effort, preset, tier } = pin;
      return addJobs(state, candidates(items), "pick", { agent, model, effort, preset, tier });
    },
    "POST /api/jobs/own": (body: { repo: string; prompt: string; tier: Tier; title?: string }) =>
      addOwnJob(state, body),
    "POST /api/jobs/remove": (_, id) => removeJob(state, id),
    "POST /api/jobs/retry": (_, id) => retryJob(state, id),
    "POST /api/jobs/answer": (body: { text: string; re?: number }, id) =>
      answer(state, id, body.text, body.re),
    "POST /api/jobs/approve": (_, id) => approveGoal(state, id),
    "POST /api/jobs/pause": (_, id) => pauseGoal(state, id),
    "POST /api/jobs/resume": (_, id) => resumeGoal(state, id),
    "POST /api/jobs/cancel": (_, id) => cancelGoal(state, id),
    "POST /api/jobs/tier": (body: { tier: Tier }, id) => retierNode(state, id, body.tier),
    "POST /api/jobs/pin": (body: Pin, id) => pinJob(state, id, body),
    "POST /api/jobs/drop": (_, id) => dropNode(state, id),
    "POST /api/jobs/replan": (body: { why: string }, id) => {
      if (!body.why?.trim()) throw new Error("a replan wants a reason");
      queueReplan(state, findGoal(state, id), body.why);
    },
    "POST /api/jobs/verify": (body: { need?: string }, id) =>
      record(state, { type: "verify", id, need: body.need }),
    "POST /api/jobs/followup": (body: { task: string }, id) => queueFollowup(state, id, body.task),
    "POST /api/jobs/review": (body: { agent: string }, id) => queueReview(state, id, body.agent),
    "POST /api/jobs/move": (body: { index: number }, id) => moveJob(state, id, body.index),
    "GET /api/jobs/pr": (_, id) => readPrDetails(jobPr(id)),
    "GET /api/jobs/prompt": (_, id) => jobPrompt(id),
    "POST /api/jobs/merge": async (_, id) => {
      const { url, pr } = await openPr(id);
      if (!canMerge(pr)) throw new Error(`${url} isn't ready to merge: see it on GitHub`);
      await mergePr(url);
      await prs.fresh(url);
    },
    "POST /api/jobs/rebase": async (_, id) => {
      const { url, pr } = await openPr(id);
      if (!canRebase(pr)) throw new Error(`${url} isn't ready to rebase: see it on GitHub`);
      await rebasePr(url);
      await prs.fresh(url);
    },
    "POST /api/train": (body: { ids: string[] }) =>
      train.start(body.ids.map((id) => ({ id, url: jobPr(id) }))),
    "POST /api/chat": (body: { message: string }) => planner.prompt(body.message),
    "POST /api/chat/abort": () => planner.abort(),
    "POST /api/chat/answer": (body: { id: string }) => planner.answer(body),
    "POST /api/chat/reset": () => planner.reset(),
    "POST /api/jobs/close": async (_, id) => {
      const { url } = await openPr(id);
      await closePr(url);
      await prs.fresh(url);
    },
    "GET /api/models": async () =>
      Object.fromEntries(
        await Promise.all(AGENT_NAMES.map(async (name) => [name, await modelsOf(name)])),
      ),
    "PUT /api/settings": (body: Settings) => {
      const before = JSON.stringify(readSettings(state).chat);
      writeSettings(state, checkSettings(body));
      if (JSON.stringify(body.chat) !== before) planner.reset();
      stopMirror();
      stopMirror = mirrorTasks(state, readSettings(state), console.log);
    },
    "POST /api/on": (body: RunRequest) => {
      const settings = readSettings(state);
      const counted = settings.presets.map((preset) => ({
        ...preset,
        workers: body.workers[presetId(preset)] ?? preset.workers,
      }));
      checkSettings({ ...settings, presets: counted, limit: body.limit, until: body.until });
      return turnOn(state, runArgs(body));
    },
    "POST /api/off": () => turnOff(state),
  };

  const server = createServer(async (request, response) => {
    // Job ids and run folders are [\w.-] only, so the path needs no decoding.
    const path = new URL(request.url ?? "/", "http://factory").pathname;
    // /api/jobs/<id>/<action> is routed as /api/jobs/<action> with the id.
    const [, jobId, action] = /^\/api\/jobs\/(\w+)\/(\w+)$/.exec(path) ?? [];
    const route = routes[`${request.method} ${jobId ? `/api/jobs/${action}` : path}`];
    try {
      if (`${request.method} ${path}` === "GET /api/chat") return planner.listen(response);
      if (route) {
        // Each route says what body it takes; JSON from the page is trusted to match it, the commands check the rest.
        const result = await route((await body(request)) as never, jobId);
        return send(response, "application/json", JSON.stringify(result ?? null));
      }
      const file = resolve(state, `.${path}`);
      if (file.startsWith(join(state, "runs") + sep) && isFile(file))
        return send(response, "text/plain; charset=utf-8", readFileSync(file));
      const asset = resolve(WEB, `.${path}`);
      if (asset.startsWith(WEB + sep) && isFile(asset))
        return send(
          response,
          TYPES[extname(asset)] ?? "application/octet-stream",
          readFileSync(asset),
        );
      if (path.startsWith("/api/") || path.startsWith("/runs/")) {
        response.writeHead(404).end("not found");
        return;
      }
      const page = join(WEB, "index.html");
      if (!isFile(page))
        return send(
          response,
          "text/plain",
          "The page isn't built: run `vp build`, or use `pn dev`.",
        );
      send(response, TYPES[".html"], readFileSync(page));
    } catch (error) {
      response
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: (error as Error).message }));
    }
  })
    .on("close", () => stopMirror())
    .listen(port, host, () => {
      console.log(`factory: serving http://${host}:${port}`);
      if (host !== "127.0.0.1" && host !== "localhost")
        console.log("factory: anyone who reaches this address can run agents on this machine");
    });
  return server;
}

function snapshot(
  state: string,
  prs: (urls: string[]) => Snapshot["prs"],
  train: Snapshot["train"],
  usage: (pools: string[]) => Snapshot["usage"],
): Snapshot {
  const statusPath = join(state, "status.json");
  const settings = readSettings(state);
  const candidates = readCandidates(state);
  const jobs = readJobs(state);
  return {
    on: runningPid(state) !== undefined,
    status: existsSync(statusPath)
      ? (JSON.parse(readFileSync(statusPath, "utf8")) as Status)
      : null,
    settings,
    // Paths under runs/ are where this server serves them.
    jobs: jobs.map((job) => ({
      ...job,
      attempts: job.attempts.map((attempt) => ({ ...attempt, log: relative(state, attempt.log) })),
    })),
    candidates: {
      at: candidates?.at ?? null,
      count: candidates?.items.length ?? 0,
      refreshing: refreshingCandidates(state),
    },
    prs: prs(jobs.flatMap((job) => (job.state === "removed" ? [] : (prUrl(job) ?? [])))),
    train,
    usage: usage(usagePools(settings)),
  };
}

/** The pools a run on these settings works on, of those whose usage factory can read. */
function usagePools(settings: Settings): string[] {
  const presets = settings.presets.filter((preset) => workersOf(preset) > 0);
  // A bare pi works on pi's default provider, which poolOf can't see.
  const pool = (preset: Preset) =>
    preset.agent === "pi" && !preset.model && !preset.pool ? piProvider() : poolOf(preset);
  return [...new Set(presets.map(pool))].filter((pool) =>
    (USAGE_POOLS as readonly string[]).includes(pool),
  );
}

/** A run asked for from the page, as the flags `factory run` takes. */
function runArgs({ workers, limit, until }: RunRequest): string[] {
  const args = ["--limit", String(limit ?? "none")];
  if (until) args.push("--until", until);
  for (const [id, count] of Object.entries(workers)) args.push("--workers", `${id}=${count}`);
  return args;
}

async function body(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : {};
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function send(response: ServerResponse, type: string, body: string | Buffer): void {
  response.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body);
}

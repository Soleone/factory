import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_NAMES } from "./agents.ts";
import { chat } from "./chat.ts";
import type { PiImage } from "./claude.ts";
import { githubIdentity } from "./github.ts";
import { addImageJob, useImage, type Pasted } from "./images.ts";
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
import { exportGoal } from "./goalExport.ts";
import { jobContext, jobPrs, liveJobs, resultsPage, webJob } from "./webHistory.ts";
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
  RESULTS_BATCH_SIZE,
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
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
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
  const cachedPrs = (urls: string[]) => prs.get(urls);
  const train = mergeTrain(
    prs,
    (id, url, files) => queueConflicts(state, id, url, files),
    (id, text) => addNote(state, id, { kind: "train", text }),
    () => readSettings(state).commitIdentity,
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
  function refresh(repo?: string) {
    void refreshCandidates(state, "workwork", repo).catch((error: Error) =>
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
  /** The goal's export as a zip download. */
  async function sendExport(response: ServerResponse, id: string) {
    const goal = findGoal(state, id);
    const dir = mkdtempSync(join(tmpdir(), "factory-download-"));
    try {
      const file = join(dir, "export.zip");
      await exportGoal(state, goal, file);
      response
        .writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="factory-goal-${goal.goal!.slug}.zip"`,
        })
        .end(readFileSync(file));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const projectPaths = (items: Item[]) =>
    [...new Set([...localRepos(), ...items.map((item) => item.repo)])].sort();
  const routes: Record<string, (body: never, id: string) => unknown> = {
    "GET /api/projects": () => projectPaths(readCandidates(state)?.items ?? []),
    "GET /api/candidates": () => {
      const cached = readCandidates(state);
      const items = cached?.items ?? [];
      return {
        at: cached?.at || null,
        repoAt: cached?.repoAt ?? {},
        items,
        repos: projectPaths(items),
        root: sourceRoot(),
      };
    },
    /** Every repo, or with `repo` just that one, which is much quicker. */
    "POST /api/candidates/refresh": (body: { repo?: string }) => {
      if (body.repo && !projectPaths(readCandidates(state)?.items ?? []).includes(body.repo))
        throw new Error(`${body.repo} isn't a project under ${sourceRoot()}`);
      refresh(body.repo);
    },
    "GET /api/repos": () => clonableRepos(),
    "POST /api/repos/clone": async (body: { name: string }) => {
      refresh(await cloneRepo(body.name));
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
    "POST /api/jobs/own": (body: {
      repo: string;
      prompt: string;
      tier: Tier;
      title?: string;
      machine?: boolean;
    }) => addOwnJob(state, body),
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
    "POST /api/jobs/review": (body: { agent?: string }, id) => queueReview(state, id, body.agent),
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
      await rebasePr(url, readSettings(state).commitIdentity);
      await prs.fresh(url);
    },
    "POST /api/train": (body: { ids: string[] }) =>
      train.start(body.ids.map((id) => ({ id, url: jobPr(id) }))),
    "POST /api/chat": (body: { message: string; images?: Omit<PiImage, "type">[] }) =>
      planner.prompt(body.message, body.images),
    "POST /api/chat/abort": () => planner.abort(),
    "POST /api/chat/answer": (body: { id: string }) => planner.answer(body),
    "POST /api/chat/new": () => planner.fresh(),
    "POST /api/chat/open": (body: { id: string }) => planner.open(body.id),
    "POST /api/jobs/close": async (_, id) => {
      const { url } = await openPr(id);
      await closePr(url);
      await prs.fresh(url);
    },
    "GET /api/models": async () =>
      Object.fromEntries(
        await Promise.all(AGENT_NAMES.map(async (name) => [name, await modelsOf(name)])),
      ),
    "GET /api/github-profile": () => githubIdentity(),
    "PUT /api/settings": (body: Settings) => {
      const before = JSON.stringify(readSettings(state).chat);
      writeSettings(state, checkSettings(body));
      if (JSON.stringify(body.chat) !== before) planner.retune();
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
    "POST /api/images": (body: {
      prompt: string;
      repo?: string;
      expand: boolean;
      variants: number;
      references: Pasted[];
    }) => addImageJob(state, body),
    "POST /api/images/use": (body: { id: string; file: string; where: string }) =>
      useImage(state, body.id, body.file, body.where),
  };

  const server = createServer(async (request, response) => {
    // Job ids and run folders are [\w.-] only, so the path needs no decoding.
    const { pathname: path, searchParams } = new URL(request.url ?? "/", "http://factory");
    // /api/jobs/<id>/<action> is routed as /api/jobs/<action> with the id.
    const [, jobId, action] = /^\/api\/jobs\/(\w+)\/(\w+)$/.exec(path) ?? [];
    const route = routes[`${request.method} ${jobId ? `/api/jobs/${action}` : path}`];
    try {
      if (request.method === "GET" && path === "/api/state")
        return sendPoll(request, response, snapshot(state, cachedPrs, train.cars(), usage));
      if (request.method === "GET" && path === "/api/results") {
        const limit = Number(searchParams.get("limit") ?? RESULTS_BATCH_SIZE);
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid results limit");
        return sendPoll(
          request,
          response,
          resultsPage(
            state,
            readJobs(state),
            searchParams.get("repo"),
            limit,
            cachedPrs,
            train.cars(),
          ),
        );
      }
      if (`${request.method} ${path}` === "GET /api/chat") return planner.listen(response);
      if (request.method === "GET" && action === "export") return await sendExport(response, jobId);
      if (route) {
        // Each route says what body it takes; JSON from the page is trusted to match it, the commands check the rest.
        const result = await route((await body(request)) as never, jobId);
        return send(response, "application/json", JSON.stringify(result ?? null));
      }
      const file = resolve(state, `.${path}`);
      if (file.startsWith(join(state, "runs") + sep) && isFile(file))
        return send(response, "text/plain; charset=utf-8", readFileSync(file));
      if (file.startsWith(join(state, "images") + sep) && isFile(file) && TYPES[extname(file)])
        return send(response, TYPES[extname(file)], readFileSync(file));
      const asset = resolve(WEB, `.${path}`);
      if (asset.startsWith(WEB + sep) && isFile(asset))
        return send(
          response,
          TYPES[extname(asset)] ?? "application/octet-stream",
          readFileSync(asset),
        );
      if (path.startsWith("/api/") || path.startsWith("/runs/") || path.startsWith("/images/")) {
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
    .on("close", () => {
      stopMirror();
    })
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
  const all = readJobs(state);
  const status = existsSync(statusPath)
    ? (JSON.parse(readFileSync(statusPath, "utf8")) as Status)
    : null;
  // A previously settled PR can still be on a visible goal, in Activity or in Results.
  // Check all PRs as before so an old unresolved PR can enter or leave the Inbox.
  const prStates = jobPrs(all, prs);
  const jobs = liveJobs(all, prStates, candidates?.items ?? [], status);
  return {
    on: runningPid(state) !== undefined,
    status,
    settings,
    jobs: jobs.map((job) => webJob(state, job)),
    ...jobContext(all, jobs),
    candidates: {
      // When any repo's changed, so the page knows to load them again.
      at:
        [candidates?.at ?? "", ...Object.values(candidates?.repoAt ?? {})].reduce((latest, each) =>
          each > latest ? each : latest,
        ) || null,
      refreshing: refreshingCandidates(state),
    },
    prs: jobPrs(jobs, (urls) =>
      Object.fromEntries(urls.flatMap((url) => (prStates[url] ? [[url, prStates[url]]] : []))),
    ),
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

function sendPoll(request: IncomingMessage, response: ServerResponse, value: unknown): void {
  const json = JSON.stringify(value);
  const etag = `"${createHash("sha256").update(json).digest("base64url")}"`;
  const headers = { etag, "cache-control": "private, no-cache" };
  if (request.headers["if-none-match"] === etag) response.writeHead(304, headers).end();
  else response.writeHead(200, { ...headers, "content-type": "application/json" }).end(json);
}

function send(response: ServerResponse, type: string, body: string | Buffer): void {
  response.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body);
}

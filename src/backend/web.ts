import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_NAMES } from "./agents.ts";
import { chat } from "./chat.ts";
import { clonableRepos, cloneRepo } from "./repos.ts";
import { agentModels } from "./models.ts";
import { addJobs, moveJob, queueConflicts, readJobs, removeJob, retryJob } from "./jobs.ts";
import { turnOff, turnOn } from "./power.ts";
import { closePr, mergePr, prCache, readPrDetails, rebasePr } from "./review.ts";
import { mergeTrain } from "./train.ts";
import {
  checkSettings,
  itemKey,
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
  prUrl,
  type Model,
  type Play,
  type Preset,
  type Settings,
  type Snapshot,
  type Status,
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
export function serve(state: string, port: number, host: string): Server {
  const prs = prCache();
  const train = mergeTrain(prs, (id, url, files) => queueConflicts(state, id, url, files));
  const planner = chat(state);
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
  /** Only cached candidates, so the page can't queue or run workwork for anything it names. */
  function candidates(wanted: { repo: string; id: string }[]) {
    const cached = new Map(readCandidates(state)?.items.map((item) => [itemKey(item), item]));
    return wanted.map((each) => {
      const item = cached.get(itemKey(each));
      if (!item) throw new Error(`no candidate ${each.id} in ${each.repo}`);
      return item;
    });
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
    "GET /api/state": () => snapshot(state, (urls) => prs.get(urls), train.cars()),
    "GET /api/candidates": () => readCandidates(state) ?? { at: null, items: [] },
    "POST /api/candidates/refresh": () => {
      void refreshCandidates(state, "workwork").catch((error: Error) =>
        console.error(`factory: workwork failed: ${error.message}`),
      );
    },
    "GET /api/repos": () => clonableRepos(),
    "POST /api/repos/clone": async (body: { name: string; folder: string }) => {
      await cloneRepo(body.name, body.folder);
      void refreshCandidates(state, "workwork").catch((error: Error) =>
        console.error(`factory: workwork failed: ${error.message}`),
      );
    },
    // Read fresh each time: it's quick, and the user may have just edited a play of their own.
    "GET /api/plays": async (): Promise<Play[]> =>
      JSON.parse(await output("workwork", ["plays", "--json"], process.cwd())),
    "POST /api/candidates/prompt": (body: { repo: string; id: string }) => {
      const [item] = candidates([body]);
      return output("workwork", ["prompt", item.id], item.repo);
    },
    "POST /api/jobs": (body: { items: { repo: string; id: string }[]; pin?: Preset }) =>
      addJobs(state, candidates(body.items), "pick", body.pin),
    "POST /api/jobs/remove": (_, id) => removeJob(state, id),
    "POST /api/jobs/retry": (_, id) => retryJob(state, id),
    "POST /api/jobs/move": (body: { index: number }, id) => moveJob(state, id, body.index),
    "GET /api/jobs/pr": (_, id) => readPrDetails(jobPr(id)),
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
    },
    "POST /api/on": (body: Pick<Settings, "agents" | "limit" | "until">) => {
      checkSettings({ ...readSettings(state), ...body });
      return turnOn(state, runArgs(body));
    },
    "POST /api/off": () => turnOff(state),
  };

  return createServer(async (request, response) => {
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
  }).listen(port, host, () => {
    console.log(`factory: serving http://${host}:${port}`);
    if (host !== "127.0.0.1" && host !== "localhost")
      console.log("factory: anyone who reaches this address can run agents on this machine");
  });
}

function snapshot(
  state: string,
  prs: (urls: string[]) => Snapshot["prs"],
  train: Snapshot["train"],
): Snapshot {
  const statusPath = join(state, "status.json");
  const candidates = readCandidates(state);
  const jobs = readJobs(state);
  return {
    on: runningPid(state) !== undefined,
    status: existsSync(statusPath)
      ? (JSON.parse(readFileSync(statusPath, "utf8")) as Status)
      : null,
    settings: readSettings(state),
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
  };
}

/** A run asked for from the page, as the flags `factory run` takes. */
function runArgs({ agents, limit, until }: Pick<Settings, "agents" | "limit" | "until">): string[] {
  const args = ["--agents", Object.keys(agents).join(","), "--limit", String(limit ?? "none")];
  if (until) args.push("--until", until);
  for (const [name, { model, effort }] of Object.entries(agents)) {
    if (model) args.push("--model", `${name}=${model}`);
    if (effort) args.push("--effort", `${name}=${effort}`);
  }
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

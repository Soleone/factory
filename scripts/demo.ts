import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { Plugin } from "vite-plus";
import { checkSettings } from "../src/backend/state.ts";
import {
  canMerge,
  canRebase,
  presetWorkers,
  prUrl,
  RESULTS_BATCH_SIZE,
  type Item,
  type Job,
  type Pin,
  type RunRequest,
  type Settings,
  type Snapshot,
} from "../src/backend/types.ts";
import { jobContext, liveJobs, resultsPage } from "../src/backend/webHistory.ts";
import type { PiRecord } from "../src/pi.ts";

const DEMO_NOTES: Record<number, Omit<Job["notes"][number], "at" | "attempt">[]> = {
  0: [
    { kind: "note", text: "The CSV writer had no test for quoted commas." },
    {
      kind: "result",
      text: "Added tests for quoting and empty rows; both caught a real bug, fixed in the same PR.",
      confidence: "high",
      followups: ["The JSON export has the same quoting gap"],
    },
  ],
  3: [
    { kind: "note", text: "Logging goes through three wrappers; two only rename fields." },
    {
      kind: "ask",
      text: "Drop the request-id field from logs (simpler, but dashboards use it) or keep it? I'd keep it.",
    },
  ],
  4: [
    {
      kind: "result",
      text: "The webhook docs already match the retry code: 5 tries, doubling from 1 second. Nothing to change.",
      confidence: "high",
    },
  ],
};

/** What a fresh job has besides its item. */
const BLANK = { after: [], gates: [], needs: [], unverified: [], escalations: 0, open: false };

/** A goal part way through: planned, its core merged, a checkpoint after one format, the rest waiting. */
function demoGoal(at: string, run: string): Job[] {
  const repo = "/demo/atlas";
  const item = (id: string, title: string) => ({
    repo,
    label: "atlas",
    id,
    blueprint: "goal",
    attention: "decide",
    title,
  });
  const attempt = (
    outcome: "done" | "failed",
    preset: string,
    peak: number,
    compactions: number,
  ) => ({
    run,
    agent: preset.startsWith("opus") ? "claude" : "pi",
    preset,
    start: new Date(Date.parse(at) - 40 * 60_000).toISOString(),
    end: new Date(Date.parse(at) - 20 * 60_000).toISOString(),
    outcome,
    log: `runs/${run}/goal-1/agent.log`,
    turns: 2,
    followups: 1,
    peak,
    compactions,
    tokens: { input: 40_000, cached: 900_000, output: 30_000 },
  });
  const node = (id: string, title: string, rest: Partial<Job>): Job => ({
    ...BLANK,
    id,
    item: item(id, title),
    source: "goal",
    of: "goal",
    key: id,
    added: at,
    state: "queued",
    attempts: [],
    notes: [],
    gates: ["pnpm test"],
    touches: [`src/${id}/**`],
    prompt: `Build ${title.toLowerCase()}.`,
    ...rest,
  });
  const earlier = (minutes: number) => new Date(Date.parse(at) - minutes * 60_000).toISOString();
  // A milestone never runs: no tier, prompt, touches or gates.
  const milestone = (id: string, title: string, rest: Partial<Job>) =>
    node(id, title, { gates: [], touches: [], prompt: "", ...rest });
  return [
    {
      ...BLANK,
      id: "goal",
      item: item("goal/export", "Export to every format"),
      source: "goal",
      added: at,
      state: "blocked",
      blocked: "checkpoint",
      why: "JSON format is merged into goal/export, and the plan stops here so you can check it. Approving starts the rest",
      attempts: [],
      notes: [
        {
          at,
          attempt: 0,
          kind: "factory",
          text: "the plan has 9 jobs, shown below. Approving starts them, and nothing runs until then; replan first if it needs changes",
        },
        {
          at,
          attempt: 0,
          kind: "factory",
          text: "JSON format is merged into goal/export, and the plan stops here so you can check it. Approving starts the rest",
        },
      ],
      goal: {
        repo,
        slug: "export",
        brief:
          "Let people export a report as CSV, JSON or XLSX from its menu.\n\nOne writer shared by every format, so a new format is one file. Done when each export opens cleanly in its usual app.",
        summary: "Exports to CSV, JSON and XLSX with one shared writer.",
        gates: ["pnpm test"],
        budget: { attempts: 30 },
        allowUp: true,
      },
    },
    node("plan", "Decompose: Export to every format", {
      item: { ...item("plan", "Decompose: Export to every format"), blueprint: "decompose" },
      tier: "communicator",
      front: true,
      state: "done",
      touches: [],
      gates: [],
      attempts: [attempt("done", "opus", 60_000, 0)],
    }),
    milestone("core", "Milestone: core", { state: "done" }),
    milestone("formats", "Milestone: formats", { after: ["core"] }),
    milestone("finish", "Milestone: menu and docs", { after: ["formats"] }),
    node("writer", "Shared export writer", {
      parent: "core",
      tier: "builder",
      state: "done",
      attempts: [attempt("done", "sol", 150_000, 1)],
      notes: [
        {
          at,
          attempt: 1,
          kind: "factory",
          text: "merged into goal/export",
          url: "https://example.com/demo/pull/21",
        },
      ],
    }),
    node("csv", "CSV format", {
      parent: "formats",
      tier: "grunt",
      state: "running",
      notes: [
        { at: earlier(6), attempt: 1, kind: "step", text: "Reading the shared writer" },
        { at: earlier(4), attempt: 1, kind: "step", text: "Header row and column order" },
        { at, attempt: 1, kind: "step", text: "Quoting rules", done: 3, of: 5 },
        {
          at,
          attempt: 1,
          kind: "assume",
          text: "Excel-style or RFC 4180 line endings?",
          assumed: "RFC 4180",
        },
      ],
    }),
    node("json", "JSON format", {
      parent: "formats",
      tier: "grunt",
      state: "done",
      checkpoint: true,
      unverified: ["checked in a browser"],
      attempts: [attempt("done", "luna", 260_000, 3)],
      notes: [{ at, attempt: 1, kind: "factory", text: "merged into goal/export" }],
    }),
    node("xlsx", "XLSX format", { parent: "formats", tier: "builder", needs: ["display"] }),
    node("menu", "Export menu and copy", { parent: "finish", tier: "communicator" }),
    node("docs", "Document the formats", {
      parent: "finish",
      tier: "communicator",
      after: ["menu"],
    }),
  ];
}

type DemoState = Omit<Snapshot, "reviewed" | "queuedFollowups">;

function seed(): DemoState {
  const at = new Date().toISOString();
  const run = at.slice(0, 19).replaceAll(":", "");
  const jobs: Job[] = [
    ...items.slice(0, 3).map((item, index): Job => ({
      id: `job${index + 1}`,
      item,
      source: index === 2 ? "auto" : "pick",
      added: at,
      state: "queued",
      attempts: [],
      notes: [],
      ...BLANK,
    })),
    ...items.slice(3, 8).map((item, index): Job => {
      const id = `result${index + 1}`;
      const failed = index === 2;
      // The last one, without a PR or branch, found nothing to change.
      return {
        ...BLANK,
        id,
        item,
        source: "pick",
        agent: "pi",
        added: at,
        state: failed ? "failed" : index === 3 ? "blocked" : "done",
        blocked: index === 3 ? "asked" : undefined,
        attempts: [
          {
            run,
            agent: "pi",
            start: new Date(Date.parse(at) - (index + 1) * 120_000).toISOString(),
            end: at,
            outcome: failed ? "failed" : "done",
            log: `runs/${run}/${id}-1/agent.log`,
            url: index < 2 ? `https://example.com/demo/pull/${index + 1}` : undefined,
            error: failed ? "Demo setup failed: dependency install exited with code 1" : undefined,
          },
        ],
        notes: DEMO_NOTES[index]?.map((note) => ({ at, attempt: 1, ...note })) ?? [],
      };
    }),
    ...demoGoal(at, run),
  ];
  return {
    on: false,
    status: null,
    jobs,
    settings: {
      chat: { agent: "pi" },
      presets: [
        { agent: "claude", model: "opus", effort: "medium" },
        { agent: "claude", model: "opus", effort: "high", id: "opus", workers: 0 },
        { agent: "pi", model: "openai/gpt-6.2-sol", effort: "high", id: "sol", workers: 2 },
        { agent: "pi", model: "openai-codex/gpt-6-luna", effort: "max", id: "luna", workers: 3 },
      ],
      limit: 2,
      reserves: {},
      idle: 10,
      tiers: { communicator: ["opus"], builder: ["sol", "opus"], grunt: ["luna"] },
      store: "local",
      capabilities: [],
      env: {},
      auto: { on: true, attention: ["none"], blueprints: [], repos: [] },
      triggers: { ci: true, label: "factory", reviews: true },
    },
    candidates: { at, count: items.length, refreshing: false },
    prs: Object.fromEntries(
      jobs.flatMap((job, index) => {
        const url = prUrl(job);
        if (!url) return [];
        return [
          [
            url,
            {
              state: "OPEN",
              draft: false,
              title: job.item.title,
              additions: 28,
              deletions: 5,
              files: ["src/index.ts", "tests/index.test.ts"],
              checks: index === 3 ? "passing" : "failing",
              conflicts: index === 4,
              fork: false,
            },
          ],
        ];
      }),
    ),
    train: { result2: { step: "rebasing" } },
    usage: {
      claude: {
        fiveHour: { used: 58, resets: Date.now() + 112 * 60_000 },
        sevenDay: { used: 71, resets: Date.now() + 52 * 3_600_000 },
        at: Date.now(),
      },
      "openai-codex": {
        fiveHour: { used: 84, resets: Date.now() + 38 * 60_000 },
        sevenDay: { used: 49, resets: Date.now() + 131 * 3_600_000 },
        at: Date.now(),
      },
    },
  };
}

const items: Item[] = [
  ["atlas", "tests", "skim", "Cover empty search results"],
  ["atlas", "docs", "none", "Document the export format"],
  ["relay", "cleanup", "none", "Remove unused retry settings"],
  ["atlas", "tests", "skim", "Add CSV export tests"],
  ["atlas", "docs", "skim", "Check the quickstart links"],
  ["relay", "tests", "skim", "Test reconnect after timeout"],
  ["relay", "cleanup", "decide", "Simplify request logging"],
  ["relay", "docs", "none", "Document webhook retries"],
  ["atlas", "cleanup", "decide", "Split the import parser"],
].map(([repo, blueprint, attention, title], index) => ({
  repo: `/demo/${repo}`,
  label: repo,
  id: `demo-${index + 1}`,
  blueprint,
  attention,
  title,
}));

const DEMO_PR = {
  body: "## Summary\n\nSample changes and tests for review. This PR is **not real**.\n\n## Changes\n\n- Handles empty exports\n- Quotes values that contain commas, see `toCsv`\n\n## Verification\n\n- [x] `pnpm test` passes\n- [ ] Checked in a spreadsheet app\n\nLevel: skim\n",
  diff: `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -10,7 +10,9 @@ export function toCsv(rows: string[][]) {
-  return rows.map((row) => row.join(",")).join("\\n");
+  if (rows.length === 0) return "";
+  const quote = (value: string) => (/[",\\n]/.test(value) ? \`"\${value.replaceAll('"', '""')}"\` : value);
+  return rows.map((row) => row.map(quote).join(",")).join("\\n");
 }
diff --git a/tests/index.test.ts b/tests/index.test.ts
--- a/tests/index.test.ts
+++ b/tests/index.test.ts
@@ -1,3 +1,7 @@
 import { toCsv } from "../src/index.ts";
+
+test("empty export", () => expect(toCsv([])).toBe(""));
+test("quotes commas", () => expect(toCsv([["a,b"]])).toBe('"a,b"'));
`,
};

type ChatMessage = PiRecord["message"];

const tool = (id: string, name: string, args: Record<string, unknown>, output: string) => ({
  call: { type: "toolCall" as const, id, name, arguments: args },
  result: {
    role: "toolResult" as const,
    toolCallId: id,
    content: [{ type: "text" as const, text: output }],
    isError: false,
  },
});

/** A finished review by the Live Agent, so its tool steps show without an agent. */
function demoTranscript(): ChatMessage[] {
  const steps = [
    tool(
      "t1",
      "bash",
      {
        command:
          "factory report --json | jq '.jobs[] | select(.state == \"done\") | {id, title: .item.title, pr: .attempts[-1].url}'",
      },
      '{ "id": "result1", "title": "Add CSV export tests", "pr": "https://example.com/demo/pull/1" }\n{ "id": "result2", "title": "Check the quickstart links", "pr": "https://example.com/demo/pull/2" }',
    ),
    tool(
      "t2",
      "bash",
      {
        command:
          "gh pr view https://example.com/demo/pull/1 --json title,mergeable,statusCheckRollup,files --jq '{title, mergeable, checks: [.statusCheckRollup[].conclusion]}'",
      },
      '{ "title": "Add CSV export tests", "mergeable": "MERGEABLE", "checks": ["SUCCESS", "SUCCESS"] }',
    ),
    tool(
      "t3",
      "read",
      { path: "/demo/atlas/src/export/csv.ts" },
      "export function toCsv(rows: string[][]) { ... }",
    ),
    tool(
      "t4",
      "web_search",
      { queries: ["RFC 4180 line endings", "Excel CSV quoted newline import"] },
      "RFC 4180 https://www.rfc-editor.org/rfc/rfc4180\nExcel import notes https://support.microsoft.com/",
    ),
  ];
  return [
    { role: "user", content: "Review today's results and merge what's ready." },
    { role: "assistant", content: steps.map((step) => step.call) },
    ...steps.map((step) => step.result),
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Two results have PRs:\n\n- **Add CSV export tests** passes its checks and quotes values the way RFC 4180 asks. I'd merge it.\n- **Check the quickstart links** has conflicts, so the merge train is rebasing it first.\n\nShould I put the CSV tests on the merge train?",
        },
      ],
    },
  ];
}

/** The Live Agent's chats, the current one replayed to every page that listens; new messages get a canned reply. */
function demoChat() {
  const hour = 3_600_000;
  const exchange = (question: string, answer: string): ChatMessage[] => [
    { role: "user", content: question },
    { role: "assistant", content: [{ type: "text", text: answer }] },
  ];
  const chats = [
    {
      id: "tonight",
      agent: "pi",
      title: "Pick jobs for tonight",
      lastActive: Date.now() - 0.1 * hour,
      messages: demoTranscript(),
    },
    {
      id: "tasks",
      agent: "claude",
      title: "Why did the tasks sync job fail twice?",
      lastActive: Date.now() - 2 * hour,
      messages: exchange(
        "Why did the tasks sync job fail twice?",
        "Both runs hit an expired token halfway through. A retry with a fresh token fixes it.",
      ),
    },
    {
      id: "split",
      agent: "pi",
      title: "Split the jobs.ts refactor into smaller jobs",
      lastActive: Date.now() - 50 * hour,
      messages: exchange(
        "The jobs.ts refactor is too big for one run. Split it?",
        "Three jobs: move limit parsing out, then the runner, then rename the session types.",
      ),
    },
  ];
  let current: string | undefined = "tonight";
  const pages = new Set<ServerResponse>();
  const send = (page: ServerResponse, record: PiRecord) =>
    page.write(`data: ${JSON.stringify(record)}\n\n`);
  const model = {
    type: "response",
    success: true,
    command: "get_state",
    data: { model: { name: "GPT-6.2 Sol" }, thinkingLevel: "high" },
  };
  const listing = () => ({
    type: "chats",
    current,
    chats: chats.map(({ id, agent, title, lastActive }) => ({ id, agent, title, lastActive })),
  });
  const messagesOf = () => chats.find((each) => each.id === current)?.messages ?? [];
  const replay = (page: ServerResponse) => {
    send(page, listing());
    send(page, model);
    for (const message of messagesOf()) send(page, { type: "message_start", message });
  };
  const show = (id: string | undefined) => {
    current = id;
    for (const page of pages) {
      send(page, { type: "reset" });
      replay(page);
    }
    return null;
  };
  return {
    listen(page: ServerResponse) {
      page.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      page.write(": connected\n\n");
      replay(page);
      pages.add(page);
      page.on("close", () => pages.delete(page));
    },
    say({
      message: text,
      images = [],
    }: {
      message: string;
      images?: { data: string; mimeType: string }[];
    }) {
      if (!current) {
        current = randomUUID();
        chats.unshift({
          id: current,
          agent: "pi",
          title: text.split("\n")[0].slice(0, 60),
          lastActive: 0,
          messages: [],
        });
      }
      const chat = chats.find((each) => each.id === current)!;
      chat.lastActive = Date.now();
      chat.messages.push(
        {
          role: "user",
          content: [
            { type: "text", text },
            ...images.map((image) => ({ type: "image" as const, ...image })),
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "This is the demo, so no agent runs here. In the real factory I'd start with [the first result](factory:job/result1), then compare:\n\n| Job | State | Next |\n|---|---|---|\n| [First result](factory:job/result1) | review | merge |\n| [Failed run](factory:job/result3) | failed | retry |\n\nI'd run `factory merge` once you agree.",
            },
          ],
        },
      );
      return show(current);
    },
    open: (id: string) => show(id),
    fresh: () => show(undefined),
  };
}

const chat = demoChat();

export function demoApi(): Plugin {
  return {
    name: "factory-demo",
    apply: "serve",
    transformIndexHtml: (html) =>
      html.replace("<title>Factory</title>", "<title>Factory (demo)</title>"),
    configureServer(server) {
      const snapshot = seed();
      server.middlewares.use(async (request, response, next) => {
        const { pathname: path, searchParams } = new URL(request.url ?? "/", "http://localhost");
        if (path.startsWith("/runs/")) {
          const attempt = snapshot.jobs
            .flatMap((job) => job.attempts)
            .find(
              ({ log }) =>
                path === `/${log}` || path === `/${log.replace(/agent\.log$/, "prompt.md")}`,
            );
          response.writeHead(attempt ? 200 : 404, { "content-type": "text/plain; charset=utf-8" });
          return response.end(
            attempt
              ? path.endsWith("prompt.md")
                ? "Demo prompt: review the sample task and run tests.\n"
                : `${attempt.error ?? "Reviewed the sample task.\n\nChanges\n  Added coverage for empty exports and quoted values.\n\nVerification\n  ✓ All 12 tests passed.\n  Opened a demo PR for review."}\n`
              : "not found",
          );
        }
        if (!path.startsWith("/api/")) return next();
        if (`${request.method} ${path}` === "GET /api/chat") return chat.listen(response);
        try {
          let text = "";
          for await (const chunk of request) text += chunk;
          const result = dispatch(
            snapshot,
            `${request.method} ${path}`,
            text ? JSON.parse(text) : undefined,
            searchParams,
          );
          response.writeHead(result === undefined ? 404 : 200, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          return response.end(
            JSON.stringify(result === undefined ? { error: "Unknown demo endpoint" } : result),
          );
        } catch (error) {
          response.writeHead(400, { "content-type": "application/json" });
          return response.end(JSON.stringify({ error: (error as Error).message }));
        }
      });
    },
  };
}

function dispatch(
  snapshot: DemoState,
  route: string,
  body: unknown,
  query: URLSearchParams,
): unknown {
  const { jobs } = snapshot;
  switch (route) {
    case "GET /api/state": {
      const shown = liveJobs(jobs, snapshot.prs, items, snapshot.status);
      return { ...snapshot, jobs: shown, ...jobContext(jobs, shown) };
    }
    case "GET /api/results":
      return resultsPage(
        process.cwd(),
        jobs,
        query.get("repo"),
        Number(query.get("limit") ?? RESULTS_BATCH_SIZE),
        (urls) =>
          Object.fromEntries(
            urls.flatMap((url) => (snapshot.prs[url] ? [[url, snapshot.prs[url]]] : [])),
          ),
        snapshot.train,
      );
    case "GET /api/projects":
      return [...new Set(items.map((item) => item.repo))].sort();
    case "GET /api/candidates":
      return {
        at: snapshot.candidates.at,
        items,
        repos: [...new Set(items.map((item) => item.repo))].sort(),
        root: "/home/me/src",
      };
    case "POST /api/goals":
    case "POST /api/goals/import":
      throw new Error("The demo doesn't plan or import goals.");
    case "POST /api/jobs/own":
      throw new Error("The demo doesn't queue jobs of your own.");
    case "POST /api/candidates/refresh":
      snapshot.candidates.at = new Date().toISOString();
      return null;
    case "GET /api/blueprints":
      return [
        ["tests", "Adds a behavior test for something no test covers yet.", false],
        ["docs", "Fixes docs that disagree with what the code does.", false],
        ["cleanup", "Cuts dead paths and needless layers from a batch of files.", true],
      ].map(([name, description, custom]) => ({
        name,
        description,
        custom,
        attention: "skim",
        finder: "scan",
        done: "checks pass",
        onRequest: false,
        prompt: `Demo blueprint: ${description}`,
      }));
    case "POST /api/candidates/prompt": {
      const { id } = body as Pick<Item, "id">;
      const item = items.find((each) => each.id === id);
      return `# workwork: ${id}\n\nBlueprint: ${item?.blueprint}\nAttention: ${item?.attention}\n\n## Task\n\nDemo task: ${item?.title?.toLowerCase()}. Keep the change small and covered by a test.\n\n## Done when\n\n- \`pnpm test\` passes.\n\n## Deliver\n\n- One commit, pushed as a PR labeled \`workwork\`.\n\n## Standard\n\nNot shown in the page.\n`;
    }
    case "POST /api/jobs": {
      const selection = body as { items: Pick<Item, "repo" | "id">[]; pin?: Pin };
      for (const wanted of selection.items) {
        const item = items.find(({ repo, id }) => repo === wanted.repo && id === wanted.id);
        if (!item || jobs.some((job) => job.item === item && job.state !== "removed")) continue;
        jobs.push({
          ...BLANK,
          id: randomUUID().replaceAll("-", ""),
          item,
          source: "pick",
          state: "queued",
          added: new Date().toISOString(),
          ...selection.pin,
          attempts: [],
          notes: [],
        });
      }
      return null;
    }
    case "GET /api/models":
      return {
        claude: [
          {
            value: "opus",
            label: "Opus 5.5",
            efforts: ["low", "medium", "high", "xhigh", "max"],
            scoped: true,
          },
          {
            value: "sonnet",
            label: "Sonnet 5.5",
            efforts: ["low", "medium", "high"],
            scoped: true,
          },
        ],
        pi: [
          {
            value: "openai/gpt-6.2-sol",
            label: "GPT-6.2 Sol",
            efforts: ["low", "medium", "high", "xhigh", "max"],
            scoped: true,
          },
          {
            value: "openai-codex/gpt-6-luna",
            label: "GPT-6 Luna",
            efforts: ["low", "medium", "high", "xhigh", "max"],
            scoped: true,
          },
          ...["GPT-5.2", "GPT-6.1 Terra", "DeepSeek V4 Pro", "Qwen3.8 Flash"].map((label) => ({
            value: `openrouter/${label.toLowerCase().replaceAll(" ", "-")}`,
            label,
            efforts: ["off", "low", "medium", "high"],
            scoped: false,
          })),
        ],
      };
    case "GET /api/github-profile":
      return { name: "Demo User", email: "12345+demo-user@users.noreply.github.com" };
    case "PUT /api/settings":
      snapshot.settings = checkSettings(body as Settings);
      return null;
    case "POST /api/on": {
      const { workers, until, limit } = body as RunRequest;
      const since = new Date().toISOString();
      const slots = presetWorkers(snapshot.settings.presets, workers).map((worker) => ({
        ...worker,
        reason: "Demo mode: no agents are launched",
      }));
      // The goal's CSV step shows as running on the first worker of its tier.
      const busy = slots.find((worker) => worker.preset === "luna");
      if (busy)
        Object.assign(busy, {
          state: "working",
          job: "csv",
          since: new Date(Date.now() - 7 * 60_000).toISOString(),
          activity: "Running pnpm test src/csv",
          context: 48_000,
          reason: undefined,
        });
      snapshot.on = true;
      snapshot.status = {
        pid: 0,
        run: since.slice(0, 19).replaceAll(":", ""),
        until,
        limit,
        idle: snapshot.settings.idle,
        pools: [...new Set(slots.map((slot) => slot.pool))].map((name) => ({ name, limits: 0 })),
        workers: slots,
      };
      return null;
    }
    case "POST /api/off":
      snapshot.on = false;
      return null;
    case "POST /api/train":
      for (const id of (body as { ids: string[] }).ids) snapshot.train[id] = { step: "queued" };
      return null;
    case "POST /api/chat":
      return chat.say(body as { message: string; images?: { data: string; mimeType: string }[] });
    case "POST /api/chat/new":
      return chat.fresh();
    case "POST /api/chat/open":
      return chat.open((body as { id: string }).id);
    case "POST /api/chat/abort":
    case "POST /api/chat/answer":
      return null;
  }
  if (/^GET \/api\/jobs\/\w+\/pr$/.test(route)) return DEMO_PR;
  const prompt = /^GET \/api\/jobs\/(\w+)\/prompt$/.exec(route);
  if (prompt) {
    const job = jobs.find((entry) => entry.id === prompt[1]);
    return (
      job?.prompt ??
      `# workwork: ${job?.item.id}\n\n## Task\n\nDemo task: ${job?.item.title.toLowerCase()}.\n`
    );
  }
  const match =
    /^POST \/api\/jobs\/(\w+)\/(remove|retry|move|merge|rebase|close|answer|approve|pause|resume|cancel|replan|verify|pin)$/.exec(
      route,
    );
  if (!match) return undefined;
  const [, id, action] = match;
  const job = jobs.find((entry) => entry.id === id && entry.state !== "removed");
  if (!job) throw new Error(`No demo job ${id}`);
  switch (action) {
    case "remove":
      job.state = "removed";
      break;
    case "pin":
      for (const key of ["agent", "model", "effort", "preset", "tier"] as const) delete job[key];
      Object.assign(job, body as Pin);
      break;
    case "retry":
    case "resume":
    case "approve":
      job.state = "queued";
      job.blocked = undefined;
      break;
    case "pause":
      job.state = "blocked";
      job.blocked = "paused";
      break;
    case "cancel":
      job.state = "removed";
      break;
    case "replan":
      job.notes.push({
        at: new Date().toISOString(),
        attempt: 0,
        kind: "factory",
        text: `replan queued: ${(body as { why: string }).why}`,
      });
      break;
    case "verify": {
      const { need } = body as { need?: string };
      job.unverified = need ? job.unverified.filter((each) => each !== need) : [];
      break;
    }
    case "answer": {
      const { text } = body as { text: string };
      const assumed = job.notes.findIndex((note) => note.kind === "assume");
      const re = job.state === "blocked" || assumed < 0 ? undefined : assumed;
      job.notes.push({ at: new Date().toISOString(), attempt: 1, kind: "answer", text, re });
      if (re === undefined) job.state = "queued";
      break;
    }
    case "move": {
      const { index } = body as { index: number };
      const target = jobs.filter((entry) => entry.state === "queued" && entry.source === "pick")[
        index
      ];
      if (target) {
        const position = jobs.indexOf(target);
        jobs.splice(jobs.indexOf(job), 1);
        jobs.splice(position, 0, job);
      }
      break;
    }
    case "merge":
    case "rebase":
    case "close": {
      const url = prUrl(job);
      const pr = url && snapshot.prs[url];
      if (
        !pr ||
        pr.state !== "OPEN" ||
        (action === "merge" && !canMerge(pr)) ||
        (action === "rebase" && !canRebase(pr))
      ) {
        throw new Error(`Demo PR is not ready to ${action}`);
      }
      if (action === "rebase") {
        pr.conflicts = false;
        pr.checks = "passing";
      } else {
        pr.state = action === "merge" ? "MERGED" : "CLOSED";
      }
      break;
    }
  }
  return null;
}

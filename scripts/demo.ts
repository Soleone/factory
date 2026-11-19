import { randomUUID } from "node:crypto";
import type { Plugin } from "vite-plus";
import {
  canMerge,
  canRebase,
  prUrl,
  type Item,
  type Job,
  type Preset,
  type Settings,
  type Snapshot,
} from "../src/backend/types.ts";

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
};

function seed(): Snapshot {
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
    })),
    ...items.slice(3, 7).map((item, index): Job => {
      const id = `result${index + 1}`;
      const failed = index === 2;
      return {
        id,
        item,
        source: "pick",
        agent: "pi",
        added: at,
        state: failed ? "failed" : index === 3 ? "blocked" : "done",
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
  ];
  return {
    on: false,
    status: null,
    jobs,
    settings: {
      agents: { claude: {}, pi: {} },
      chat: { agent: "pi" },
      presets: [{ agent: "pi", effort: "max" }],
      limit: 2,
      timeout: 60,
      auto: { on: true, levels: ["auto"], plays: [], repos: [] },
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
    train: {},
  };
}

const items: Item[] = [
  ["atlas", "tests", "skim", "Cover empty search results"],
  ["atlas", "docs", "auto", "Document the export format"],
  ["relay", "cleanup", "auto", "Remove unused retry settings"],
  ["atlas", "tests", "skim", "Add CSV export tests"],
  ["relay", "cleanup", "decide", "Simplify request logging"],
  ["relay", "tests", "skim", "Test reconnect after timeout"],
  ["atlas", "docs", "auto", "Check the quickstart links"],
  ["relay", "docs", "auto", "Document webhook retries"],
  ["atlas", "cleanup", "decide", "Split the import parser"],
].map(([repo, play, level, title], index) => ({
  repo: `/demo/${repo}`,
  label: repo,
  id: `demo-${index + 1}`,
  play,
  level,
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

export function demoApi(): Plugin {
  return {
    name: "factory-demo",
    apply: "serve",
    transformIndexHtml: (html) =>
      html.replace("<title>Factory</title>", "<title>Factory (demo)</title>"),
    configureServer(server) {
      const snapshot = seed();
      server.middlewares.use(async (request, response, next) => {
        const path = new URL(request.url ?? "/", "http://localhost").pathname;
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
        try {
          let text = "";
          for await (const chunk of request) text += chunk;
          const result = dispatch(
            snapshot,
            `${request.method} ${path}`,
            text ? JSON.parse(text) : undefined,
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

function dispatch(snapshot: Snapshot, route: string, body: unknown): unknown {
  const { jobs } = snapshot;
  switch (route) {
    case "GET /api/state":
      return snapshot;
    case "GET /api/candidates":
      return {
        at: snapshot.candidates.at,
        items,
        repos: [...new Set(items.map((item) => item.repo))].sort(),
      };
    case "POST /api/candidates/refresh":
      snapshot.candidates.at = new Date().toISOString();
      return null;
    case "GET /api/plays":
      return [
        { name: "tests", description: "Adds a behavior test for something no test covers yet." },
        { name: "docs", description: "Fixes docs that disagree with what the code does." },
        { name: "cleanup", description: "Cuts dead paths and needless layers from one file." },
      ];
    case "POST /api/candidates/prompt": {
      const { id } = body as Pick<Item, "id">;
      const item = items.find((each) => each.id === id);
      return `# workwork: ${id}\n\nPlay: ${item?.play}\nLevel: ${item?.level}\n\n## Task\n\nDemo task: ${item?.title?.toLowerCase()}. Keep the change small and covered by a test.\n\n## Done when\n\n- \`pnpm test\` passes.\n\n## Deliver\n\n- One commit, pushed as a PR labeled \`workwork\`.\n\n## Standard\n\nNot shown in the page.\n`;
    }
    case "POST /api/jobs": {
      const selection = body as { items: Pick<Item, "repo" | "id">[]; pin?: Preset };
      for (const wanted of selection.items) {
        const item = items.find(({ repo, id }) => repo === wanted.repo && id === wanted.id);
        if (!item || jobs.some((job) => job.item === item && job.state !== "removed")) continue;
        jobs.push({
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
    case "PUT /api/settings":
      snapshot.settings = body as Settings;
      return null;
    case "POST /api/on": {
      const { agents, until, limit } = body as Pick<Settings, "agents" | "until" | "limit">;
      const since = new Date().toISOString();
      snapshot.on = true;
      snapshot.status = {
        pid: 0,
        run: since.slice(0, 19).replaceAll(":", ""),
        until,
        limit,
        timeout: snapshot.settings.timeout,
        workers: Object.entries(agents).map(([agent, tuning]) => ({
          agent,
          ...tuning,
          state: "idle",
          since,
          limits: 0,
          reason: "Demo mode: no agents are launched",
        })),
      };
      return null;
    }
    case "POST /api/off":
      snapshot.on = false;
      return null;
  }
  if (/^GET \/api\/jobs\/\w+\/pr$/.test(route)) return DEMO_PR;
  const match = /^POST \/api\/jobs\/(\w+)\/(remove|retry|move|merge|rebase|close|answer)$/.exec(
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
    case "retry":
      job.state = "queued";
      break;
    case "answer": {
      const { text } = body as { text: string };
      job.notes.push({ at: new Date().toISOString(), attempt: 1, kind: "answer", text });
      job.state = "queued";
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

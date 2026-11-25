import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { addJobs, readJobs, type Event } from "../src/backend/jobs.ts";
import { agentModels } from "../src/backend/models.ts";
import { readSettings, writeSettings } from "../src/backend/state.ts";
import {
  onTrain,
  RESULTS_BATCH_SIZE,
  type Job,
  type ResultsPage,
  type Settings,
  type Snapshot,
  type TrainCar,
} from "../src/backend/types.ts";
import { serve } from "../src/backend/web.ts";
import { webJob } from "../src/backend/webHistory.ts";
import { inbox } from "../src/inbox.ts";
import {
  scratch,
  NOW,
  MINUTE,
  sh,
  script,
  agents,
  gh,
  repoWithOrigin,
  setup,
  options,
  work,
  RESULT,
  OK,
  OPEN_PR,
} from "./harness.ts";

describe("the factory", () => {
  test("a running job tells the page once its handed-off agent has exited", () => {
    const state = mkdtempSync(join(scratch, "exited-"));
    const dir = join(state, "attempt");
    mkdirSync(join(state, "running"), { recursive: true });
    mkdirSync(dir);
    writeFileSync(join(state, "running", "job1.json"), JSON.stringify({ dir }));
    const job = { id: "job1", state: "running", attempts: [] } as unknown as Job;
    expect(webJob(state, job).exited).toBeUndefined();
    writeFileSync(join(dir, "exit"), "0");
    expect(webJob(state, job).exited).toBe(true);
    expect(webJob(state, { ...job, state: "done" }).exited).toBeUndefined();
  });

  test("GitHub profile suggestions do not save; commit identity can be saved, reloaded and cleared", async () => {
    const state = mkdtempSync(join(scratch, "state-"));
    const bin = mkdtempSync(join(scratch, "profile-"));
    process.env.PATH = bin;
    const server = serve(state, 0, "127.0.0.1", () => ({}));
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/api`;
    const profile = () => fetch(`${url}/github-profile`);
    const save = (commitIdentity: Settings["commitIdentity"]) =>
      fetch(`${url}/settings`, {
        method: "PUT",
        body: JSON.stringify({ ...readSettings(state), commitIdentity }),
      });
    const saved = async () => ((await (await fetch(`${url}/state`)).json()) as Snapshot).settings;
    try {
      expect(await (await profile()).json()).toMatchObject({
        error: expect.stringContaining("not installed"),
      });
      script(bin, "gh", "echo private-diagnostic >&2; exit 1");
      expect(await (await profile()).json()).toEqual({
        error:
          "Could not read the GitHub profile. Sign in with gh auth login and try again, or enter your name and email manually.",
      });
      expect((await save({ name: "Manual User ", email: " manual@example.com " })).ok).toBe(true);
      const manual = { name: "Manual User", email: "manual@example.com" };
      expect(readSettings(state).commitIdentity).toEqual(manual);
      expect((await saved()).commitIdentity).toEqual(manual);

      for (const name of ["Public Name", null]) {
        script(
          bin,
          "gh",
          `test "$*" = 'api --hostname github.com user --jq {name, login, id}' || exit 1\necho '${JSON.stringify({ name, login: "octocat", id: 42 })}'`,
        );
        expect(await (await profile()).json()).toEqual({
          name: name ?? "octocat",
          email: "42+octocat@users.noreply.github.com",
        });
        expect(readSettings(state).commitIdentity).toEqual(manual);
      }
      for (const identity of [
        { name: "Missing email", email: "" },
        { name: "Manual User", email: "invalid" },
      ]) {
        expect((await save(identity)).status).toBe(400);
        expect(readSettings(state).commitIdentity).toEqual(manual);
      }
      expect((await save({ name: "", email: "" })).ok).toBe(true);
      expect((await saved()).commitIdentity).toBeUndefined();
      expect(readSettings(state).triggers).toEqual({ ci: true, label: "factory", reviews: true });
    } finally {
      server.close();
    }
  });

  test("serve lists a newly cloned repo even when workwork finds no candidates", async () => {
    const source = mkdtempSync(join(scratch, "src-"));
    const state = mkdtempSync(join(scratch, "state-"));
    const { origin } = repoWithOrigin();
    const bin = mkdtempSync(join(scratch, "bin-"));
    script(bin, "gh", `git clone -q '${origin}' "$4"`);
    script(bin, "workwork", "echo '[]'");
    process.env.PATH = `${bin}:${process.env.PATH}`;
    const previousSource = process.env.SRC;
    process.env.SRC = source;
    const server = serve(state, 0, "127.0.0.1", () => ({}));
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/api`;
    const candidates = async () => (await fetch(`${url}/candidates`)).json();
    const projects = async () => (await fetch(`${url}/projects`)).json();
    try {
      expect(await candidates()).toEqual({
        at: null,
        scans: {},
        items: [],
        repos: [],
        root: source,
      });
      expect(await projects()).toEqual([]);
      const response = await fetch(`${url}/repos/clone`, {
        method: "POST",
        body: JSON.stringify({ name: "owner/new-app" }),
      });
      expect(response.status).toBe(200);
      const repos = [join(source, "new-app")];
      expect(await projects()).toEqual(repos);
      expect(await candidates()).toMatchObject({ items: [], repos });
      const query = new URLSearchParams({ repo: repos[0] });
      const results = await (await fetch(`${url}/results?${query.toString()}`)).json();
      expect(results).toMatchObject({ repo: repos[0], running: [], finished: [], total: 0 });
      await expect.poll(candidates).toEqual({
        at: null,
        scans: { [repos[0]]: expect.any(String) },
        items: [],
        repos,
        root: source,
      });
    } finally {
      server.close();
      if (previousSource === undefined) delete process.env.SRC;
      else process.env.SRC = previousSource;
    }
  });

  test("serve starts a goal in a new project: the repo under $SRC, pushed to a new origin", async () => {
    const source = mkdtempSync(join(scratch, "src-"));
    const state = mkdtempSync(join(scratch, "state-"));
    const origin = join(mkdtempSync(join(scratch, "origin-")), "units.git");
    sh(scratch, "git", "init", "-q", "--bare", origin);
    const bin = mkdtempSync(join(scratch, "bin-"));
    script(bin, "gh", `git remote add origin '${origin}' && git push -q -u origin main`);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    const previousSource = process.env.SRC;
    process.env.SRC = source;
    const server = serve(state, 0, "127.0.0.1", () => ({}));
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const post = (body: object) =>
      fetch(`http://127.0.0.1:${port}/api/goals`, { method: "POST", body: JSON.stringify(body) });
    try {
      const response = await post({ title: "Units", brief: "Convert units.", project: "units" });
      expect(response.status).toBe(200);
      const goal = readJobs(state).find((job) => job.goal)!;
      expect(goal.goal).toMatchObject({ repo: join(source, "units"), summary: "Convert units." });
      expect(sh(origin, "git", "log", "--format=%s", "main")).toBe("init\n");
      expect((await post({ title: "Again", brief: "", project: "units" })).status).toBe(400);
    } finally {
      server.close();
      if (previousSource === undefined) delete process.env.SRC;
      else process.env.SRC = previousSource;
    }
  });

  test("serve queues a job of your own for a tier, titled by its prompt unless given one", async () => {
    const base = setup([]);
    const server = serve(base.state, 0, "127.0.0.1", () => ({}));
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const post = (body: object) =>
      fetch(`http://127.0.0.1:${port}/api/jobs/own`, {
        method: "POST",
        body: JSON.stringify({ repo: base.repo, title: "", ...body }),
      });
    try {
      expect((await post({ tier: "builder", prompt: "\n# Compare runs\nRead only." })).status).toBe(
        200,
      );
      expect((await post({ tier: "boss", prompt: "Do it." })).status).toBe(400);
      expect((await post({ tier: "grunt", prompt: "  " })).status).toBe(400);
      expect(readJobs(base.state).map((job) => [job.item.title, job.tier, job.source])).toEqual([
        ["Compare runs", "builder", "pick"],
      ]);
    } finally {
      server.close();
    }
  });

  test("serve asks workwork about one project or one blueprint alone, and hides what the user dismisses", async () => {
    const state = mkdtempSync(join(scratch, "state-"));
    const [mine, other] = [
      mkdtempSync(join(scratch, "mine-")),
      mkdtempSync(join(scratch, "other-")),
    ];
    const item = (repo: string, id: string, blueprint = "bug-sweep") => ({
      repo,
      label: repo,
      id: `${blueprint}/${id}`,
      blueprint,
      attention: "skim",
      title: id,
    });
    const at = "2026-01-01T00:00:00.000Z";
    writeFileSync(
      join(state, "candidates.json"),
      JSON.stringify({
        at,
        items: [item(mine, "old"), item(mine, "old", "accessibility"), item(other, "kept")],
      }),
    );
    const bin = mkdtempSync(join(scratch, "bin-"));
    const calls = join(bin, "calls");
    script(
      bin,
      "workwork",
      `echo "$PWD $*" >> ${calls}
case "$1" in
  blueprints) echo '[{"name":"accessibility","onRequest":true}]' ;;
  --blueprint) echo '${JSON.stringify([item(mine, "new", "accessibility")])}' ;;
  --json) echo '${JSON.stringify([item(mine, "new")])}' ;;
esac`,
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;
    const server = serve(state, 0, "127.0.0.1", () => ({}));
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/api`;
    const post = (path: string, body: unknown) =>
      fetch(`${url}/candidates/${path}`, { method: "POST", body: JSON.stringify(body) });
    const candidates = async () =>
      (await (await fetch(`${url}/candidates`)).json()) as { items: unknown[] };
    try {
      expect((await post("refresh", { repo: join(scratch, "elsewhere") })).status).toBe(400);
      // A plain scan keeps what only an on-request blueprint finds.
      await post("refresh", { repo: mine });
      await expect.poll(candidates).toMatchObject({
        at,
        scans: { [mine]: expect.any(String) },
        items: [item(mine, "old", "accessibility"), item(other, "kept"), item(mine, "new")],
      });
      await post("refresh", { repo: mine, blueprint: "accessibility" });
      await expect.poll(candidates).toMatchObject({
        scans: { [`${mine} accessibility`]: expect.any(String) },
        items: [item(other, "kept"), item(mine, "new"), item(mine, "new", "accessibility")],
      });

      const dismissed = [{ repo: mine, id: "bug-sweep/new" }];
      expect((await post("decide", { items: dismissed, verdict: "keep" })).status).toBe(400);
      expect((await post("decide", { items: dismissed, verdict: "reject" })).status).toBe(200);
      expect(readFileSync(calls, "utf8")).toContain(`${mine} decide bug-sweep/new reject`);
      expect((await candidates()).items).toEqual([
        item(other, "kept"),
        item(mine, "new", "accessibility"),
      ]);
    } finally {
      server.close();
    }
  });

  test("serve sweeps every repo of the user's under $SRC, and only those", async () => {
    const source = mkdtempSync(join(scratch, "src-"));
    const state = mkdtempSync(join(scratch, "state-"));
    const repo = (name: string, origin: string) => {
      const path = join(source, name);
      mkdirSync(path);
      sh(path, "git", "init", "-q");
      sh(path, "git", "remote", "add", "origin", origin);
      return path;
    };
    const mine = repo("app", "git@github.com:me/app.git");
    repo("fork", "https://github.com/someone/fork");
    writeFileSync(
      join(state, "candidates.json"),
      JSON.stringify({ at: "", items: [{ repo: join(source, "gone"), id: "x/y" }] }),
    );
    const bin = mkdtempSync(join(scratch, "bin-"));
    script(bin, "gh", `echo '[{"nameWithOwner":"Me/app","description":"","createdAt":""}]'`);
    script(
      bin,
      "workwork",
      `case "$1" in
  blueprints) echo '[]' ;;
  *) echo '[{"repo":"'"$PWD"'","label":"app","id":"todo/a","blueprint":"todo","attention":"decide","title":"a"}]' ;;
esac`,
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;
    const previousSource = process.env.SRC;
    process.env.SRC = source;
    const server = serve(state, 0, "127.0.0.1", () => ({}));
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/api`;
    try {
      await fetch(`${url}/candidates/refresh`, { method: "POST", body: "{}" });
      await expect
        .poll(async () => (await fetch(`${url}/candidates`)).json())
        .toMatchObject({ at: expect.any(String), items: [{ repo: mine, id: "todo/a" }] });
      const { candidates } = (await (await fetch(`${url}/state`)).json()) as Snapshot;
      expect(candidates.refreshing).toEqual([]);
    } finally {
      server.close();
      if (previousSource === undefined) delete process.env.SRC;
      else process.env.SRC = previousSource;
    }
  });

  test("serve queues cached candidates and shows the results and their logs, nothing outside runs/", async () => {
    const base = setup(["a"]);
    agents({ claude: OK });
    writeFileSync(
      join(base.state, "candidates.json"),
      JSON.stringify({ at: new Date().toISOString(), items: base.items }),
    );
    const server = serve(base.state, 0, "127.0.0.1", () => ({}));
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const url = (path: string) => `http://127.0.0.1:${port}${path}`;
    try {
      const post = (path: string, body: unknown) =>
        fetch(url(path), { method: "POST", body: JSON.stringify(body) });
      expect((await post("/api/jobs", { items: [{ repo: base.repo, id: "nope" }] })).status).toBe(
        400,
      );
      await post("/api/jobs", { items: [{ repo: base.repo, id: "a" }] });
      await work(options(base));
      const { jobs } = (await (await fetch(url("/api/state"))).json()) as { jobs: Job[] };
      expect(jobs.map((job) => [job.item.id, job.state])).toEqual([["a", "done"]]);
      expect(await (await fetch(url(`/${jobs[0].attempts[0].log}`))).text()).toContain("pull/7");
      expect(await (await fetch(url("/runs/%2E%2E/jobs.jsonl"))).text()).not.toContain('"add"');
    } finally {
      server.close();
    }
  });

  test("polls a bounded projection and reads older results and actions on demand", async () => {
    const { state, repo } = setup([]);
    gh();
    const archived = `${repo}/archive`;
    const oldPr = "https://github.com/o/r/pull/7";
    const count = 1250;
    const events: Event[] = Array.from({ length: count }, (_, i): Event[] => {
      const id = `job${i}`;
      const at = new Date(NOW + i * MINUTE).toISOString();
      const item = {
        repo: i < 2 ? archived : repo,
        id,
        blueprint: "test",
        title: id,
        label: "test",
        attention: "none",
      };
      return [
        { at, type: "add", job: { id, item, source: "pick", prompt: `Prompt for ${id}` } },
        {
          at,
          type: "attempt",
          id,
          attempt: {
            run: "test",
            start: at,
            end: at,
            agent: "pi",
            outcome: "done",
            log: join(state, "runs", id, "agent.log"),
            ...(i === 1 ? { url: oldPr } : {}),
          },
        },
        { at, type: "note", id, note: { kind: "result", text: "x".repeat(1024) } },
      ];
    }).flat();
    // Old outcome, recent event: Activity must not simply pick the most recently finished jobs.
    events.push({
      at: new Date(NOW + count * MINUTE).toISOString(),
      type: "note",
      id: "job2",
      note: { kind: "note", text: "Recent update on an old job" },
    });
    const at = new Date(NOW).toISOString();
    const item = {
      repo,
      id: "goal",
      blueprint: "goal",
      title: "A goal",
      label: "test",
      attention: "none",
    };
    events.push(
      {
        at,
        type: "add",
        job: {
          id: "goal",
          item,
          source: "goal",
          goal: { repo, slug: "goal", summary: "Test", gates: [], allowUp: false },
        },
      },
      {
        at,
        type: "add",
        job: { id: "node", item: { ...item, id: "node" }, source: "goal", of: "goal" },
      },
      { at, type: "merged", id: "node" },
    );
    writeFileSync(
      join(state, "jobs.jsonl"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );

    const server = serve(state, 0, "127.0.0.1", () => ({}));
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const get = (path: string, etag?: string) =>
      fetch(`http://127.0.0.1:${port}${path}`, { headers: etag ? { "if-none-match": etag } : {} });
    try {
      // Wait until the PR cache has filled, so the validator isn't changed by that background read.
      await expect
        .poll(async () => ((await (await get("/api/state")).json()) as Snapshot).prs[oldPr]?.state)
        .toBe("OPEN");
      const response = await get("/api/state");
      const json = await response.text();
      const live = JSON.parse(json) as Snapshot;
      const all = readJobs(state);
      const oldSize = Buffer.byteLength(
        JSON.stringify({
          ...live,
          jobs: all.map((job) => webJob(state, job)),
          reviewed: undefined,
          queuedFollowups: undefined,
        }),
      );
      expect(Buffer.byteLength(json)).toBeLessThan(oldSize / 8);
      expect(live.jobs.map((job) => job.id)).toEqual(
        expect.arrayContaining(["job1", "job2", "goal", "node"]),
      );
      expect(live.jobs.some(({ id }) => id === "job0")).toBe(false);
      expect(inbox(live)).toEqual(
        inbox({ jobs: all.map((job) => webJob(state, job)), prs: live.prs }),
      );
      const firstResponse = await get("/api/results");
      const firstJson = await firstResponse.text();
      const first = JSON.parse(firstJson) as ResultsPage;
      expect(first.finished).toHaveLength(RESULTS_BATCH_SIZE);
      expect(first.finished[0].id).toBe(`job${count - 1}`);
      expect(first.total).toBe(count);
      expect(Buffer.byteLength(firstJson) + Buffer.byteLength(json)).toBeLessThan(oldSize / 3);
      for (const [path, previous] of [
        ["/api/state", response],
        ["/api/results", firstResponse],
      ] as const) {
        const poll = await get(path, previous.headers.get("etag")!);
        expect(poll.status).toBe(304);
        expect(await poll.text()).toBe("");
      }

      const more = (await (
        await get(`/api/results?limit=${RESULTS_BATCH_SIZE * 2}`)
      ).json()) as ResultsPage;
      expect(more.finished).toHaveLength(RESULTS_BATCH_SIZE * 2);
      expect(more.finished.slice(0, RESULTS_BATCH_SIZE)).toEqual(first.finished);
      expect(more.finished.at(-1)?.id).toBe(`job${count - RESULTS_BATCH_SIZE * 2}`);
      const expandedPath = `/api/results?limit=${count}`;
      const expanded = await get(expandedPath);
      expect(((await expanded.json()) as ResultsPage).finished.at(-1)?.id).toBe("job0");
      const expandedPoll = await get(expandedPath, expanded.headers.get("etag")!);
      expect(expandedPoll.status).toBe(304);
      expect(await expandedPoll.text()).toBe("");

      const oldPage = `/api/results?${new URLSearchParams({ repo: archived }).toString()}`;
      const old = (await (await get(oldPage)).json()) as ResultsPage;
      expect(old.finished.map(({ id }) => id)).toEqual(["job1", "job0"]);
      expect(old.finished.at(-1)?.attempts[0].log).toBe("runs/job0/agent.log");
      expect(await (await get("/api/jobs/job0/prompt")).json()).toBe("Prompt for job0");
      expect(old.prs[oldPr].state).toBe("OPEN");
      const merge = await fetch(`http://127.0.0.1:${port}/api/jobs/job1/merge`, { method: "POST" });
      expect(merge.status).toBe(200);
      const after = (await (await get(oldPage)).json()) as ResultsPage;
      expect(after.prs[oldPr].state).toBe("MERGED");
      const updated = await get("/api/state", response.headers.get("etag")!);
      expect(updated.status).toBe(200);
      expect(inbox((await updated.json()) as Snapshot).ready).toHaveLength(0);
      console.log(
        `History transfer (uncompressed JSON): ${oldSize} B full, ${Buffer.byteLength(json)} B shared state, ${Buffer.byteLength(firstJson)} B first Results window, 0 B unchanged polls`,
      );
    } finally {
      server.close();
    }
  });

  test("serve shows each job's PR and merges it only once GitHub says it's ready", async () => {
    const base = setup(["a"]);
    const github = gh({ statusCheckRollup: [{ conclusion: "" }] });
    agents({ claude: OK });
    const job = base.pick("a");
    await work(options(base));
    const server = serve(base.state, 0, "127.0.0.1", () => ({}));
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const url = (path: string) => `http://127.0.0.1:${port}${path}`;
    const pr = "https://github.com/o/r/pull/7";
    try {
      let prs: Snapshot["prs"] = {};
      // The first poll starts asking gh; a later one has the answer.
      while (!prs[pr]) {
        prs = ((await (await fetch(url("/api/state"))).json()) as Snapshot).prs;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(prs[pr]).toMatchObject({
        attention: "skim",
        checks: "pending",
        files: ["a.ts"],
        conflicts: false,
      });
      expect(await (await fetch(url(`/api/jobs/${job.id}/pr`))).json()).toEqual({
        body: OPEN_PR.body,
        diff: "+simpler a\n",
      });
      const merge = () => fetch(url(`/api/jobs/${job.id}/merge`), { method: "POST" });
      expect(await (await merge()).json()).toEqual({
        error: `${pr} isn't ready to merge: see it on GitHub`,
      });
      github.answer({ mergeable: "UNKNOWN" });
      expect((await merge()).status).toBe(400);
      github.answer({});
      expect((await merge()).status).toBe(200);
      expect(github.calls()).toContain(`pr merge ${pr} --squash --delete-branch`);
      const after = (await (await fetch(url("/api/state"))).json()) as Snapshot;
      expect(after.prs[pr].state).toBe("MERGED");
    } finally {
      server.close();
    }
  });

  test("the merge train merges one PR at a time and skips one that's no longer open", async () => {
    const base = setup(["a", "b"]);
    const github = gh();
    const count = join(mkdtempSync(join(scratch, "count-")), "n");
    agents({
      claude: `n=$(($(cat ${count} 2>/dev/null || echo 0) + 1)); echo $n > ${count}; echo "opened https://github.com/o/r/pull/$n"; ${RESULT}`,
    });
    const jobs = [base.pick("a"), base.pick("b")];
    await work(options(base));
    const server = serve(base.state, 0, "127.0.0.1", () => ({}));
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const url = (path: string) => `http://127.0.0.1:${port}${path}`;
    try {
      // Through the CLI, as the Live Agent does.
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["src/backend/cli.ts", "merge", ...jobs.map((job) => job.id)],
        { env: { ...process.env, DATA: scratch, FACTORY_URL: url("") } },
      );
      expect(stdout).toMatch(/^on the merge train/);
      let train: Snapshot["train"] = {};
      while (Object.keys(train).length < 2 || Object.values(train).some(onTrain)) {
        train = ((await (await fetch(url("/api/state"))).json()) as Snapshot).train;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // The fake gh answers the same for every PR, so the first merge closes the second.
      expect(train).toEqual({
        [jobs[0].id]: { step: "merged" },
        [jobs[1].id]: {
          step: "skipped",
          reason: "This pull request is already merged; no action needed",
        },
      });
      expect(github.calls().match(/pr merge/g)).toHaveLength(1);
      const said = readJobs(base.state).map((job) =>
        job.notes.filter((note) => note.kind === "train").map((note) => note.text),
      );
      expect(said).toEqual([
        ["merged"],
        ["skipped: This pull request is already merged; no action needed"],
      ]);
    } finally {
      server.close();
    }
  });

  test("the CLI reorders and pins the queue, as the Live Agent does", async () => {
    const data = mkdtempSync(join(scratch, "data-"));
    const base = setup(["a", "b"]);
    const state = join(data, "apps", "factory");
    mkdirSync(state, { recursive: true });
    const [a, b] = base.items.map((each) => addJobs(state, [each], "pick")[0]);
    const cli = (...args: string[]) =>
      promisify(execFile)(process.execPath, ["src/backend/cli.ts", ...args], {
        env: { ...process.env, DATA: data },
      });
    await cli("move", b.id, "1");
    await cli("pin", a.id, "--tier", "grunt");
    const queued = readJobs(state).filter((job) => job.state === "queued");
    expect(queued.map((job) => [job.id, job.tier])).toEqual([
      [b.id, undefined],
      [a.id, "grunt"],
    ]);
    await expect(cli("pin", a.id, "--tier", "boss")).rejects.toThrow(/--tier wants/);
  });

  test("factory inbox reads the running serve, and says how to start it when none runs", async () => {
    const data = mkdtempSync(join(scratch, "data-"));
    const state = join(data, "apps", "factory");
    mkdirSync(state, { recursive: true });
    const server = serve(state, 0, "127.0.0.1", () => ({}));
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const inbox = (url: string) =>
      promisify(execFile)(process.execPath, ["src/backend/cli.ts", "inbox"], {
        env: { ...process.env, DATA: data, FACTORY_URL: url },
      });
    try {
      const { stdout } = await inbox(`http://127.0.0.1:${port}`);
      expect(stdout).toMatch(/^Nothing waits on you/);
    } finally {
      server.close();
    }
    await once(server, "close");
    await expect(inbox(`http://127.0.0.1:${port}`)).rejects.toThrow(
      /no factory serve at .*start factory serve, or set FACTORY_URL/,
    );
  });

  /** Starts serve with a fake agent on PATH; `page` opens the Plan chat's event stream. */
  async function chatServer(
    name: string,
    fake: string,
    chat: Settings["chat"],
    state = setup([]).state,
  ) {
    writeSettings(state, { ...readSettings(state), chat });
    const bin = mkdtempSync(join(scratch, `${name}-`));
    script(bin, name, fake);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    const server = serve(state, 0, "127.0.0.1", () => ({}));
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/api/chat`;
    /** `until` resolves with the records up to the first of that type. */
    async function page() {
      const reader = (await fetch(url)).body!.pipeThrough(new TextDecoderStream()).getReader();
      let text = "";
      return async (type: string) => {
        for (;;) {
          // The list of chats comes along with every change; only a test that waits for it sees it.
          const records = [...text.matchAll(/^data: (.*)$/gm)]
            .map(([, json]) => JSON.parse(json))
            .filter((record) => type === "chats" || record.type !== "chats");
          const end = records.findIndex((record) => record.type === type);
          if (end >= 0) return records.slice(0, end + 1);
          text += (await reader.read()).value;
        }
      };
    }
    const prompt = (message: string) =>
      fetch(url, { method: "POST", body: JSON.stringify({ message }) });
    const close = () => {
      server.closeAllConnections();
      server.close();
    };
    return { state, url, page, prompt, close };
  }

  test("the Plan chat streams Pi's records to every page and replays them to a page that opens later", async () => {
    // Pi in RPC mode: one JSON record per line each way.
    const reply = '{"role":"assistant","content":[{"type":"text","text":"Queue a"}]}';
    const args = join(scratch, "pi-args");
    const chat = await chatServer(
      "pi",
      `echo "$@" > ${args}; while read -r line; do case "$line" in
*'"prompt"'*) echo '{"type":"agent_start"}'; echo '{"type":"message_end","message":${reply}}'; echo '{"type":"agent_settled"}' ;;
esac; done`,
      { agent: "pi", model: "openai/gpt-6.2-sol", effort: "low" },
    );
    try {
      const first = await chat.page();
      await chat.prompt("what next?");
      const types = ["agent_start", "message_end", "agent_settled"];
      expect((await first("agent_settled")).map((record) => record.type)).toEqual(types);
      const later = await chat.page();
      const replay = await later("agent_settled");
      expect(replay.map((record) => record.type)).toEqual(types);
      expect(replay[1].message.content[0].text).toBe("Queue a");
      await fetch(`${chat.url}/new`, { method: "POST" });
      expect((await first("reset")).at(-1).type).toBe("reset");
      expect(readFileSync(args, "utf8")).toMatch(/--model openai\/gpt-6.2-sol --thinking low/);
    } finally {
      chat.close();
    }
  });

  test("the Plan chat survives a restart of serve: the page gets it back and the agent resumes its session", async () => {
    const args = join(scratch, "claude-resume-args");
    const reply = { type: "user", message: { content: "hello" } };
    const fake = `echo "$@" >> ${args}; while read -r line; do case "$line" in
*'"user"'*) echo '${JSON.stringify(reply)}'; echo '{"type":"result","is_error":false}' ;;
esac; done`;
    const settings = { agent: "claude" };
    const first = await chatServer("claude", fake, settings);
    try {
      const page = await first.page();
      await first.prompt("hello");
      await page("agent_settled");
    } finally {
      first.close();
    }
    const second = await chatServer("claude", fake, settings, first.state);
    try {
      const replay = await (await second.page())("exit");
      expect(replay.map((record) => record.type)).toEqual([
        "agent_start",
        "message_start",
        "message_end",
        "agent_settled",
        "exit",
      ]);
      await second.prompt("again");
      await (
        await second.page()
      )("agent_settled");
      const launches = readFileSync(args, "utf8");
      const id = /--session-id (\S+)/.exec(launches)![1];
      expect(launches).toContain(`--resume ${id}`);
    } finally {
      second.close();
    }
  });

  test("the Plan chat keeps earlier chats: a new one starts fresh, opening the first replays it and resumes its session", async () => {
    const args = join(scratch, "claude-switch-args");
    const fake = `echo "$@" >> ${args}; while read -r line; do case "$line" in
*'"user"'*) echo '{"type":"result","is_error":false}' ;;
esac; done`;
    const chat = await chatServer("claude", fake, { agent: "claude" });
    try {
      const page = await chat.page();
      await chat.prompt("Pick five jobs\nfor tonight");
      await page("agent_settled");
      const [{ id: first }] = JSON.parse(
        readFileSync(join(chat.state, "chats.json"), "utf8"),
      ).chats;
      await fetch(`${chat.url}/new`, { method: "POST" });
      await chat.prompt("why did tasks fail?");
      const later = await chat.page();
      const listed = (await later("chats"))[0];
      expect(listed.chats.map((entry: { title: string }) => entry.title)).toEqual([
        "why did tasks fail?",
        "Pick five jobs",
      ]);
      expect(listed.current).not.toBe(first);
      await fetch(`${chat.url}/open`, { method: "POST", body: JSON.stringify({ id: first }) });
      const replay = await later("exit");
      expect(replay.some((record) => record.type === "reset")).toBe(true);
      await chat.prompt("and one more");
      await (
        await chat.page()
      )("agent_settled");
      expect(readFileSync(args, "utf8")).toContain(`--resume ${first}`);
    } finally {
      chat.close();
    }
  });

  test("a question from one of Pi's extensions reaches the page, and its answer reaches Pi", async () => {
    const answers = join(scratch, "pi-answers");
    const chat = await chatServer(
      "pi",
      `while read -r line; do case "$line" in
*'"prompt"'*) echo '{"type":"extension_ui_request","id":"q","method":"confirm","title":"Allow?"}' ;;
*extension_ui_response*) echo "$line" > ${answers}; echo '{"type":"agent_settled"}' ;;
esac; done`,
      { agent: "pi" },
    );
    try {
      const page = await chat.page();
      await chat.prompt("go");
      expect((await page("extension_ui_request")).at(-1)).toMatchObject({
        id: "q",
        title: "Allow?",
      });
      await fetch(`${chat.url}/answer`, {
        method: "POST",
        body: JSON.stringify({ id: "q", confirmed: true }),
      });
      expect((await page("extension_ui_answered")).at(-1).id).toBe("q");
      await page("agent_settled");
      expect(JSON.parse(readFileSync(answers, "utf8"))).toEqual({
        type: "extension_ui_response",
        id: "q",
        confirmed: true,
      });
    } finally {
      chat.close();
    }
  });

  test("Pi offers its scoped models in their order, then the rest, each with its efforts", async () => {
    const dir = mkdtempSync(join(scratch, "pi-models-"));
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ enabledModels: ["openai/sol", "local/*", "luna"] }),
    );
    const model = (provider: string, id: string, extra = {}) => ({
      provider,
      id,
      name: id,
      reasoning: true,
      ...extra,
    });
    const models = [
      model("openrouter", "openai/sol"),
      model("openai", "sol", { thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh" } }),
      model("local", "qwen", { reasoning: false }),
      model("codex", "luna"),
    ];
    const answer = { type: "response", command: "get_available_models", data: { models } };
    script(dir, "pi", `read -r line; echo '${JSON.stringify(answer)}'`);
    process.env.PATH = `${dir}:${process.env.PATH}`;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      expect(await agentModels("pi")).toEqual([
        {
          value: "openai/sol",
          label: "sol",
          efforts: ["low", "medium", "high", "xhigh"],
          scoped: true,
        },
        { value: "local/qwen", label: "qwen", efforts: ["off"], scoped: true },
        {
          value: "codex/luna",
          label: "luna",
          efforts: ["off", "minimal", "low", "medium", "high"],
          scoped: true,
        },
        {
          value: "openrouter/openai/sol",
          label: "openai/sol",
          efforts: ["off", "minimal", "low", "medium", "high"],
          scoped: false,
        },
      ]);
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });

  test("the Plan chat speaks to Claude Code in stream-json and gives the page Pi's records", async () => {
    const out = (...records: object[]) =>
      records.map((record) => `echo '${JSON.stringify(record)}'`).join("; ");
    const event = (record: object) => ({ type: "stream_event", event: record });
    const args = join(scratch, "claude-args");
    const chat = await chatServer(
      "claude",
      `echo "$@" > ${args}; while read -r line; do case "$line" in
*'"user"'*) ${out(
        { type: "system", subtype: "init", model: "claude-opus-5-5" },
        { type: "user", message: { content: "what next?" } },
        event({ type: "message_start" }),
        event({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
        event({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Queue a" },
        }),
        { type: "assistant", message: { content: [{ type: "text", text: "Queue a" }] } },
        event({
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "t", name: "Read" },
        }),
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "t", name: "Read", input: { file_path: "jobs.jsonl" } },
            ],
          },
        },
        event({ type: "message_stop" }),
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
        },
        { type: "result", is_error: false },
      )} ;;
esac; done`,
      { agent: "claude", model: "opus", effort: "high" },
    );
    try {
      const first = await chat.page();
      await chat.prompt("what next?");
      const records = await first("agent_settled");
      expect(records.map((record) => record.type)).toEqual([
        "agent_start",
        "response",
        "message_start",
        "message_end",
        "message_start",
        "message_update",
        "message_update",
        "message_update",
        "message_update",
        "message_end",
        "message_start",
        "message_end",
        "agent_settled",
      ]);
      expect(records[1].data).toEqual({
        model: { name: "claude-opus-5-5" },
        thinkingLevel: "high",
      });
      expect(records[3].message).toEqual({ role: "user", content: "what next?" });
      expect(records[9].message.content).toEqual([
        { type: "text", text: "Queue a" },
        {
          type: "toolCall",
          id: "t",
          name: "read",
          arguments: { file_path: "jobs.jsonl", path: "jobs.jsonl" },
        },
      ]);
      expect(records[11].message).toMatchObject({
        role: "toolResult",
        toolCallId: "t",
        isError: false,
      });
      expect(readFileSync(args, "utf8")).toMatch(/--model opus --effort high/);
      // The streamed deltas are dropped once the reply ended.
      const replay = await (await chat.page())("agent_settled");
      expect(replay.filter((record) => record.type === "message_update")).toEqual([]);
    } finally {
      chat.close();
    }
  });

  test.each([false, true])(
    "serve rebases a PR without guessing conflict resolutions (conflict: %s)",
    async (conflict) => {
      const base = setup(["a"]);
      const { repo } = base;
      const origin = sh(repo, "git", "remote", "get-url", "origin").trim();
      const name = conflict ? "rebase-conflict" : "rebase-clear";
      const pr = `https://github.com/o/${name}/pull/7`;
      sh(
        repo,
        "git",
        "config",
        "--global",
        `url.file://${origin}.insteadOf`,
        `https://github.com/o/${name}.git`,
      );
      const github = gh({ mergeable: "CONFLICTING" });
      agents({ claude: `echo 'opened ${pr}'; ${RESULT}` });
      const job = base.pick("a");

      writeFileSync(join(repo, "shared.txt"), "original\n");
      sh(repo, "git", "add", ".");
      sh(repo, "git", "commit", "-qm", "common base");
      sh(repo, "git", "checkout", "-qb", "workwork/a");
      writeFileSync(join(repo, "shared.txt"), "PR edit\n");
      sh(repo, "git", "commit", "-qam", "PR edit");
      sh(
        repo,
        "git",
        "push",
        "-q",
        "origin",
        "HEAD:refs/heads/workwork/a",
        "HEAD:refs/pull/7/head",
      );
      const before = sh(repo, "git", "rev-parse", "HEAD");
      sh(repo, "git", "checkout", "-q", "main");
      writeFileSync(join(repo, conflict ? "shared.txt" : "other.txt"), "base edit\n");
      sh(repo, "git", "add", ".");
      sh(repo, "git", "commit", "-qm", "base edit");
      sh(repo, "git", "push", "-q", "origin", "main");
      await work(options(base));

      script(
        join(origin, "hooks"),
        "post-receive",
        `printf '%s\\n' '${JSON.stringify(OPEN_PR)}' > ${github.viewPath}`,
      );
      const server = serve(base.state, 0, "127.0.0.1", () => ({}));
      await once(server, "listening");
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}`;
      try {
        const response = await fetch(`${url}/api/jobs/${job.id}/rebase`, { method: "POST" });
        const after = sh(origin, "git", "rev-parse", "refs/heads/workwork/a");
        if (conflict) {
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({
            error:
              "Rebase stopped. Resolve these conflicts manually; no changes were pushed:\nshared.txt",
          });
          expect(after).toBe(before);

          // The train skips it the same way and queues an agent to resolve the conflicts, once.
          for (let start = 0; start < 2; start++) {
            await fetch(`${url}/api/train`, {
              method: "POST",
              body: JSON.stringify({ ids: [job.id] }),
            });
            let car: TrainCar | undefined;
            while (!car || onTrain(car)) {
              car = ((await (await fetch(`${url}/api/state`)).json()) as Snapshot).train[job.id];
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            expect(car).toEqual({
              step: "skipped",
              reason: "conflicts in shared.txt; a job to resolve them is queued",
            });
          }
          const fixes = readJobs(base.state).filter(
            (other) => other.item.blueprint === "conflicts",
          );
          expect(fixes.map((fix) => [fix.state, fix.item.title])).toEqual([
            ["queued", "Resolve conflicts: fix a"],
          ]);
          const [fix] = await work(options(base)).then((jobs) =>
            jobs.filter((other) => other.id === fixes[0].id),
          );
          const prompt = readFileSync(join(dirname(fix.attempts[0].log), "prompt.md"), "utf8");
          expect(prompt.startsWith(fixes[0].prompt!)).toBe(true);
          expect(prompt).toContain(`gh pr checkout ${pr}`);
          expect(prompt).toContain("- shared.txt");
          expect(fix.attempts[0].url).toBe(pr);
        } else {
          expect(response.status, await response.text()).toBe(200);
          expect(after).not.toBe(before);
          sh(origin, "git", "merge-base", "--is-ancestor", "main", after.trim());
          expect(sh(origin, "git", "show", `${after.trim()}:shared.txt`)).toBe("PR edit\n");
          expect(sh(repo, "git", "branch", "--show-current").trim()).toBe("main");
          const snapshot = (await (await fetch(`${url}/api/state`)).json()) as Snapshot;
          expect(snapshot.prs[pr]).toMatchObject({ state: "OPEN", conflicts: false });
        }
      } finally {
        server.close();
      }
    },
  );
});

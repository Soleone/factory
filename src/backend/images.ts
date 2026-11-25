import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { addOwnJob, newId } from "./jobs.ts";
import { readSettings } from "./state.ts";
import { EXPANDER, type ImageRun, type Job } from "./types.ts";

const MINUTE = 60_000;
/** Image runs codex works at once; each takes a minute or two. */
const AT_ONCE = 2;
/** A run that takes longer is stuck: image_gen answers in minutes. */
const TIMEOUT = 15 * MINUTE;

const folder = (state: string, id: string) => join(state, "images", id);
const runPath = (state: string, id: string) => join(folder(state, id), "run.json");
const write = (state: string, run: ImageRun) =>
  writeFileSync(runPath(state, run.id), `${JSON.stringify(run, null, 2)}\n`);

export function readImageRuns(state: string): ImageRun[] {
  const root = join(state, "images");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((id) => existsSync(runPath(state, id)))
    .map((id) => JSON.parse(readFileSync(runPath(state, id), "utf8")) as ImageRun)
    .sort((a, b) => b.added.localeCompare(a.added));
}

function readImageRun(state: string, id: string): ImageRun {
  if (!/^\w+$/.test(id) || !existsSync(runPath(state, id))) throw new Error(`no image run ${id}`);
  return JSON.parse(readFileSync(runPath(state, id), "utf8"));
}

/** A pasted image, base64 without the data: prefix. */
export type Pasted = { data: string; mimeType: string };

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export function addImageRun(
  state: string,
  request: {
    prompt: string;
    repo?: string;
    expand: boolean;
    variants: number;
    references: Pasted[];
  },
): ImageRun {
  const prompt = request.prompt.trim();
  if (!prompt) throw new Error("the prompt is empty");
  if (!(Number.isInteger(request.variants) && request.variants >= 1 && request.variants <= 4))
    throw new Error(`variants wants 1 to 4, got ${request.variants}`);
  const id = newId();
  mkdirSync(folder(state, id), { recursive: true });
  const references = request.references.map(({ data, mimeType }, index) => {
    const extension = EXTENSIONS[mimeType];
    if (!extension) throw new Error(`can't use a ${mimeType} as a reference`);
    const file = `reference-${index + 1}${extension}`;
    writeFileSync(join(folder(state, id), file), Buffer.from(data, "base64"));
    return file;
  });
  const run: ImageRun = {
    id,
    added: new Date().toISOString(),
    prompt,
    repo: request.repo || undefined,
    expand: request.expand,
    variants: request.variants,
    references,
    state: "queued",
    images: [],
  };
  write(state, run);
  return run;
}

/** Runs the same request again, as a new run beside the old one. */
export function retryImageRun(state: string, id: string): ImageRun {
  const old = readImageRun(state, id);
  return addImageRun(state, {
    ...old,
    references: old.references.map((file) => ({
      data: readFileSync(join(folder(state, id), file)).toString("base64"),
      mimeType: Object.entries(EXTENSIONS).find(([, ext]) => ext === extname(file))![0],
    })),
  });
}

export function removeImageRun(state: string, id: string): void {
  if (readImageRun(state, id).state === "running")
    throw new Error("it's being generated; delete it once it's done");
  rmSync(folder(state, id), { recursive: true, force: true });
}

/** Queues a job that brings one image into the run's project, so it lands there by PR. */
export function useImage(state: string, id: string, file: string, where: string): Job {
  const run = readImageRun(state, id);
  const image = run.images.find((each) => each.file === file);
  if (!run.repo || !image) throw new Error(`run ${id} has no image ${file} for a project`);
  const path = join(folder(state, id), file);
  return addOwnJob(state, {
    repo: run.repo,
    tier: "grunt",
    title: `Add image: ${image.name || basename(path)}`,
    prompt: [
      `Add the image at ${path} to this project.`,
      `It was generated for: ${run.prompt}`,
      where.trim()
        ? `Where and how to use it: ${where.trim()}`
        : "Put it where the project keeps such assets, under a name that says what it shows, and use it where the prompt suggests.",
      "Copy it; don't move or change the original. Commit, push and open a PR.",
    ].join("\n\n"),
  });
}

/** What codex is told: generate, don't touch files, and report the brief and images in a fixed form. */
export function codexPrompt(run: ImageRun, expander: string): string {
  return [
    "Use your built-in image_gen tool. Don't use a Python or API fallback, and don't write, copy or move any files: the images stay where image_gen saves them.",
    run.repo &&
      `The images are for the project at ${run.repo}. Read what helps you understand the request, such as its README, its look and existing images to match. Change nothing there.`,
    run.references.length > 0 &&
      `The attached images (${run.references.map((_, index) => `Image ${index + 1}`).join(", ")}) are references the user gave for this request.`,
    run.expand
      ? `First expand the request into a full production brief, then generate from the brief. ${expander}`
      : "Generate from the request as written, without embellishing it.",
    `Work out which distinct images the request asks for, usually one, and generate ${run.variants === 1 ? "one image of each" : `${run.variants} variants of each, so the user can pick the best`}.`,
    `Request:\n${run.prompt}`,
    `End your reply with ${run.expand ? "a line `BRIEF:` followed by the brief, then " : ""}one line per image: \`IMAGE: <absolute path> | <short name of what it shows>\`. Variants of one image share its name.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The brief and each image's name by file name, from codex's last message. */
export function readReply(text: string): { brief?: string; names: Map<string, string> } {
  const names = new Map<string, string>();
  for (const [, path, name] of text.matchAll(/^IMAGE:\s*(.+?)\s*(?:\|\s*(.*?))?\s*$/gm))
    names.set(basename(path), name ?? "");
  const at = text.search(/^BRIEF:/m);
  const brief =
    at < 0
      ? ""
      : text
          .slice(at + "BRIEF:".length)
          .split(/^IMAGE:/m)[0]
          .trim();
  return { brief: brief || undefined, names };
}

/**
 * Works queued image runs with `codex exec`, a few at once, until stopped. Codex saves its images
 * under $CODEX_HOME/generated_images/<thread>; factory copies them into the run's folder itself.
 */
export function imageRunner(
  state: string,
  command = "codex",
): { kick: () => void; stop: () => void } {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const running = new Set<string>();
  // A run left running belonged to a serve that stopped; its codex went with it.
  for (const run of readImageRuns(state))
    if (run.state === "running") write(state, { ...run, state: "queued" });

  function kick(): void {
    const queued = readImageRuns(state)
      .filter((run) => run.state === "queued" && !running.has(run.id))
      .reverse();
    for (const run of queued.slice(0, AT_ONCE - running.size)) {
      running.add(run.id);
      void work(run).finally(() => {
        running.delete(run.id);
        kick();
      });
    }
  }

  async function work(run: ImageRun): Promise<void> {
    write(state, { ...run, state: "running" });
    const dir = folder(state, run.id);
    const reply = join(dir, "reply.md");
    const expander = readSettings(state).imageExpander?.trim() || EXPANDER;
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-C",
      run.repo ?? dir,
      "-o",
      reply,
      ...run.references.flatMap((file) => ["-i", join(dir, file)]),
      "-",
    ];
    try {
      const events = await codex(command, args, codexPrompt(run, expander));
      writeFileSync(join(dir, "events.jsonl"), events);
      const thread = /"thread_id":"([^"]+)"/.exec(events)?.[1];
      const made = thread ? join(codexHome, "generated_images", thread) : "";
      const files = made && existsSync(made) ? readdirSync(made).sort() : [];
      const text = existsSync(reply) ? readFileSync(reply, "utf8") : "";
      if (files.length === 0)
        throw new Error(`codex made no image${text ? `: ${text.trim().slice(-500)}` : ""}`);
      const { brief, names } = readReply(text);
      // Codex may discard a weak one it made; what it reports is its pick.
      const picked = files.filter((source) => names.has(source));
      const images = (picked.length ? picked : files).map((source, index) => {
        const file = `${index + 1}${extname(source)}`;
        copyFileSync(join(made, source), join(dir, file));
        return { file, name: names.get(source) ?? "" };
      });
      write(state, { ...run, state: "done", brief, images });
    } catch (error) {
      write(state, { ...run, state: "failed", error: (error as Error).message });
    }
  }

  const timer = setInterval(kick, 2000);
  kick();
  return { kick, stop: () => clearInterval(timer) };
}

/** Runs codex with the prompt on stdin; resolves with its JSON events, or throws what went wrong. */
function codex(command: string, args: string[], prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      child.kill();
    }, TIMEOUT);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.stdin.on("error", () => {});
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        error.code === "ENOENT"
          ? new Error(`${command} isn't installed: npm install -g @openai/codex, then codex login`)
          : error,
      );
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (late) reject(new Error(`codex took over ${TIMEOUT / MINUTE} minutes and was stopped`));
      else if (code !== 0 || signal)
        reject(new Error(err.trim().slice(-1000) || `codex exited ${code ?? signal}`));
      else resolve(out);
    });
    child.stdin.end(prompt);
  });
}

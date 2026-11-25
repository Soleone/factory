import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { IMAGE_AGENT } from "./agents.ts";
import { addJob, addOwnJob, newId, readJobs } from "./jobs.ts";
import { readSettings } from "./state.ts";
import { EXPANDER, type Job, type MadeImage, type Outcome, type Tuning } from "./types.ts";

const MINUTE = 60_000;
/** An attempt that takes longer is stuck: image_gen answers in minutes. */
const TIMEOUT = 15 * MINUTE;
/** What codex prints when the ChatGPT plan's usage runs out. */
const LIMIT = /usage limit|usage_limit_reached|rate_limit_exceeded/i;

const imageFolder = (state: string, id: string) => join(state, "images", id);

/** A pasted image, base64 without the data: prefix. */
export type Pasted = { data: string; mimeType: string };

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

/** Queues an image job for codex workers; its references go to its own folder first. */
export function addImageJob(
  state: string,
  request: {
    prompt: string;
    repo?: string;
    expand: boolean;
    variants: number;
    references: Pasted[];
  },
): Job {
  const prompt = request.prompt.trim();
  if (!prompt) throw new Error("the prompt is empty");
  if (!(Number.isInteger(request.variants) && request.variants >= 1 && request.variants <= 4))
    throw new Error(`variants wants 1 to 4, got ${request.variants}`);
  const id = newId();
  const folder = imageFolder(state, id);
  mkdirSync(folder, { recursive: true });
  const references = request.references.map(({ data, mimeType }, index) => {
    const extension = EXTENSIONS[mimeType];
    if (!extension) throw new Error(`can't use a ${mimeType} as a reference`);
    const file = `reference-${index + 1}${extension}`;
    writeFileSync(join(folder, file), Buffer.from(data, "base64"));
    return file;
  });
  return addJob(state, {
    id,
    item: {
      repo: request.repo ?? "",
      label: request.repo ? basename(request.repo) : "images",
      id: `image-${id}`,
      blueprint: "image",
      attention: "none",
      title: `Image: ${prompt.split("\n")[0].slice(0, 90)}`,
    },
    source: "pick",
    agent: IMAGE_AGENT,
    prompt,
    image: { expand: request.expand, variants: request.variants, references },
  });
}

/** Queues a job that brings one image into the image job's project, so it lands there by PR. */
export function useImage(state: string, id: string, file: string, where: string): Job {
  const job = readJobs(state).find((each) => each.id === id);
  const image = job?.attempts
    .flatMap((attempt) => attempt.images ?? [])
    .find((each) => each.file === file);
  if (!job?.item.repo || !image) throw new Error(`job ${id} has no image ${file} for a project`);
  const path = join(imageFolder(state, id), file);
  return addOwnJob(state, {
    repo: job.item.repo,
    tier: "grunt",
    title: `Add image: ${image.name || file}`,
    prompt: [
      `Add the image at ${path} to this project.`,
      `It was generated for: ${job.prompt}`,
      where.trim()
        ? `Where and how to use it: ${where.trim()}`
        : "Put it where the project keeps such assets, under a name that says what it shows, and use it where the prompt suggests.",
      "Copy it; don't move or change the original. Commit, push and open a PR.",
    ].join("\n\n"),
  });
}

/** What codex is told: generate, don't touch files, and report the brief and images in a fixed form. */
function codexPrompt(job: Job, expander: string): string {
  const { expand, variants, references } = job.image!;
  return [
    "Use your built-in image_gen tool. Don't use a Python or API fallback, and don't write, copy or move any files: the images stay where image_gen saves them.",
    job.item.repo &&
      `The images are for the project at ${job.item.repo}. Read what helps you understand the request, such as its README, its look and existing images to match. Change nothing there.`,
    references.length > 0 &&
      `The attached images (${references.map((_, index) => `Image ${index + 1}`).join(", ")}) are references the user gave for this request.`,
    expand
      ? `First expand the request into a full production brief, then generate from the brief. ${expander}`
      : "Generate from the request as written, without embellishing it.",
    `Work out which distinct images the request asks for, usually one, and generate ${variants === 1 ? "one image of each" : `${variants} variants of each, so the user can pick the best`}.`,
    `Request:\n${job.prompt}`,
    `End your reply with ${expand ? "a line `BRIEF:` followed by the brief, then " : ""}one line per image: \`IMAGE: <absolute path> | <short name of what it shows>\`. Variants of one image share its name.`,
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

/** How an image attempt ended; no outcome: the run stopped it, so the job goes back. A limit's error is what codex said, reset time included. */
export type Generated = {
  outcome?: Outcome;
  error?: string;
  images?: MadeImage[];
  brief?: string;
};

/**
 * One attempt at an image job with `codex exec`, logging its events to `log`. Codex saves its images
 * under $CODEX_HOME/generated_images/<thread>; factory copies them into the job's folder itself.
 */
export async function generate(
  state: string,
  job: Job,
  { model, effort }: Tuning,
  log: string,
  signal: AbortSignal,
): Promise<Generated> {
  const folder = imageFolder(state, job.id);
  const number = job.attempts.length + 1;
  const reply = join(folder, `reply-${number}.md`);
  const expander = readSettings(state).imageExpander?.trim() || EXPANDER;
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "-C",
    job.item.repo || folder,
    "-o",
    reply,
    ...(model ? ["-m", model] : []),
    ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
    ...job.image!.references.flatMap((file) => ["-i", join(folder, file)]),
    "-",
  ];
  const ran = await codex(args, codexPrompt(job, expander), log, signal);
  if (signal.aborted) return {};
  const text = existsSync(reply) ? readFileSync(reply, "utf8") : "";
  if (LIMIT.test(ran.failure)) return { outcome: "limited", error: ran.failure.slice(-2000) };
  if (ran.late) return { outcome: "timeout", error: `codex took over ${TIMEOUT / MINUTE} minutes` };
  if (ran.code !== 0)
    return {
      outcome: "failed",
      error: ran.failure.slice(-2000) || `codex exited ${ran.code}`,
    };
  const thread = /"thread_id":"([^"]+)"/.exec(ran.events)?.[1];
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const made = thread ? join(codexHome, "generated_images", thread) : "";
  const files = made && existsSync(made) ? readdirSync(made).sort() : [];
  if (files.length === 0)
    return {
      outcome: "failed",
      error: `codex made no image${text ? `: ${text.trim().slice(-500)}` : ""}`,
    };
  const { brief, names } = readReply(text);
  // Codex may discard a weak one it made; what it reports is its pick.
  const picked = files.filter((source) => names.has(source));
  const images = (picked.length ? picked : files).map((source, index) => {
    const file = `${number}-${index + 1}${extname(source)}`;
    copyFileSync(join(made, source), join(folder, file));
    return { file, name: names.get(source) ?? "" };
  });
  return { outcome: "done", images, brief };
}

/**
 * Runs codex with the prompt on stdin, its output going to log. `failure` is what codex itself
 * reported going wrong: its error events and stderr, not the output of commands it ran while reading.
 */
function codex(
  args: string[],
  prompt: string,
  log: string,
  signal: AbortSignal,
): Promise<{ events: string; failure: string; code: number | null; late?: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(IMAGE_AGENT, args, { stdio: ["pipe", "pipe", "pipe"], signal });
    let events = "";
    let err = "";
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      child.kill();
    }, TIMEOUT);
    child.stdout.on("data", (chunk: Buffer) => {
      events += chunk;
      writeFileSync(log, chunk, { flag: "a" });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk;
      writeFileSync(log, chunk, { flag: "a" });
    });
    child.stdin.on("error", () => {});
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        events,
        code: null,
        failure:
          error.code === "ENOENT"
            ? "codex isn't installed: npm install -g @openai/codex, then codex login"
            : error.message,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        events,
        code,
        late,
        failure: [...errors(events), err.trim()].filter(Boolean).join("\n"),
      });
    });
    child.stdin.end(prompt);
  });
}

/** The messages of codex's error and failed-turn events. */
function errors(events: string): string[] {
  return events.split("\n").flatMap((line) => {
    if (!line.includes('"error"') && !line.includes('"turn.failed"')) return [];
    try {
      const event = JSON.parse(line);
      const message =
        event.type === "error"
          ? event.message
          : event.type === "turn.failed"
            ? event.error?.message
            : undefined;
      return typeof message === "string" ? [message] : [];
    } catch {
      return [];
    }
  });
}

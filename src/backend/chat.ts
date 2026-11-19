import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ServerResponse } from "node:http";
import { createInterface } from "node:readline";

/**
 * One Pi session in RPC mode for planning the queue, shared by every open page. Pi's records go to
 * the pages as they are (see Pi's docs/rpc.md); the conversation lasts until reset or serve stops.
 */
export function chat(state: string) {
  let pi: ChildProcessWithoutNullStreams | undefined;
  const pages = new Set<ServerResponse>();

  function emit(record: unknown): void {
    for (const page of pages) page.write(`data: ${JSON.stringify(record)}\n\n`);
  }

  function start(): ChildProcessWithoutNullStreams {
    const child = spawn(
      "pi",
      ["--mode", "rpc", "--no-session", "--tools", TOOLS, "--append-system-prompt", context()],
      { cwd: state },
    );
    createInterface({ input: child.stdout }).on("line", (line) => {
      // Pi only writes JSON records here; anything else isn't for the page.
      if (line.startsWith("{")) emit(JSON.parse(line));
    });
    // A pi that failed to start or died breaks the pipe; its error and exit handlers say why.
    child.stdin.on("error", () => {});
    let stderr = "";
    child.stderr.on("data", (data) => (stderr = (stderr + data).slice(-2000)));
    child.on("error", (error) => {
      if (pi === child) pi = undefined;
      emit({ type: "exit", error: `Can't start pi: ${error.message}` });
    });
    child.on("exit", (code) => {
      if (pi !== child) return;
      pi = undefined;
      emit({
        type: "exit",
        error: code ? stderr.trim() || `pi exited with code ${code}` : undefined,
      });
    });
    child.stdin.write(`${JSON.stringify({ type: "get_state" })}\n`);
    return child;
  }

  function send(record: object): void {
    pi ??= start();
    pi.stdin.write(`${JSON.stringify(record)}\n`);
  }

  return {
    /** Streams records to a page, starting with the conversation so far. */
    listen(response: ServerResponse): void {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      });
      response.write(": connected\n\n");
      pages.add(response);
      response.on("close", () => pages.delete(response));
      if (pi) {
        send({ type: "get_messages" });
        send({ type: "get_state" });
      }
    },
    prompt: (message: string) => send({ type: "prompt", message }),
    abort: () => pi && send({ type: "abort" }),
    reset(): void {
      // Closing stdin asks Pi to shut down.
      pi?.stdin.end();
      pi = undefined;
      emit({ type: "reset" });
    },
  };
}

/** Looking and running commands; it changes the queue through the factory CLI, never files. */
const TOOLS = "read,bash,grep,find,ls";

function context(): string {
  // argv[1] is this CLI, whether it runs from dist or, under pn dev, from source.
  const factory = `"${process.execPath}" "${process.argv[1]}"`;
  return `You run inside the web page of factory, which works a queue of workwork candidates with headless coding agents, often overnight. You help the user decide what to put in the queue.

- The current folder is factory's state. candidates.json holds every repo's candidates from workwork ({ at, items: [{ repo, label, id, play, level, title }] }); jobs.jsonl is the queue and results, one event per line.
- \`${factory} status\` shows the queue and \`${factory} report --all\` past results. \`workwork prompt <id>\`, run in the candidate's repo, shows the full task.
- To queue candidates: \`${factory} add <id>... --repo <repo>\`, optionally with \`--agent claude|pi\`. Picked jobs go ahead of auto ones.
- Levels: auto needs no review, skim a quick look, decide needs the user's judgment. Prefer a few that fit together over many that touch the same files, since those conflict when merged.

Propose what to queue and why, briefly, and add jobs only once the user agrees. Never start, stop or run the factory, never change files or git state, and never merge or close PRs: the user does those from the page.`;
}

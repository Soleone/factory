import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { AGENT_NAMES, chatAgent } from "./agents.ts";
import { claudeChat, type PiRecord } from "./claude.ts";
import { readSettings } from "./state.ts";

/** Speaks one agent's protocol: what to write for each of Pi's commands, and its output as Pi's records. */
type Protocol = {
  command(record: PiRecord): { write: object[]; emit: PiRecord[] };
  record(record: PiRecord): PiRecord[];
};

/** Pi speaks the page's protocol already. */
const pi: Protocol = {
  command: (record) => ({ write: [record], emit: [] }),
  record: (record: PiRecord) => [record],
};

/**
 * One chat for planning the queue, shared by every open page, with the agent the settings name.
 * The page reads Pi's RPC records (see Pi's docs/rpc.md), whichever agent replies. The conversation
 * lasts until reset or serve stops, and a page that opens later gets it replayed.
 */
export function chat(state: string) {
  let session: { child: ChildProcessWithoutNullStreams; protocol: Protocol } | undefined;
  const pages = new Set<ServerResponse>();
  /** Every record of this conversation, minus the deltas of replies that have ended. */
  let log: PiRecord[] = [];

  function emit(record: PiRecord): void {
    if (record.type === "message_end") log = log.filter((each) => each.type !== "message_update");
    log.push(record);
    for (const page of pages) page.write(`data: ${JSON.stringify(record)}\n\n`);
  }

  function start() {
    const { agent, ...tuning } = readSettings(state).chat;
    const { command, args } = chatAgent(agent, tuning, context());
    const protocol = agent === "claude" ? claudeChat(tuning.effort) : pi;
    const child = spawn(command, args, { cwd: state });
    createInterface({ input: child.stdout }).on("line", (line) => {
      // Only JSON records are for the page.
      if (line.startsWith("{"))
        for (const record of protocol.record(JSON.parse(line))) emit(record);
    });
    // An agent that failed to start or died breaks the pipe; its error and exit handlers say why.
    child.stdin.on("error", () => {});
    let stderr = "";
    child.stderr.on("data", (data) => (stderr = (stderr + data).slice(-2000)));
    child.on("error", (error) => {
      if (session?.child === child) session = undefined;
      emit({ type: "exit", error: `Can't start ${command}: ${error.message}` });
    });
    child.on("exit", (code) => {
      if (session?.child !== child) return;
      session = undefined;
      emit({
        type: "exit",
        error: code ? stderr.trim() || `${command} exited with code ${code}` : undefined,
      });
    });
    session = { child, protocol };
    send({ type: "get_state" });
  }

  function send(record: PiRecord): void {
    if (!session) start();
    const { write, emit: heard } = session!.protocol.command(record);
    for (const each of write) session!.child.stdin.write(`${JSON.stringify(each)}\n`);
    for (const each of heard) emit(each);
  }

  return {
    /** Streams records to a page, starting with the conversation so far. */
    listen(response: ServerResponse): void {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      });
      response.write(": connected\n\n");
      for (const record of log) response.write(`data: ${JSON.stringify(record)}\n\n`);
      pages.add(response);
      response.on("close", () => pages.delete(response));
    },
    prompt: (message: string) => send({ type: "prompt", message }),
    abort: () => session && send({ type: "abort" }),
    /** Answers a question from one of Pi's extensions, which Pi waits on; every page closes it. */
    answer(reply: { id: string }): void {
      if (!session) return;
      send({ type: "extension_ui_response", ...reply });
      emit({ type: "extension_ui_answered", id: reply.id });
    },
    reset(): void {
      // Closing stdin asks the agent to shut down.
      session?.child.stdin.end();
      session = undefined;
      emit({ type: "reset" });
      log = [];
    },
  };
}

function context(): string {
  // argv[1] is this CLI, whether it runs from dist or, under pn dev, from source.
  const factory = `"${process.execPath}" "${process.argv[1]}"`;
  return `You run inside the web page of factory, which works a queue of workwork candidates with headless coding agents, often overnight. You help the user decide what to put in the queue.

- The current folder is factory's state. candidates.json holds every repo's candidates from workwork ({ at, items: [{ repo, label, id, play, level, title }] }); jobs.jsonl is the queue and results, one event per line. runs/ holds each attempt's prompt.md and agent.log.
- \`${factory} status\` shows the queue and \`${factory} report --all\` past results. \`workwork prompt <id>\`, run in the candidate's repo, shows the full task.
- To queue candidates: \`${factory} add <id>... --repo <repo>\`, optionally with \`--agent ${AGENT_NAMES.join("|")}\`. Picked jobs go ahead of auto ones.
- Levels: auto needs no review, skim a quick look, decide needs the user's judgment. Prefer a few that fit together over many that touch the same files, since those conflict when merged.

Propose what to queue and why, briefly, and add jobs only once the user agrees. Never start, stop or run the factory, never change files or git state, and never merge or close PRs: the user does those from the page.`;
}

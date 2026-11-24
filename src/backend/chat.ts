import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { chatAgent } from "./agents.ts";
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
 * lasts until reset, and a page that opens later gets it replayed. It survives a restart of serve:
 * the agent keeps its session (Pi's in chat-sessions/, Claude Code's in its own folder) and the page's
 * records are in chat.jsonl.
 */
export function chat(state: string, address: () => string) {
  const savedPath = join(state, "chat.jsonl");
  const conversationPath = join(state, "chat.json");
  let session: { child: ChildProcessWithoutNullStreams; protocol: Protocol } | undefined;
  const pages = new Set<ServerResponse>();
  /** The agent session this chat continues; `prompted` once the agent has one to resume. */
  let conversation: { agent: string; id: string; prompted: boolean } | undefined = existsSync(
    conversationPath,
  )
    ? JSON.parse(readFileSync(conversationPath, "utf8"))
    : undefined;
  /** Every record of this conversation, minus the deltas of replies that have ended. */
  let log: PiRecord[] = existsSync(savedPath)
    ? readFileSync(savedPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  // A reply the restart cut off doesn't stay busy.
  if (log.length > 0) log.push({ type: "exit" });

  function emit(record: PiRecord): void {
    if (record.type === "message_end") log = log.filter((each) => each.type !== "message_update");
    log.push(record);
    // Deltas only matter while a reply streams; its message_end holds the whole of it.
    if (record.type !== "message_update") appendFileSync(savedPath, `${JSON.stringify(record)}\n`);
    for (const page of pages) page.write(`data: ${JSON.stringify(record)}\n\n`);
  }

  function save(change: typeof conversation): void {
    conversation = change;
    writeFileSync(conversationPath, `${JSON.stringify(conversation)}\n`);
  }

  function start() {
    const { agent, ...tuning } = readSettings(state).chat;
    // Settings edited by hand while serve was off can name another agent: that's a new chat.
    if (conversation?.agent !== agent) save({ agent, id: randomUUID(), prompted: false });
    const { id, prompted } = conversation!;
    const { command, args } = chatAgent(agent, tuning, context(), {
      id,
      resume: prompted,
      folder: join(state, "chat-sessions"),
    });
    const protocol = agent === "claude" ? claudeChat(tuning.effort) : pi;
    const child = spawn(command, args, {
      cwd: state,
      env: { ...process.env, FACTORY_URL: address() },
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      // Only JSON records are for the page, and nothing from an agent New chat let go.
      if (line.startsWith("{") && session?.child === child)
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
    prompt(message: string): void {
      send({ type: "prompt", message });
      if (!conversation!.prompted) save({ ...conversation!, prompted: true });
    },
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
      for (const page of pages) page.write(`data: ${JSON.stringify({ type: "reset" })}\n\n`);
      log = [];
      rmSync(savedPath, { force: true });
      rmSync(conversationPath, { force: true });
      conversation = undefined;
    },
  };
}

function context(): string {
  // argv[1] is this CLI, whether it runs from dist or, under pn dev, from source.
  const factory = `"${process.execPath}" "${process.argv[1]}"`;
  return `You run inside the web page of factory, which works a queue of coding jobs with headless agents, often overnight. You help the user decide what to queue and handle the results, through factory's CLI: \`${factory}\`. Run it alone for the basics; \`${factory} help <topic>\` shows the rest (add, results, inbox, goals).

- The current folder is factory's state. candidates.json holds every repo's workwork candidates; jobs.jsonl is the queue and results, one event per line; runs/ holds each attempt's prompt.md and agent.log.
- Attention: none needs no review, skim a quick look, decide needs the user's judgment. Prefer a few jobs that fit together over many that touch the same files, since those conflict when merged.
- For work that isn't a candidate, write a prompt file in this folder and queue it with \`add --prompt\`. For a goal, work out a brief with the user first: what done looks like, constraints, links to specs, and the commands that prove it works.
- When reviewing results, read each PR with \`gh pr view\` and \`gh pr diff\`, and say what you'd merge, what you'd close and why.

Propose, briefly, and act once the user agrees: queue, reorder, pin, retry, merge, rebase, close, remove, answer or verify only what the user agreed to. Never approve a goal's plan, never start or stop the factory, and never change files or git state other than through factory's CLI.`;
}

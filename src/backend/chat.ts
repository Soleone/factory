import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

/** A Live Agent chat, kept under chats/<id>.jsonl. It stays with the agent it started with. */
export type ChatEntry = {
  id: string;
  agent: string;
  title: string;
  lastActive: number;
  prompted: boolean;
};

/** The first line of the first prompt, short enough for one row. */
function titleOf(message: string): string {
  const line = message.trim().split("\n")[0].trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/**
 * The chats for planning the queue, with the agent the settings name for new ones. Every open page
 * shows the current chat and reads Pi's RPC records (see Pi's docs/rpc.md), whichever agent replies,
 * plus a `chats` record with the list. One agent runs at a time: opening another chat ends it. Chats
 * survive a restart of serve: the agent keeps its session (Pi's in chat-sessions/, Claude Code's in
 * its own folder) and the page's records are in chats/.
 */
export function chat(state: string, address: () => string) {
  const folder = join(state, "chats");
  const indexPath = join(state, "chats.json");
  mkdirSync(folder, { recursive: true });
  let session: { child: ChildProcessWithoutNullStreams; protocol: Protocol } | undefined;
  const pages = new Set<ServerResponse>();
  let { chats, current } = existsSync(indexPath)
    ? (JSON.parse(readFileSync(indexPath, "utf8")) as { chats: ChatEntry[]; current?: string })
    : adoptSingleChat(state, folder);
  /** Every record of the current chat, minus the deltas of replies that have ended. */
  let log = load(current);

  function load(id: string | undefined): PiRecord[] {
    const path = id && join(folder, `${id}.jsonl`);
    if (!path || !existsSync(path)) return [];
    const records = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    // A reply that a restart or a switch cut off doesn't stay busy.
    return [...records, { type: "exit" }];
  }

  function broadcast(record: PiRecord): void {
    for (const page of pages) page.write(`data: ${JSON.stringify(record)}\n\n`);
  }

  function emit(record: PiRecord): void {
    if (record.type === "message_end") log = log.filter((each) => each.type !== "message_update");
    log.push(record);
    // Deltas only matter while a reply streams; its message_end holds the whole of it.
    if (record.type !== "message_update")
      appendFileSync(join(folder, `${current}.jsonl`), `${JSON.stringify(record)}\n`);
    broadcast(record);
  }

  const listing = () => ({ type: "chats", chats, current }) as PiRecord;

  function save(): void {
    chats.sort((a, b) => b.lastActive - a.lastActive);
    writeFileSync(indexPath, `${JSON.stringify({ chats, current })}\n`);
    broadcast(listing());
  }

  function start() {
    const entry = chats.find((each) => each.id === current)!;
    const { agent, ...tuning } = readSettings(state).chat;
    // A chat started with the other agent continues with that one, at its defaults.
    const { command, args } = chatAgent(
      entry.agent,
      entry.agent === agent ? tuning : {},
      context(),
      {
        id: entry.id,
        resume: entry.prompted,
        folder: join(state, "chat-sessions"),
      },
    );
    const protocol = entry.agent === "claude" ? claudeChat(tuning.effort) : pi;
    const child = spawn(command, args, {
      cwd: state,
      env: { ...process.env, FACTORY_URL: address() },
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      // Only JSON records are for the page, and nothing from an agent that was let go.
      if (line.startsWith("{") && session?.child === child)
        for (const record of protocol.record(JSON.parse(line))) emit(record);
    });
    // An agent that failed to start or died breaks the pipe; its error and exit handlers say why.
    child.stdin.on("error", () => {});
    let stderr = "";
    child.stderr.on("data", (data) => (stderr = (stderr + data).slice(-2000)));
    child.on("error", (error) => {
      if (session?.child !== child) return;
      session = undefined;
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

  /** Closing stdin asks the agent to shut down; the next prompt starts it again. */
  function stop(): void {
    session?.child.stdin.end();
    session = undefined;
  }

  /** Shows chat `id`, or a new one for undefined, on every page. */
  function show(id: string | undefined): void {
    stop();
    current = id;
    log = load(id);
    broadcast({ type: "reset" });
    for (const record of log) broadcast(record);
    save();
  }

  return {
    /** Streams records to a page: the list of chats, then the current one so far. */
    listen(response: ServerResponse): void {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      });
      response.write(": connected\n\n");
      response.write(`data: ${JSON.stringify(listing())}\n\n`);
      for (const record of log) response.write(`data: ${JSON.stringify(record)}\n\n`);
      pages.add(response);
      response.on("close", () => pages.delete(response));
    },
    prompt(message: string): void {
      let entry = chats.find((each) => each.id === current);
      if (!entry) {
        entry = {
          id: randomUUID(),
          agent: readSettings(state).chat.agent,
          title: titleOf(message),
          lastActive: 0,
          prompted: false,
        };
        chats.push(entry);
        current = entry.id;
      }
      send({ type: "prompt", message });
      Object.assign(entry, { prompted: true, lastActive: Date.now() });
      save();
    },
    abort: () => session && send({ type: "abort" }),
    /** Answers a question from one of Pi's extensions, which Pi waits on; every page closes it. */
    answer(reply: { id: string }): void {
      if (!session) return;
      send({ type: "extension_ui_response", ...reply });
      emit({ type: "extension_ui_answered", id: reply.id });
    },
    open(id: string): void {
      if (!chats.some((each) => each.id === id)) throw new Error(`no chat ${id}`);
      if (id !== current) show(id);
    },
    fresh: () => show(undefined),
    /** New settings reach the next prompt; another agent means a new chat. */
    retune(): void {
      const entry = chats.find((each) => each.id === current);
      if (entry && entry.agent !== readSettings(state).chat.agent) show(undefined);
      else stop();
    },
  };
}

/** Before chats.json there was one chat, in chat.json and chat.jsonl: it becomes the first entry. */
function adoptSingleChat(state: string, folder: string): { chats: ChatEntry[]; current?: string } {
  const old = join(state, "chat.json");
  const records = join(state, "chat.jsonl");
  if (!existsSync(old)) return { chats: [] };
  const { agent, id, prompted } = JSON.parse(readFileSync(old, "utf8"));
  rmSync(old);
  if (!prompted || !existsSync(records)) return { chats: [] };
  const asked = readFileSync(records, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as { message?: { role: string; content: string | { text?: string }[] } },
    )
    .find((record) => record.message?.role === "user")?.message?.content;
  const text = typeof asked === "string" ? asked : asked?.find((part) => part.text)?.text;
  const title = text ? titleOf(text) : "Earlier chat";
  renameSync(records, join(folder, `${id}.jsonl`));
  return {
    chats: [
      { id, agent, title, lastActive: statSync(join(folder, `${id}.jsonl`)).mtimeMs, prompted },
    ],
    current: id,
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

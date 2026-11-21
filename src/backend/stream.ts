import type { Tokens } from "./types.ts";

/**
 * What factory learns from a runner's JSON event stream without the agent's help: claude's
 * `--output-format stream-json --verbose` and pi's `--mode json`, one record per line.
 */
export type Facts = {
  session?: string;
  /** The tool call under way, as one line. */
  activity?: string;
  /** Context tokens after the latest model call, the largest seen, and compactions so far. */
  context: number;
  peak: number;
  compactions: number;
  tokens: Tokens;
  /** The agent's last words, and an error the runner reported. */
  text?: string;
  error?: string;
};

export const noFacts = (): Facts => ({
  context: 0,
  peak: 0,
  compactions: 0,
  tokens: { input: 0, cached: 0, output: 0 },
});

type Usage = Record<string, number | undefined>;
type Block = { type: string; name?: string; text?: string; input?: Record<string, unknown> };
type Record_ = {
  type?: string;
  subtype?: string;
  id?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  message?: {
    id?: string;
    role?: string;
    content?: Block[] | string;
    usage?: Usage;
    stopReason?: string;
    errorMessage?: string;
  };
  toolName?: string;
  args?: Record<string, unknown>;
  finalError?: string;
  success?: boolean;
};

/** Folds lines of either runner's stream into facts; lines that aren't JSON (stderr) are skipped. */
export function readStream(text: string, facts: Facts = noFacts()): Facts {
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let record: Record_;
    try {
      record = JSON.parse(line);
    } catch {
      // A line still being written.
      continue;
    }
    fold(record, facts, seen);
  }
  return facts;
}

function fold(record: Record_, facts: Facts, seen: Set<string>): void {
  const { type } = record;
  // Claude Code
  if (type === "system" && record.subtype === "init") facts.session = record.session_id;
  if (type === "system" && record.subtype === "compact_boundary") facts.compactions++;
  if (type === "assistant" && record.message) {
    const { message } = record;
    for (const block of blocks(message.content)) {
      if (block.type === "tool_use") facts.activity = describe(block.name ?? "", block.input ?? {});
      if (block.type === "text" && block.text?.trim()) facts.text = block.text;
    }
    // Claude Code repeats a message once per content block, each with the same usage.
    if (message.usage && !(message.id && seen.has(message.id))) {
      if (message.id) seen.add(message.id);
      count(
        facts,
        message.usage.input_tokens,
        message.usage.cache_read_input_tokens,
        message.usage.output_tokens,
      );
      context(
        facts,
        (message.usage.input_tokens ?? 0) +
          (message.usage.cache_read_input_tokens ?? 0) +
          (message.usage.cache_creation_input_tokens ?? 0),
      );
    }
  }
  if (type === "result") {
    if (record.result) facts.text = record.result;
    if (record.is_error) facts.error = record.result ?? record.subtype ?? "error";
    if (record.session_id) facts.session = record.session_id;
  }
  // Pi
  if (type === "session" && record.id) facts.session = record.id;
  if (type === "tool_execution_start")
    facts.activity = describe(record.toolName ?? "", record.args ?? {});
  if (type === "compaction_start") facts.compactions++;
  if (type === "auto_retry_end" && record.success === false) facts.error = record.finalError;
  if (type === "message_end" && record.message?.role === "assistant") {
    const { message } = record;
    const words = blocks(message.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();
    if (words) facts.text = words;
    if (message.stopReason === "error") facts.error = message.errorMessage ?? "error";
    if (message.usage) {
      count(facts, message.usage.input, message.usage.cacheRead, message.usage.output);
      context(
        facts,
        (message.usage.input ?? 0) +
          (message.usage.cacheRead ?? 0) +
          (message.usage.cacheWrite ?? 0),
      );
    }
  }
}

const blocks = (content: Block[] | string | undefined): Block[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);

function count(facts: Facts, input = 0, cached = 0, output = 0): void {
  facts.tokens.input += input;
  facts.tokens.cached += cached;
  facts.tokens.output += output;
}

function context(facts: Facts, tokens: number): void {
  if (tokens === 0) return;
  facts.context = tokens;
  facts.peak = Math.max(facts.peak, tokens);
}

/** One line for a tool call: "editing src/a.ts", "running cargo test". */
function describe(tool: string, input: Record<string, unknown>): string {
  const field = (...names: string[]) => {
    for (const name of names) if (typeof input[name] === "string") return input[name] as string;
    return "";
  };
  const name = tool.toLowerCase();
  const short = (text: string) =>
    (text.length > 80 ? `${text.slice(0, 79)}…` : text).split("\n")[0];
  if (name === "bash") return `running ${short(field("command"))}`;
  if (["edit", "write", "multiedit", "notebookedit"].includes(name))
    return `editing ${field("file_path", "path")}`;
  if (name === "read") return `reading ${field("file_path", "path")}`;
  if (["grep", "glob", "find", "ls"].includes(name))
    return `searching ${short(field("pattern", "path"))}`;
  return tool;
}

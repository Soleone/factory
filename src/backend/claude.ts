// Claude Code's stream-json, spoken as Pi's RPC records so the page reads one format. Trimmed
// from pluck's src-tauri/src/agent/claude.rs: no sessions on disk and no permission prompts.

type Block = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | { text?: string }[];
  is_error?: boolean;
};

export type ClaudeRecord = {
  type: string;
  subtype?: string;
  model?: string;
  parent_tool_use_id?: string | null;
  event?: {
    type: string;
    index?: number;
    content_block?: Block;
    delta?: { type: string; text?: string };
  };
  message?: { content: string | Block[] };
  is_error?: boolean;
  result?: string;
  errors?: string[];
};

export type PiRecord = { type: string; [field: string]: unknown };

const update = (event: object): PiRecord => ({
  type: "message_update",
  assistantMessageEvent: event,
});

export function claudeChat(effort?: string) {
  /** The reply being streamed, as Pi parts, and the index of the block streaming now. */
  let parts: object[] = [];
  let block = 0;
  /** Stop was clicked, so the run ending early isn't an error. */
  let aborted = false;

  return {
    /** What to write to Claude Code for one of Pi's commands, and what the page hears right away. */
    command(record: { type: string; message?: string }): { write: object[]; emit: PiRecord[] } {
      if (record.type === "prompt") {
        aborted = false;
        return {
          write: [{ type: "user", message: { role: "user", content: record.message } }],
          emit: [{ type: "agent_start" }],
        };
      }
      if (record.type === "abort") {
        aborted = true;
        const interrupt = {
          type: "control_request",
          request_id: "abort",
          request: { subtype: "interrupt" },
        };
        return { write: [interrupt], emit: [] };
      }
      return { write: [], emit: [] };
    },

    record(record: ClaudeRecord): PiRecord[] {
      // Subagents' work stays inside the tool call that started them.
      if (record.parent_tool_use_id) return [];
      switch (record.type) {
        case "system":
          if (record.subtype !== "init") return [];
          return [
            {
              type: "response",
              command: "get_state",
              success: true,
              data: { model: { name: record.model }, thinkingLevel: effort ?? "default" },
            },
          ];
        case "stream_event":
          return stream(record.event!);
        // One record per finished block, before the stream says the block stopped.
        case "assistant": {
          const out: PiRecord[] = [];
          for (const each of record.message!.content as Block[]) {
            const piece = part(each);
            if (piece.type === "toolCall")
              out.push(update({ type: "toolcall_end", contentIndex: block, toolCall: piece }));
            while (parts.length <= block) parts.push({ type: "thinking" });
            parts[block] = piece;
          }
          return out;
        }
        case "user":
          return user(record.message!.content).flatMap((message) => [
            { type: "message_start", message },
            { type: "message_end", message },
          ]);
        case "result": {
          const settled = { type: "agent_settled" };
          if (!record.is_error || aborted) return [settled];
          const error = record.result ?? record.errors?.join("; ") ?? "Claude Code failed";
          return [{ type: "response", command: "prompt", success: false, error }, settled];
        }
        default:
          return [];
      }
    },
  };

  /** Pi's stream events for one of the Messages API's. */
  function stream(event: NonNullable<ClaudeRecord["event"]>): PiRecord[] {
    const contentIndex = event.index;
    switch (event.type) {
      case "message_start":
        parts = [];
        block = 0;
        return [{ type: "message_start", message: { role: "assistant", content: [] } }];
      case "content_block_start": {
        block = contentIndex ?? 0;
        const started = event.content_block!;
        if (started.type === "text") return [update({ type: "text_start", contentIndex })];
        if (started.type === "thinking") return [update({ type: "thinking_start", contentIndex })];
        if (started.type === "tool_use" || started.type === "server_tool_use")
          return [
            update({
              type: "toolcall_start",
              contentIndex,
              id: started.id,
              toolName: toolName(started.name!),
            }),
          ];
        return [];
      }
      case "content_block_delta":
        if (event.delta?.type !== "text_delta") return [];
        return [update({ type: "text_delta", contentIndex, delta: event.delta.text })];
      case "message_stop": {
        const content = parts;
        parts = [];
        return [{ type: "message_end", message: { role: "assistant", content } }];
      }
      default:
        return [];
    }
  }
}

/** One block of an assistant message as a Pi part. */
function part(block: Block): { type: string; [field: string]: unknown } {
  if (block.type === "text") return { type: "text", text: block.text ?? "" };
  if (block.type === "tool_use" || block.type === "server_tool_use") {
    const input = block.input ?? {};
    // The page's steps read `path` where Claude Code's tools take `file_path`.
    const path = input.file_path ?? input.notebook_path;
    return {
      type: "toolCall",
      id: block.id,
      name: toolName(block.name!),
      arguments: path === undefined ? input : { ...input, path },
    };
  }
  // Thinking and search results aren't shown, but keep their place in the message.
  return { type: "thinking" };
}

/** Claude Code's tools by the names the page shows steps for. */
const TOOLS: { [name: string]: string } = {
  Bash: "bash",
  Read: "read",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Write: "write",
  Grep: "grep",
  Glob: "find",
};

const toolName = (name: string) => TOOLS[name] ?? name;

/** A user message as Pi messages: the prompt, or the results of the tools the reply called. */
function user(content: string | Block[]): object[] {
  if (typeof content === "string") return [{ role: "user", content }];
  return content
    .filter((block) => block.type === "tool_result")
    .map((result) => ({
      role: "toolResult",
      toolCallId: result.tool_use_id,
      content: [
        {
          type: "text",
          text:
            typeof result.content === "string"
              ? result.content
              : (result.content ?? []).flatMap((block) => block.text ?? []).join("\n"),
        },
      ],
      isError: result.is_error === true,
    }));
}

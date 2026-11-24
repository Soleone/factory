// Claude Code's stream-json, spoken as Pi's RPC records so the page reads one format. Trimmed
// from pluck's src-tauri/src/agent/claude.rs: no sessions on disk, and the only permission prompt is
// AskUserQuestion, which ends the turn so the user's click arrives as the next prompt, as with Pi.

import type { AgentQuestion } from "../components/soleone/agent/ask-user.ts";

type Block = {
  type: string;
  text?: string;
  source?: { media_type: string; data: string };
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
  request_id?: string;
  request?: { subtype: string; tool_name?: string; input?: Record<string, unknown> };
};

export type PiRecord = { type: string; [field: string]: unknown };

/** An image as Pi's prompt command and user messages carry it. */
export type PiImage = { type: "image"; data: string; mimeType: string };

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
  /** The AskUserQuestion call that ends this turn: its refusal is how it stops, not a failure. */
  let question: string | undefined;

  return {
    /** What to write to Claude Code for one of Pi's commands, and what the page hears right away. */
    command(record: { type: string; message?: string; images?: PiImage[] }): {
      write: object[];
      emit: PiRecord[];
    } {
      if (record.type === "prompt") {
        aborted = false;
        question = undefined;
        const images = (record.images ?? []).map(({ data, mimeType }) => ({
          type: "image",
          source: { type: "base64", media_type: mimeType, data },
        }));
        const content = images.length
          ? [...(record.message ? [{ type: "text", text: record.message }] : []), ...images]
          : record.message;
        return {
          write: [{ type: "user", message: { role: "user", content } }],
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

    /** What the page hears for one of Claude Code's records, and what to write back to it. */
    record(record: ClaudeRecord): { write: object[]; emit: PiRecord[] } {
      if (record.type === "control_request") return { write: [permit(record)], emit: [] };
      return { write: [], emit: translate(record) };
    },
  };

  function translate(record: ClaudeRecord): PiRecord[] {
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
          if (piece.name === "ask_user") question = piece.id as string;
          if (piece.type === "toolCall")
            out.push(update({ type: "toolcall_end", contentIndex: block, toolCall: piece }));
          while (parts.length <= block) parts.push({ type: "thinking" });
          parts[block] = piece;
        }
        return out;
      }
      case "user":
        return user(record.message!.content, question).flatMap((message) => [
          { type: "message_start", message },
          { type: "message_end", message },
        ]);
      case "result": {
        const settled = { type: "agent_settled" };
        if (!record.is_error || aborted || question) return [settled];
        const error = record.result ?? record.errors?.join("; ") ?? "Claude Code failed";
        return [{ type: "response", command: "prompt", success: false, error }, settled];
      }
      default:
        return [];
    }
  }

  /** Under bypassPermissions only questions ask; any other tool may run. */
  function permit({ request_id, request }: ClaudeRecord): object {
    const response =
      request?.tool_name === "AskUserQuestion"
        ? {
            behavior: "deny",
            message: "Shown to the user as buttons. Their answer comes as their next message.",
            interrupt: true,
          }
        : { behavior: "allow", updatedInput: request?.input };
    return { type: "control_response", response: { subtype: "success", request_id, response } };
  }

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
      arguments:
        block.name === "AskUserQuestion"
          ? card(input)
          : path === undefined
            ? input
            : { ...input, path },
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
  AskUserQuestion: "ask_user",
};

const toolName = (name: string) => TOOLS[name] ?? name;

type Asked = {
  question?: string;
  multiSelect?: boolean;
  options?: { label?: string; description?: string }[];
};

const RECOMMENDED = /\s*\(Recommended\)$/;
const recommended = ({ label }: { label?: string }) => RECOMMENDED.test(String(label));

/**
 * AskUserQuestion's questions as ask_user's one card: the first single choice as buttons with the
 * recommended one first, multi-select options as checkboxes, and other questions in the text, for
 * the user to answer by typing.
 */
function card(input: Record<string, unknown>): AgentQuestion {
  const questions = (Array.isArray(input.questions) ? input.questions : []) as Asked[];
  const choice = questions.find((each) => !each.multiSelect) ?? questions[0];
  const rest = questions.filter((each) => each !== choice);
  const options = choice?.options ?? [];
  return {
    question: [choice, ...rest.filter((each) => !each.multiSelect)]
      .flatMap((each) => each?.question ?? [])
      .join(" "),
    options: [...options.filter(recommended), ...options.filter((each) => !recommended(each))].map(
      ({ label, description }) => ({ label: String(label).replace(RECOMMENDED, ""), description }),
    ),
    extras: rest
      .filter((each) => each.multiSelect)
      .flatMap((each) => each.options ?? [])
      .map(({ label }) => ({ label: String(label).replace(RECOMMENDED, "") })),
  };
}

/**
 * A user message as Pi messages: the prompt, or the results of the tools the reply called. The
 * refused `question` and the interruption it causes are how a question ends the turn, so neither
 * shows as a failure.
 */
function user(content: string | Block[], question: string | undefined): object[] {
  if (typeof content === "string") return [{ role: "user", content }];
  if (!content.some((block) => block.type === "tool_result")) {
    if (question && content.every((block) => block.text?.startsWith("[Request interrupted")))
      return [];
    return [{ role: "user", content: content.map(promptPart) }];
  }
  return content
    .filter((block) => block.type === "tool_result")
    .map((result) => ({
      role: "toolResult",
      toolCallId: result.tool_use_id,
      content: [
        {
          type: "text",
          text:
            result.tool_use_id === question
              ? "Shown to the user."
              : typeof result.content === "string"
                ? result.content
                : (result.content ?? []).flatMap((block) => block.text ?? []).join("\n"),
        },
      ],
      isError: result.is_error === true && result.tool_use_id !== question,
    }));
}

/** A block of a prompt with images, as Pi's user message parts. */
const promptPart = (block: Block): object =>
  block.type === "image"
    ? { type: "image", data: block.source!.data, mimeType: block.source!.media_type }
    : { type: "text", text: block.text ?? "" };

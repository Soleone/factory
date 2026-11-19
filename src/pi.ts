import { piStep, type AgentMessage, type AgentTool } from "@/components/soleone/agent";

// Pi's RPC records and messages, reduced to the fields the page reads; from pluck's src/agent/pi.ts.
// See Pi's docs/rpc.md.

type Part =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "thinking" | "image" };

type PiMessage =
  | { role: "user"; content: string | Part[] }
  | {
      role: "assistant";
      content: Part[];
      stopReason?: string;
      errorMessage?: string;
      provider?: string;
      model?: string;
    }
  | { role: "toolResult"; toolCallId: string; content: Part[]; isError: boolean }
  | { role: "system" | "bashExecution" | "custom" };

type StreamEvent =
  | { type: "text_start" | "thinking_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: Part }
  | { type: string };

/** Pi's records, plus `exit`, `reset` and `extension_ui_answered` from factory serve. Which fields are set depends on `type`. */
export type PiRecord = {
  type: string;
  message?: PiMessage;
  assistantMessageEvent?: StreamEvent;
  command?: string;
  id?: string;
  method?: string;
  success?: boolean;
  error?: string;
  data?: unknown;
};

/** A question from one of Pi's extensions; Pi waits for the answer, or its timeout. */
export type PiDialog =
  | { id: string; method: "select"; title: string; options: string[] }
  | { id: string; method: "confirm"; title: string; message?: string }
  | { id: string; method: "input"; title: string; placeholder?: string }
  | { id: string; method: "editor"; title: string; prefill?: string };

/** The answer fields of Pi's `extension_ui_response`, without its type and id. */
export type DialogAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };

const DIALOGS = ["select", "confirm", "input", "editor"];

export type Transcript = {
  messages: PiMessage[];
  busy: boolean;
  /** Unanswered questions, oldest first. */
  dialogs: PiDialog[];
  error?: string;
  model?: { name: string; thinking: string };
};

export const emptyTranscript: Transcript = { messages: [], busy: false, dialogs: [] };

export function applyRecord(transcript: Transcript, record: PiRecord): Transcript {
  const { messages } = transcript;
  switch (record.type) {
    case "agent_start":
      return { ...transcript, busy: true, error: undefined };
    // Pi gives up on a question when the run ends.
    case "agent_settled":
      return { ...transcript, busy: false, dialogs: [] };
    case "exit":
      return { ...transcript, busy: false, dialogs: [], error: record.error };
    case "extension_ui_request":
      // Notifications and status lines need no answer.
      if (!DIALOGS.includes(record.method!)) return transcript;
      return { ...transcript, dialogs: [...transcript.dialogs, record as unknown as PiDialog] };
    case "extension_ui_answered":
      return {
        ...transcript,
        dialogs: transcript.dialogs.filter((dialog) => dialog.id !== record.id),
      };
    case "reset":
      return emptyTranscript;
    case "message_start":
      return { ...transcript, messages: [...messages, record.message!] };
    case "message_end":
      return { ...transcript, messages: [...messages.slice(0, -1), record.message!] };
    case "message_update": {
      const last = messages.at(-1);
      if (last?.role !== "assistant") return transcript;
      const content = stream(last.content, record.assistantMessageEvent!);
      return { ...transcript, messages: [...messages.slice(0, -1), { ...last, content }] };
    }
    case "response":
      if (!record.success) return { ...transcript, error: record.error };
      if (record.command === "get_messages")
        return { ...transcript, messages: (record.data as { messages: PiMessage[] }).messages };
      if (record.command === "get_state") {
        const state = record.data as { model?: { name: string }; thinkingLevel: string };
        return state.model
          ? { ...transcript, model: { name: state.model.name, thinking: state.thinkingLevel } }
          : transcript;
      }
      return transcript;
    default:
      return transcript;
  }
}

/** Builds the streaming reply from Pi's deltas; `message_end` then replaces it with the final one. */
function stream(content: Part[], event: StreamEvent): Part[] {
  if (!("contentIndex" in event)) return content;
  const next = [...content];
  const index = event.contentIndex;
  if (event.type === "text_start") next[index] = { type: "text", text: "" };
  else if (event.type === "thinking_start") next[index] = { type: "thinking" };
  else if (event.type === "text_delta" && "delta" in event) {
    const part = next[index];
    next[index] = { type: "text", text: (part?.type === "text" ? part.text : "") + event.delta };
  } else if (event.type === "toolcall_start" && "toolName" in event)
    next[index] = { type: "toolCall", id: event.id, name: event.toolName, arguments: {} };
  else if (event.type === "toolcall_end" && "toolCall" in event) next[index] = event.toolCall;
  return next;
}

export function agentMessages({ messages, busy }: Transcript): AgentMessage[] {
  const results = new Map<string, Extract<PiMessage, { role: "toolResult" }>>();
  for (const message of messages)
    if (message.role === "toolResult") results.set(message.toolCallId, message);

  return messages.flatMap((message, index): AgentMessage[] => {
    const id = String(index);
    if (message.role === "user") return [{ id, role: "user", text: textOf(message.content) }];
    if (message.role !== "assistant") return [];
    const tools = message.content.flatMap((part) =>
      part.type === "toolCall" ? [toolOf(part, results.get(part.id), busy)] : [],
    );
    // Pi's errors, like "Connection error.", don't say which model failed.
    const failure =
      message.stopReason === "error"
        ? [message.errorMessage, message.model && `(${message.provider}/${message.model})`]
            .filter(Boolean)
            .join(" ")
        : undefined;
    const text = [textOf(message.content), failure && `**Error:** ${failure}`]
      .filter(Boolean)
      .join("\n\n");
    return [{ id, role: "assistant", text, tools }];
  });
}

function textOf(content: string | Part[]) {
  if (typeof content === "string") return content;
  return content.flatMap((part) => (part?.type === "text" ? [part.text] : [])).join("\n\n");
}

function toolOf(
  call: Extract<Part, { type: "toolCall" }>,
  result: Extract<PiMessage, { role: "toolResult" }> | undefined,
  busy: boolean,
): AgentTool {
  // A call without a result after the run ended was cut off.
  const status = result ? (result.isError ? "error" : "complete") : busy ? "running" : "error";
  const output = result && textOf(result.content);
  return { id: call.id, name: call.name, status, output, ...piStep(call, status, output) };
}

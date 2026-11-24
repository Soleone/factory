import { expect, test } from "vite-plus/test";
import { claudeChat } from "../src/backend/claude.ts";

// The records Claude Code 2.1 wrote for an AskUserQuestion under --permission-prompt-tool stdio.
const ask = {
  type: "tool_use",
  id: "toolu_1",
  name: "AskUserQuestion",
  input: {
    questions: [
      {
        question: "Build dark mode now, or plan it first?",
        header: "Approach",
        multiSelect: false,
        options: [
          { label: "Build now", description: "Start right away." },
          { label: "Plan first (Recommended)", description: "Confirm the approach first." },
        ],
      },
      {
        question: "Which colors should it cover?",
        header: "Scope",
        multiSelect: false,
        options: [{ label: "All" }, { label: "Text only" }],
      },
      {
        question: "What else?",
        header: "Extras",
        multiSelect: true,
        options: [{ label: "Tests (Recommended)" }, { label: "Docs" }],
      },
    ],
  },
};

test("an AskUserQuestion ends the turn as an ask_user card, without failing", () => {
  const chat = claudeChat();
  chat.command({ type: "prompt", message: "Add dark mode" });
  const call = chat.record({ type: "assistant", message: { content: [ask] } }).emit;
  expect(call[0]).toMatchObject({
    assistantMessageEvent: {
      toolCall: {
        name: "ask_user",
        arguments: {
          question: "Build dark mode now, or plan it first? Which colors should it cover?",
          options: [
            { label: "Plan first", description: "Confirm the approach first." },
            { label: "Build now", description: "Start right away." },
          ],
          extras: [{ label: "Tests" }, { label: "Docs" }],
        },
      },
    },
  });

  const { write } = chat.record({
    type: "control_request",
    request_id: "r1",
    request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: ask.input },
  });
  expect(write).toEqual([
    {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "r1",
        response: expect.objectContaining({ behavior: "deny", interrupt: true }),
      },
    },
  ]);

  const refused = chat.record({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "Rejected" },
      ],
    },
  }).emit;
  expect(refused[1]).toMatchObject({ message: { role: "toolResult", isError: false } });
  const interrupted = {
    type: "user",
    message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] },
  };
  expect(chat.record(interrupted).emit).toEqual([]);
  const end = { type: "result", subtype: "error_during_execution", is_error: true };
  expect(chat.record(end).emit).toEqual([{ type: "agent_settled" }]);
});

test("other tools run under bypassPermissions, so any request for one is allowed", () => {
  const input = { command: "ls" };
  const { write } = claudeChat().record({
    type: "control_request",
    request_id: "r2",
    request: { subtype: "can_use_tool", tool_name: "Bash", input },
  });
  expect(write[0]).toMatchObject({
    response: { response: { behavior: "allow", updatedInput: input } },
  });
});

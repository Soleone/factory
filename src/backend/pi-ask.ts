import { askUser } from "../components/soleone/agent/ask-user.ts";

/** A Pi extension the Plan chat loads, so Pi can end its turn with a question the page draws as buttons. */
export default function askUserExtension(pi: { registerTool(tool: object): void }) {
  pi.registerTool({
    name: askUser.name,
    label: "Ask",
    description: askUser.description,
    promptSnippet: "Ask the user to choose how to continue",
    promptGuidelines: [askUser.prompt],
    parameters: askUser.parameters,
    execute: async () => ({
      content: [{ type: "text", text: "Question shown. Stop and wait for the user's answer." }],
      details: {},
      terminate: true,
    }),
  });
}

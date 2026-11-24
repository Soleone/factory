import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { AgentDialog } from "@/AgentDialog";
import { api } from "@/api";
import type { ChatEntry } from "@/backend/chat.ts";
import type { Snapshot } from "@/backend/types.ts";
import { AgentPanel, AgentSessionSwitcher, type AgentReferences } from "@/components/soleone/agent";
import { agentName, itemTitle } from "@/format";
import { agentMessages, applyRecord, contextTokens, emptyTranscript } from "@/pi";
import { ChatAgentFields } from "@/RunFields";
import { StateIcon, taskState } from "@/TaskDetails";

/** The Live Agent's chats and the current one's transcript, as serve streams them. */
export function useChat() {
  const [transcript, setTranscript] = useState(emptyTranscript);
  const [chats, setChats] = useState<ChatEntry[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const events = new EventSource("/api/chat");
    // On every (re)connect the server replays the list and the current chat so far.
    events.onopen = () => setTranscript(emptyTranscript);
    events.onmessage = (event) => {
      const record = JSON.parse(event.data);
      if (record.type === "chats") {
        setChats(record.chats);
        setCurrent(record.current ?? null);
      } else setTranscript((transcript) => applyRecord(transcript, record));
    };
    return () => events.close();
  }, []);

  async function run(change: () => Promise<unknown>): Promise<boolean> {
    try {
      await change();
      setError(undefined);
      return true;
    } catch (failure) {
      setError((failure as Error).message);
      return false;
    }
  }

  return { transcript, chats, current, error, run };
}

export type Chat = ReturnType<typeof useChat>;

/** The title switcher in the agent's header. Opening another chat ends a reply still running. */
export function ChatSwitcher({ chat }: { chat: Chat }) {
  return (
    <AgentSessionSwitcher
      sessions={chat.chats.map((entry) => ({
        id: entry.id,
        title: entry.title,
        detail: agentName(entry.agent),
        lastActive: entry.lastActive,
        busy: entry.id === chat.current && chat.transcript.busy,
      }))}
      current={chat.current}
      onSelect={(id) => void chat.run(() => api.openChat(id))}
      onNew={() => void chat.run(api.newChat)}
    />
  );
}

const suggestions = [
  "Pick five auto jobs for tonight that won't conflict",
  "What failed overnight, and is any of it worth retrying?",
  "Review the open PRs and say which you'd merge",
];

/** A chat about what to queue; the agent adds jobs through the factory CLI once you agree. */
export function PlanView({
  chat,
  settings,
  prompt,
  onPromptChange,
  references,
}: {
  chat: Chat;
  settings: Snapshot["settings"];
  prompt: string;
  onPromptChange: Dispatch<SetStateAction<string>>;
  references: AgentReferences;
}) {
  const { transcript, run } = chat;
  const dialog = transcript.dialogs[0];
  const agent = chat.chats.find((entry) => entry.id === chat.current)?.agent ?? settings.chat.agent;

  return (
    <>
      {dialog && (
        <AgentDialog
          key={dialog.id}
          dialog={dialog}
          onAnswer={(answer) => void run(() => api.answerChat({ id: dialog.id, ...answer }))}
        />
      )}
      <AgentPanel
        messages={agentMessages(transcript)}
        prompt={prompt}
        onPromptChange={onPromptChange}
        busy={transcript.busy}
        model={transcript.model}
        contextTokens={contextTokens(transcript)}
        modelPicker={
          <>
            <ChatAgentFields
              value={settings.chat}
              onChange={(next) => void run(() => api.saveSettings({ ...settings, chat: next }))}
            />
            <p className="text-xs text-muted-foreground">
              Applies from the next message. Another agent starts a new chat.
            </p>
          </>
        }
        error={chat.error ?? transcript.error}
        placeholder="What should the factory work on next?"
        emptyTitle="Plan the queue"
        emptyDescription={`${agentName(agent)} looks through the candidates and queues jobs once you agree. It never turns the factory on.`}
        suggestions={suggestions}
        onSend={(text, images) => run(() => api.chat(text, images))}
        onStop={() => void run(api.abortChat)}
        acceptImages
        references={references}
      />
    </>
  );
}

/** The `factory:job/<id>` links the Live Agent writes, as chips that open the job's pop-up. */
export function jobReferences(snapshot: Snapshot, open: (id: string) => void): AgentReferences {
  return (href) => {
    const id = href.match(/^factory:job\/(\w+)$/)?.[1];
    const job = snapshot.jobs.find((each) => each.id === id);
    if (!job) return undefined;
    const state = taskState(job, snapshot.prs);
    return {
      title: `${itemTitle(job.item)} · ${state}`,
      icon: <StateIcon state={state} />,
      onOpen: () => open(job.id),
    };
  };
}

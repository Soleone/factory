import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { RotateCcw } from "lucide-react";
import { api } from "@/api";
import { AgentPanel } from "@/components/soleone/agent";
import { Button } from "@/components/ui/button";
import { agentMessages, applyRecord, emptyTranscript } from "@/pi";

/** A chat with Pi about what to queue; Pi adds jobs through the factory CLI once you agree. */
export function PlanView({
  prompt,
  onPromptChange,
}: {
  prompt: string;
  onPromptChange: Dispatch<SetStateAction<string>>;
}) {
  const [transcript, setTranscript] = useState(emptyTranscript);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const events = new EventSource("/api/chat");
    // On every (re)connect the server replays the conversation, if Pi is still running.
    events.onopen = () => setTranscript(emptyTranscript);
    events.onmessage = (event) =>
      setTranscript((current) => applyRecord(current, JSON.parse(event.data)));
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

  return (
    <div className="flex h-[calc(100svh-11rem)] min-h-96 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Pi looks through the candidates and queues jobs once you agree. It never turns the factory
          on.
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={transcript.messages.length === 0}
          onClick={() => void run(api.resetChat)}
        >
          <RotateCcw />
          New chat
        </Button>
      </div>
      <AgentPanel
        messages={agentMessages(transcript)}
        prompt={prompt}
        onPromptChange={onPromptChange}
        busy={transcript.busy}
        model={transcript.model}
        error={error ?? transcript.error}
        placeholder="What should the factory work on next?"
        emptyTitle="Plan the queue"
        emptyDescription="For example: pick five auto jobs for tonight that won't conflict."
        onSend={(text) => run(() => api.chat(text))}
        onStop={() => void run(api.abortChat)}
      />
    </div>
  );
}

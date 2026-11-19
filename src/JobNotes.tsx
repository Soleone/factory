import { useState } from "react";
import { api, type Act } from "@/api";
import type { Job, Note } from "@/backend/types.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const KIND = {
  note: "note",
  ask: "asked",
  answer: "you answered",
  result: "result",
  train: "merge train",
};

/** What the agent reported last, and the follow-ups worth their own job. */
export function Outcome({
  job,
  act,
  queued,
}: {
  job: Job;
  act: Act;
  /** Follow-ups that already have a job. */
  queued: Set<string>;
}) {
  const result = job.notes.findLast((note) => note.kind === "result");
  const followups = [...new Set(job.notes.flatMap((note) => note.followups ?? []))];
  const branch = job.attempts.at(-1)?.branch;
  if (!result && followups.length === 0 && !branch) return null;
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-popover p-2 text-sm">
      {result && (
        <span>
          {result.text}{" "}
          {result.confidence && <Badge variant="outline">{result.confidence} confidence</Badge>}
        </span>
      )}
      {branch && (
        <span className="text-muted-foreground">Unpushed work kept on branch {branch}</span>
      )}
      {followups.map((task) => (
        <span key={task} className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
          <span>Follow-up: {task}</span>
          {queued.has(task) ? (
            <span>queued</span>
          ) : (
            <Button
              variant="outline"
              size="xs"
              onClick={() => act(() => api.followup(job.id, task))}
            >
              Queue
            </Button>
          )}
        </span>
      ))}
    </div>
  );
}

export function Answer({ job, question, act }: { job: Job; question: Note; act: Act }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const send = async () => {
    setSending(true);
    try {
      await act(() => api.answer(job.id, text.trim()));
    } finally {
      setSending(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-warning/60 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <span className="text-foreground">
        {job.agent} asks: {question.text}
      </span>
      <span className="flex gap-2">
        <Input
          aria-label="Your answer"
          placeholder="Your answer; the job goes back in the queue with it"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" disabled={sending || !text.trim()}>
          {sending ? "Sending…" : "Answer"}
        </Button>
      </span>
    </form>
  );
}

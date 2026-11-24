import { ArrowUpIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api, type Act } from "@/api";
import type { Job, Note } from "@/backend/types.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const KIND: Record<Note["kind"], string> = {
  note: "note",
  ask: "asked",
  assume: "assumed",
  answer: "you answered",
  result: "result",
  step: "step",
  train: "merge train",
  factory: "factory",
  alone: "needs to run alone",
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
  // A review's findings go to its fix, not jobs of their own.
  const review = job.item.blueprint === "review";
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
          <span>
            {review ? "Finding" : "Follow-up"}: {task}
          </span>
          {review ? null : queued.has(task) ? (
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
  return (
    <>
      <Said label={`${job.agent} asks`}>{question.text}</Said>
      <Reply
        placeholder="Answer, and the job goes back in the queue"
        send={(text) => act(() => api.answer(job.id, text))}
      />
    </>
  );
}

/** What an agent said, as a speech bubble under its row. */
export function Said({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <p className="max-w-prose rounded-xl rounded-tl-sm bg-muted px-3 py-2 text-sm text-foreground">
      <span className="block text-xs font-semibold tracking-wide text-warning uppercase">
        {label}
      </span>
      {children}
    </p>
  );
}

/** A one-line answer field with its send button inside. */
export function Reply({
  placeholder,
  send,
}: {
  placeholder: string;
  send: (text: string) => Promise<unknown>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  return (
    <form
      className="flex max-w-prose items-center gap-1.5 rounded-xl border p-1 pl-3.5 transition-colors focus-within:border-warning/60"
      onSubmit={async (event) => {
        event.preventDefault();
        setSending(true);
        try {
          await send(text.trim());
        } finally {
          setSending(false);
        }
      }}
    >
      <input
        aria-label="Your answer"
        className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground"
        placeholder={placeholder}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <Button
        type="submit"
        size="icon-sm"
        aria-label="Send answer"
        disabled={sending || !text.trim()}
      >
        <ArrowUpIcon />
      </Button>
    </form>
  );
}

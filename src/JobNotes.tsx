import { useState } from "react";
import { api, type Act } from "@/api";
import type { Job, Note } from "@/backend/types.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clock } from "@/format";

export const KIND = { note: "note", ask: "asked", answer: "you answered", result: "result" };

/**
 * What the job's agents said through the factory CLI: the latest result, the question a blocked job
 * waits on, follow-ups worth their own job, and the notes along the way.
 */
export function JobNotes({
  job,
  act,
  queuedTasks,
}: {
  job: Job;
  act: Act;
  /** Follow-ups that already have a job. */
  queuedTasks: Set<string>;
}) {
  const result = job.notes.findLast((note) => note.kind === "result");
  const question =
    job.state === "blocked" ? job.notes.findLast((note) => note.kind === "ask") : undefined;
  const followups = [...new Set(job.notes.flatMap((note) => note.followups ?? []))];
  const notes = job.notes.filter((note) => note.kind !== "result");
  return (
    <>
      {result && (
        <span className="text-foreground">
          {result.text}{" "}
          {result.confidence && <Badge variant="outline">{result.confidence} confidence</Badge>}
        </span>
      )}
      {question && <Answer job={job} question={question} act={act} />}
      {followups.map((task) => (
        <span key={task} className="flex flex-wrap items-center gap-x-2">
          <span>Follow-up: {task}</span>
          {queuedTasks.has(task) ? (
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
      {notes.length > 0 && (
        <details>
          <summary className="cursor-pointer">
            {notes.length} {notes.length === 1 ? "note" : "notes"}
          </summary>
          <ul className="flex flex-col gap-1 pt-1">
            {notes.map((note) => (
              <li key={`${note.at} ${note.text}`}>
                {clock(note.at)} · attempt {note.attempt} · {KIND[note.kind]}: {note.text}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function Answer({ job, question, act }: { job: Job; question: Note; act: Act }) {
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
      className="flex flex-col gap-2 rounded-md border border-(--om-accent) p-2"
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
        <Button type="submit" size="sm" disabled={sending || !text.trim()}>
          {sending ? "Sending…" : "Answer"}
        </Button>
      </span>
    </form>
  );
}

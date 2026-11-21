import type { Act } from "@/api";
import type { Attempt, Job, Snapshot } from "@/backend/types.ts";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { clock } from "@/format";
import { KIND } from "@/JobNotes";
import { TaskDetails } from "@/TaskDetails";

/** `ended` is the attempt an entry ends; `step` the number a step has within its attempt. */
type Entry = { at: string; job: Job; text: string; tone?: string; ended?: Attempt; step?: string };

const SHOWN = 200;

/** Turns, follow-ups, peak context and compactions, as far as the runner reported them. */
function attemptNumbers(attempt: Attempt): string {
  if (!attempt.turns) return "";
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  return [
    plural(attempt.turns, "turn"),
    attempt.followups ? plural(attempt.followups, "follow-up") : "",
    attempt.peak ? `peak ${Math.round(attempt.peak / 1000)}k` : "",
    attempt.compactions ? plural(attempt.compactions, "compaction") : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/** Everything that happened to one job: queued, each attempt's start and end, and what its agents said. */
export function jobEntries(job: Job): Entry[] {
  return [
    { at: job.added, job, text: `queued${job.agent ? ` for ${job.agent}` : ""}` },
    ...job.attempts.flatMap((attempt) => [
      { at: attempt.start, job, text: `${attempt.agent} started` },
      {
        at: attempt.end,
        job,
        text: [
          `${attempt.preset ?? attempt.agent} ${attempt.outcome}`,
          attempt.url?.replace("https://github.com/", ""),
          attemptNumbers(attempt),
        ]
          .filter(Boolean)
          .join(" · "),
        tone: attempt.outcome === "done" ? undefined : "text-destructive",
        ended: attempt,
      },
    ]),
    ...job.notes.map((note): Entry => {
      if (note.kind !== "step")
        return {
          at: note.at,
          job,
          text: `${KIND[note.kind]}: ${note.text}`,
          tone:
            note.kind === "ask"
              ? "text-foreground font-medium"
              : note.kind === "result"
                ? "text-foreground"
                : undefined,
        };
      // Agents don't know their step count up front, so steps are numbered as they come.
      const number = job.notes.filter(
        (other) => other.kind === "step" && other.attempt === note.attempt && other.at <= note.at,
      ).length;
      return {
        at: note.at,
        job,
        text: note.text,
        tone: "text-foreground",
        step: note.of ? `${note.done ?? number}/${note.of}` : String(number),
      };
    }),
  ];
}

/** Everything that happened to the jobs, newest first: what the night looked like, in order. */
function entries(jobs: Job[]): Entry[] {
  return jobs
    .filter((job) => job.state !== "removed")
    .flatMap(jobEntries)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, SHOWN);
}

/** A step's number within its attempt, as a small pill before its text. */
export function StepNumber({ step }: { step: string }) {
  return (
    <span className="mr-2 inline-flex min-w-5 justify-center rounded-full bg-primary/15 px-1.5 text-xs font-medium text-primary tabular-nums">
      {step}
    </span>
  );
}

export const dayOf = (iso: string) =>
  new Date(iso).toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });

export function ActivityView({ snapshot, act }: { snapshot: Snapshot; act: Act }) {
  const shown = entries(snapshot.jobs);
  if (shown.length === 0)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Nothing happened yet</EmptyTitle>
          <EmptyDescription>
            Jobs queued, started and finished show up here, with what their agents said.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  const days = new Map<string, Entry[]>();
  for (const entry of shown) {
    const day = dayOf(entry.at);
    days.set(day, [...(days.get(day) ?? []), entry]);
  }
  return (
    <div className="flex flex-col gap-6 pt-2">
      {[...days].map(([day, dayEntries]) => (
        <section key={day} className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">{day}</h2>
          <ol className="flex flex-col gap-1.5 text-sm">
            {dayEntries.map((entry) => (
              <li
                key={`${entry.at} ${entry.job.id} ${entry.text}`}
                className="grid grid-cols-[4.5rem_1fr] gap-x-3 sm:grid-cols-[4.5rem_16rem_1fr]"
              >
                <time
                  dateTime={entry.at}
                  className="whitespace-nowrap text-muted-foreground tabular-nums"
                >
                  {clock(entry.at)}
                </time>
                <TaskDetails item={entry.job.item} job={entry.job} snapshot={snapshot} act={act} />
                <span
                  className={`col-start-2 wrap-anywhere sm:col-start-3 ${entry.tone ?? "text-muted-foreground"}`}
                >
                  {entry.step && <StepNumber step={entry.step} />}
                  {entry.text}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

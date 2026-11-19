import type { Attempt, Job } from "@/backend/types.ts";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { clock, itemTitle } from "@/format";
import { KIND } from "@/JobNotes";

/** `ended` is the attempt an entry ends. */
type Entry = { at: string; job: Job; text: string; tone?: string; ended?: Attempt };

const SHOWN = 200;

/** Everything that happened to one job: queued, each attempt's start and end, and what its agents said. */
export function jobEntries(job: Job): Entry[] {
  return [
    { at: job.added, job, text: `queued${job.agent ? ` for ${job.agent}` : ""}` },
    ...job.attempts.flatMap((attempt) => [
      { at: attempt.start, job, text: `${attempt.agent} started` },
      {
        at: attempt.end,
        job,
        text: `${attempt.agent} ${attempt.outcome}${attempt.url ? ` · ${attempt.url.replace("https://github.com/", "")}` : ""}`,
        tone: attempt.outcome === "done" ? undefined : "text-destructive",
        ended: attempt,
      },
    ]),
    ...job.notes.map((note) => ({
      at: note.at,
      job,
      text: `${KIND[note.kind]}: ${note.text}`,
      tone: note.kind === "ask" ? "text-foreground font-medium" : undefined,
    })),
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

export const dayOf = (iso: string) =>
  new Date(iso).toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });

export function ActivityView({ jobs, onOpen }: { jobs: Job[]; onOpen: (id: string) => void }) {
  const shown = entries(jobs);
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
                <a
                  href={`?tab=results&job=${entry.job.id}`}
                  className="truncate underline-offset-4 hover:underline"
                  onClick={(event) => {
                    event.preventDefault();
                    onOpen(entry.job.id);
                  }}
                >
                  {itemTitle(entry.job.item)}
                </a>
                <span
                  className={`col-start-2 wrap-anywhere sm:col-start-3 ${entry.tone ?? "text-muted-foreground"}`}
                >
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

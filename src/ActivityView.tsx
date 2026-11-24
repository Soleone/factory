import {
  CircleCheckIcon,
  CircleXIcon,
  FactoryIcon,
  FlagIcon,
  LightbulbIcon,
  LockIcon,
  ListPlusIcon,
  MessageCircleQuestionIcon,
  PlayIcon,
  ReplyIcon,
  StickyNoteIcon,
  TrainFrontIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type { Act } from "@/api";
import {
  ACTIVITY_LIMIT,
  type Attempt,
  type Job,
  type Note,
  type Snapshot,
} from "@/backend/types.ts";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { clock } from "@/format";
import { KIND } from "@/JobNotes";
import { TaskDetails } from "@/TaskDetails";

/**
 * `icon` marks the kind of event, colored on its own; steps go without one, their number marks them.
 * `ended` is the attempt an entry ends; `step` the number a step has within its attempt.
 */
type Entry = {
  at: string;
  job: Job;
  text: string;
  icon?: ReactNode;
  tone?: string;
  ended?: Attempt;
  step?: string;
};

const NOTE_ICONS: Record<Exclude<Note["kind"], "step">, ReactNode> = {
  note: <StickyNoteIcon className="text-muted-foreground" />,
  ask: <MessageCircleQuestionIcon className="text-warning" />,
  assume: <LightbulbIcon className="text-warning" />,
  answer: <ReplyIcon className="text-muted-foreground" />,
  result: <FlagIcon className="text-primary" />,
  train: <TrainFrontIcon className="text-muted-foreground" />,
  factory: <FactoryIcon className="text-muted-foreground" />,
  alone: <LockIcon className="text-muted-foreground" />,
};

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
    {
      at: job.added,
      job,
      text: `queued${job.agent ? ` for ${job.agent}` : ""}`,
      icon: <ListPlusIcon className="text-muted-foreground" />,
    },
    ...job.attempts.flatMap((attempt) => [
      {
        at: attempt.start,
        job,
        text: `${attempt.agent} started`,
        icon: <PlayIcon className="text-muted-foreground" />,
      },
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
        icon:
          attempt.outcome === "done" ? (
            <CircleCheckIcon className="text-success" />
          ) : (
            <CircleXIcon className="text-destructive" />
          ),
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
          icon: NOTE_ICONS[note.kind],
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
    .slice(0, ACTIVITY_LIMIT);
}

/** A single-digit step number fits in its mark instead of the dot. */
const fitsMark = (step: string) => step.length === 1;

/** A step's number within its attempt, as a small pill before its text, when its mark can't hold it. */
export function StepNumber({ step }: { step: string }) {
  if (fitsMark(step)) return null;
  return (
    <span className="mr-2 inline-flex min-w-5 justify-center rounded-full bg-primary/15 px-1.5 text-xs font-medium text-primary tabular-nums">
      {step}
    </span>
  );
}

/** An entry's icon, or for a step its number in an accent circle, or a dot when the number is too long. */
export function EntryMark({ entry }: { entry: Entry }) {
  if (!entry.icon && entry.step && fitsMark(entry.step))
    return (
      <span className="flex size-4 items-center justify-center rounded-full bg-primary text-3xs font-semibold text-primary-foreground tabular-nums">
        {entry.step}
      </span>
    );
  return (
    <span aria-hidden className="flex size-4 items-center justify-center [&_svg]:size-3.5">
      {entry.icon ?? <span className="size-2 rounded-full bg-primary" />}
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
                  className={`col-start-2 flex gap-2 wrap-anywhere sm:col-start-3 ${entry.tone ?? "text-muted-foreground"}`}
                >
                  <span className="mt-0.5">
                    <EntryMark entry={entry} />
                  </span>
                  <span>
                    {entry.step && <StepNumber step={entry.step} />}
                    {entry.text}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

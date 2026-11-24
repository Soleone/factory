import { useEffect, useState, type ReactNode } from "react";
import { api, type Act } from "@/api";
import { dayOf, EntryMark, jobEntries, StepNumber } from "@/ActivityView";
import { AttemptFile } from "@/AttemptFile";
import { openAssumptions, prUrl, type Item, type Job, type Snapshot } from "@/backend/types.ts";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollingTabsContent } from "@/components/variants/dialog";
import { clock, minutesSince } from "@/format";
import { Answer, Outcome } from "@/JobNotes";
import { PrBody, PrDiff, usePrDetails } from "@/PrReview";
import { PrLine, TrainLine } from "@/PullRequest";
import { About, AssumeAnswer, StateIcon, Task, TaskHeader, taskState } from "@/TaskDetails";
import { TierBadge } from "@/TierBadge";

/**
 * A job's pop-up: what needs you and how it ended first, then the prompt, the log, and the PR's
 * description and diff, each with the dialog's full width. Number keys switch tabs.
 */
export function JobDetails({
  item,
  job,
  blueprint,
  snapshot,
  act,
  actions,
}: {
  item: Item;
  job: Job;
  blueprint?: string;
  snapshot: Snapshot;
  act: Act;
  actions?: ReactNode;
}) {
  const state = taskState(job, snapshot.prs);
  const url = prUrl(job);
  const pr = url ? snapshot.prs[url] : undefined;
  const entries = jobEntries(job);
  const asked = job.state === "blocked";
  const tabs = ["summary", "prompt", "log", ...(pr ? ["description", "diff"] : [])];
  // A running job has nothing to sum up yet, so it opens on what it's doing.
  const [tab, setTab] = useState(job.state === "running" ? "log" : "summary");
  const details = usePrDetails(job.id, tab === "description" || tab === "diff");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey || target.closest("input, textarea"))
        return;
      const chosen = tabs[Number(event.key) - 1];
      if (chosen) setTab(chosen);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <>
      <TaskHeader item={item} state={state}>
        {pr && (
          <Button variant="outline" size="xs" className="ml-auto" onClick={() => setTab("diff")}>
            #{url!.split("/").at(-1)}
            <span className="text-success">+{pr.additions}</span>
            <span className="text-destructive">−{pr.deletions}</span>
          </Button>
        )}
      </TaskHeader>
      <Tabs className="min-h-0 flex-1" value={tab} onValueChange={setTab}>
        <div className="flex items-center gap-3 border-b">
          <TabsList variant="line">
            <TabsTrigger value="summary">
              Summary
              {asked && (
                <span
                  aria-label="waiting for your answer"
                  className="size-1.5 rounded-full bg-warning"
                />
              )}
            </TabsTrigger>
            <TabsTrigger value="prompt">Prompt</TabsTrigger>
            <TabsTrigger value="log">
              Log <Count>{entries.length}</Count>
            </TabsTrigger>
            {pr && <TabsTrigger value="description">Description</TabsTrigger>}
            {pr && (
              <TabsTrigger value="diff">
                Diff <Count>{pr.files.length}</Count>
              </TabsTrigger>
            )}
          </TabsList>
          <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">
            <Kbd>1</Kbd>–<Kbd>{tabs.length}</Kbd> to switch
          </span>
        </div>
        <ScrollingTabsContent value="summary">
          <Summary job={job} snapshot={snapshot} act={act} />
          <About item={item} blueprint={blueprint} />
        </ScrollingTabsContent>
        <ScrollingTabsContent value="prompt">
          <Task item={item} jobId={job.id} />
        </ScrollingTabsContent>
        <ScrollingTabsContent value="log">
          <Log entries={entries} />
        </ScrollingTabsContent>
        <ScrollingTabsContent value="description">
          <PrBody details={details} />
        </ScrollingTabsContent>
        {/* The diff scrolls inside, beside its file list. */}
        <ScrollingTabsContent value="diff" className="overflow-hidden">
          <PrDiff details={details} />
        </ScrollingTabsContent>
      </Tabs>
      {actions && <DialogFooter>{actions}</DialogFooter>}
    </>
  );
}

function Count({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
      {children}
    </span>
  );
}

/** What needs attention now, if anything, then how the job ended and its PR. */
function Summary({ job, snapshot, act }: { job: Job; snapshot: Snapshot; act: Act }) {
  const { status, prs, train } = snapshot;
  const last = job.attempts.at(-1);
  const queued = new Set(
    snapshot.jobs
      .filter((each) => each.state !== "removed" && each.item.blueprint === "followup")
      .map((each) => each.item.title),
  );
  const worker = status?.workers.find((each) => each.job === job.id);
  const step = job.notes.findLast(
    (note) => note.kind === "step" && note.attempt === job.attempts.length + 1,
  );
  const question =
    job.state === "blocked" ? job.notes.findLast((note) => note.kind === "ask") : undefined;
  const url = prUrl(job);

  return (
    <div className="flex max-w-3xl flex-col gap-3 pb-3">
      {question && <Answer job={job} question={question} act={act} />}
      {worker && status && (
        <Now className="border-primary/40">
          <span className="flex items-center gap-2 font-medium">
            <StateIcon state="running" />
            {worker.id} working, {minutesSince(worker.since)} min
          </span>
          {step && (
            <span>
              {step.text}
              {step.of ? ` (${step.done ?? 0}/${step.of})` : ""}
            </span>
          )}
          <span className="text-muted-foreground">
            {[worker.activity, worker.context && `${Math.round(worker.context / 1000)}k context`]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </Now>
      )}
      <Facts job={job} act={act} />
      {last?.error && (
        <Now className="border-destructive/40 text-destructive">{last.error.split("\n")[0]}</Now>
      )}
      <Outcome job={job} act={act} queued={queued} />
      {url && (
        <Now className={prs[url]?.state === "MERGED" ? "border-success/40" : ""}>
          <PrLine url={url} pr={prs[url]} />
          <TrainLine car={train[job.id]} />
        </Now>
      )}
    </div>
  );
}

/** Everything that happened, newest first, by day. */
function Log({ entries }: { entries: ReturnType<typeof jobEntries> }) {
  const days = new Map<string, typeof entries>();
  for (const entry of entries.toSorted((a, b) => b.at.localeCompare(a.at))) {
    const day = dayOf(entry.at);
    days.set(day, [...(days.get(day) ?? []), entry]);
  }
  return (
    <div className="flex max-w-3xl flex-col gap-3 pt-1 text-sm">
      {[...days].map(([day, dayEntries]) => (
        <section key={day} className="flex flex-col gap-1.5">
          <h4 className="text-xs text-muted-foreground">{day}</h4>
          <ol className="flex flex-col">
            {dayEntries.map((entry) => (
              <li
                key={`${entry.at} ${entry.text}`}
                className="group grid grid-cols-[4.5rem_1rem_1fr] gap-x-2"
              >
                <time
                  dateTime={entry.at}
                  className="text-right whitespace-nowrap text-muted-foreground tabular-nums"
                >
                  {clock(entry.at)}
                </time>
                {/* The rail runs from under each mark to the next one, and stops at the day's last. */}
                <span className="relative flex justify-center pt-0.5 before:absolute before:top-5.5 before:bottom-0.5 before:w-px before:bg-border group-last:before:hidden">
                  <EntryMark entry={entry} />
                </span>
                <span className={`pb-3 wrap-anywhere ${entry.tone ?? ""}`}>
                  {entry.step && <StepNumber step={entry.step} />}
                  {entry.text}{" "}
                  {entry.ended && (
                    <AttemptFile log={entry.ended.log} agent={entry.ended.agent} kind="log" />
                  )}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

/** What the job is held to and what's left for the user to check, for jobs that have any. */
function Facts({ job, act }: { job: Job; act: Act }) {
  const assumed = openAssumptions(job);
  const facts = [
    job.escalations && `moved up a tier ${job.escalations}×`,
    job.gates.length > 0 && `gates ${job.gates.map((gate) => `\`${gate}\``).join(", ")}`,
    job.touches && `touches ${job.touches.length ? job.touches.join(", ") : "anything"}`,
    job.needs.length > 0 && `needs ${job.needs.join(", ")}`,
  ].filter(Boolean);
  if (!job.tier && facts.length === 0 && job.unverified.length === 0 && assumed.length === 0)
    return null;
  return (
    <div className="flex flex-col gap-2 text-sm">
      {(job.tier || facts.length > 0) && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {job.tier && <TierBadge tier={job.tier} />}
          {facts.join(" · ")}
        </p>
      )}
      {job.unverified.map((need) => (
        <Now key={need} className="border-warning/40">
          <span className="flex flex-wrap items-center gap-2">
            <span className="flex-1">Not verified: {need}</span>
            <Button size="sm" variant="outline" onClick={() => act(() => api.verify(job.id, need))}>
              Checked
            </Button>
          </span>
        </Now>
      ))}
      {assumed.map((note) => (
        <Now key={note.at} className="border-warning/40">
          <span>
            Assumed <strong>{note.assumed}</strong>, asked: {note.text}
          </span>
          <span className="flex gap-2">
            <Button size="sm" onClick={() => act(() => api.answer(job.id, "fine", note.index))}>
              Fine
            </Button>
            <span className="text-xs text-muted-foreground">or answer below to queue a change</span>
          </span>
          <AssumeAnswer job={job} index={note.index} act={act} />
        </Now>
      ))}
    </div>
  );
}

function Now({ className, children }: { className: string; children: ReactNode }) {
  return (
    <div className={`flex flex-col gap-2 rounded-md border bg-popover p-2 text-sm ${className}`}>
      {children}
    </div>
  );
}

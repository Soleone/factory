import { ChevronDownIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type Act } from "@/api";
import { dayOf } from "@/ActivityView";
import type { Job, Snapshot } from "@/backend/types.ts";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { NeutralCheckbox } from "@/components/variants/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ItemGroup } from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { itemTitle, repoName } from "@/format";
import { canBoard, MergeButton, mergeTrain } from "@/PullRequest";
import { canDismiss, hasBranch, Result, reviewerOf } from "@/Result";
import { taskState, type TaskState } from "@/TaskDetails";

/** What waits on the user is in the Inbox; here everything is history, running or finished. */
function sectionOf(state: TaskState) {
  return state === "queued" || state === "running" || state === "blocked" ? "running" : "finished";
}

const SEEN = "factory.results.seen";

/** When the user last looked at the results, in this browser; empty the first time. */
function useLastSeen(): string {
  const [seen] = useState(() => {
    try {
      return localStorage.getItem(SEEN) ?? "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    const save = () => {
      try {
        localStorage.setItem(SEEN, new Date().toISOString());
      } catch {
        // Private windows may refuse storage; every result then just looks seen.
      }
    };
    save();
    return save;
  }, []);
  return seen;
}

function dayLabel(iso: string) {
  const day = new Date(iso).toDateString();
  if (day === new Date().toDateString()) return "Today";
  if (day === new Date(Date.now() - 86_400_000).toDateString()) return "Yesterday";
  return dayOf(iso);
}

const lastEnd = (job: Job) => job.attempts.at(-1)!.end;

/** Running results, then finished ones, each by day. */
export function ResultsView({
  snapshot,
  act,
  onAsk,
}: {
  snapshot: Snapshot;
  act: Act;
  onAsk: (question: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [dismissing, setDismissing] = useState(false);
  const seen = useLastSeen();
  const [project, setProject] = useState<string | null>(null);
  const { prs, train } = snapshot;
  const results = snapshot.jobs
    .filter((job) => job.state !== "removed" && job.attempts.length > 0)
    .sort((a, b) => b.attempts.at(-1)!.start.localeCompare(a.attempts.at(-1)!.start));
  const repos = [...new Set(results.map((job) => job.item.repo))].sort((a, b) =>
    repoName(a).localeCompare(repoName(b)),
  );
  // A project whose results were all dismissed falls back to showing everything.
  const shownRepo = project && repos.includes(project) ? project : null;
  const jobs = shownRepo ? results.filter((job) => job.item.repo === shownRepo) : results;
  const [finishedOpen, setFinishedOpen] = useState(true);
  if (jobs.length === 0)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Nothing done yet</EmptyTitle>
          <EmptyDescription>
            What the agents did shows up here, with their PRs to review and merge.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  const sections = { running: [] as Job[], finished: [] as Job[] };
  for (const job of jobs) sections[sectionOf(taskState(job, prs))].push(job);
  const selection = jobs.filter((job) => canDismiss(job) && selected.has(job.id));
  const boarding = selection.filter((job) => canBoard(job, prs, train));

  const select = (ids: string[], checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const dismissSelected = async () => {
    if (
      selection.some(hasBranch) &&
      !window.confirm("Dismiss selected results and delete their unpushed branches?")
    )
      return;

    setDismissing(true);
    try {
      await act(async () => {
        const outcomes = await Promise.allSettled(selection.map((job) => api.remove(job.id)));
        const failure = outcomes.find((outcome) => outcome.status === "rejected");
        if (failure) throw failure.reason;
      });
      setSelected(new Set());
    } finally {
      setDismissing(false);
    }
  };

  const merge = (merging: Job[]) => {
    if (mergeTrain(merging, act)) setSelected(new Set());
  };

  const list = (shown: Job[]) => {
    const days = new Map<string, Job[]>();
    for (const job of shown) {
      const day = dayLabel(lastEnd(job));
      days.set(day, [...(days.get(day) ?? []), job]);
    }
    return [...days].map(([day, dayJobs]) => (
      <div key={day} className="flex flex-col gap-2">
        <h3 className="px-3 text-xs text-muted-foreground">{day}</h3>
        <ItemGroup>
          {dayJobs.map((job) => (
            <Result
              key={job.id}
              job={job}
              snapshot={snapshot}
              act={act}
              car={train[job.id]}
              onAsk={onAsk}
              asked={snapshot.settings.chat.agent}
              unread={seen !== "" && lastEnd(job) > seen}
              reviewer={reviewerOf(job, snapshot)}
              disabled={dismissing && selected.has(job.id)}
              leading={
                canDismiss(job) && (
                  <NeutralCheckbox
                    aria-label={`Select ${itemTitle(job.item)}`}
                    checked={selected.has(job.id)}
                    disabled={dismissing}
                    onCheckedChange={(checked) => select([job.id], checked)}
                  />
                )
              }
            />
          ))}
        </ItemGroup>
      </div>
    ));
  };

  /** A section's title with a checkbox that selects all of its dismissible results. */
  const heading = (title: string, shown: Job[]) => {
    const ids = shown.filter(canDismiss).map((job) => job.id);
    const all = ids.length > 0 && ids.every((id) => selected.has(id));
    return (
      <span className="flex items-center gap-3">
        {ids.length > 0 && (
          <NeutralCheckbox
            aria-label={all ? `Clear ${title}` : `Select all in ${title}`}
            checked={all}
            disabled={dismissing}
            onCheckedChange={(checked) => select(ids, checked)}
          />
        )}
        <h2 className="text-sm font-medium">
          {title} <span className="font-normal text-muted-foreground">{shown.length}</span>
        </h2>
      </span>
    );
  };

  const projects = [
    { value: null, label: "All projects" },
    ...repos.map((repo) => ({ value: repo, label: repoName(repo) })),
  ];

  return (
    <div className="flex flex-col gap-6 pt-2">
      {repos.length > 1 && (
        <div className="px-3">
          <Select items={projects} value={shownRepo} onValueChange={setProject}>
            <SelectTrigger aria-label="Project" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {projects.map(({ value, label }) => (
                <SelectItem key={label} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {selection.length > 0 && (
        <div
          role="group"
          aria-label="Batch actions"
          className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-background px-3 py-2"
        >
          <span className="text-sm font-medium">{selection.length} selected</span>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
          <div className="flex items-center gap-2 sm:ml-auto">
            <Button variant="outline" size="sm" disabled={dismissing} onClick={dismissSelected}>
              {dismissing ? "Dismissing…" : "Dismiss"}
            </Button>
            {boarding.length > 0 && (
              <MergeButton disabled={dismissing} onClick={() => merge(boarding)}>
                Merge {boarding.length < selection.length && `(${boarding.length})`}
              </MergeButton>
            )}
          </div>
        </div>
      )}
      {sections.running.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="flex min-h-8 items-center px-3">
            {heading("In progress", sections.running)}
          </div>
          {list(sections.running)}
        </section>
      )}
      {sections.finished.length > 0 && (
        <Collapsible open={finishedOpen} onOpenChange={setFinishedOpen}>
          <section className="flex flex-col gap-3">
            <div className="flex min-h-8 items-center gap-2 px-3">
              {heading("Finished", sections.finished)}
              <CollapsibleTrigger
                render={<Button variant="ghost" size="icon-sm" />}
                aria-label={finishedOpen ? "Hide finished" : "Show finished"}
              >
                <ChevronDownIcon
                  aria-hidden="true"
                  className={`transition-transform ${finishedOpen ? "" : "-rotate-90"}`}
                />
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent>
              <div className="flex flex-col gap-3">{list(sections.finished)}</div>
            </CollapsibleContent>
          </section>
        </Collapsible>
      )}
    </div>
  );
}

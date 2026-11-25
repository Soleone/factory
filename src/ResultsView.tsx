import { ChevronDownIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { confirm } from "@/Confirm";
import { api, type Act } from "@/api";
import { dayOf } from "@/ActivityView";
import { RESULTS_BATCH_SIZE, type Job, type ResultsPage, type Snapshot } from "@/backend/types.ts";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { NeutralCheckbox } from "@/components/variants/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { RowGroup } from "@/components/variants/item";
import { ProjectsFilter } from "@/ProjectsFilter";
import { itemTitle } from "@/format";
import { canBoard, MergeButton, mergeTrain } from "@/PullRequest";
import { canDismiss, dismissLoses, Result, reviewerOf, usePeek } from "@/Result";
import { Spinner } from "@/components/ui/spinner";

/** Keep the previous window while appending; never apply a response from an old filter. */
function useResults(project: string | null, limit: number, refresh: number) {
  const [loaded, setLoaded] = useState<{
    project: string | null;
    limit: number;
    page: ResultsPage;
  }>();
  const [failure, setFailure] = useState<{ project: string | null; text: string }>();
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const page = await api.results(project, limit, controller.signal);
        if (!controller.signal.aborted) {
          setLoaded({ project, limit, page });
          setFailure(undefined);
        }
      } catch (error) {
        if (!controller.signal.aborted) setFailure({ project, text: (error as Error).message });
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [project, limit, refresh]);

  const current = loaded?.project === project ? loaded : undefined;
  return {
    page: current?.page,
    resultProjects: loaded?.page.repos ?? [],
    appending: current?.limit !== limit,
    error: failure?.project === project ? failure.text : undefined,
  };
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

function byDay(jobs: readonly Job[]) {
  const days = new Map<string, Job[]>();
  for (const job of jobs) {
    const day = dayLabel(lastEnd(job));
    const dayJobs = days.get(day);
    if (dayJobs) dayJobs.push(job);
    else days.set(day, [job]);
  }
  return [...days];
}

/** Running results, then finished ones, each by day. */
export function ResultsView({
  snapshot: live,
  act: change,
  onAsk,
  projects,
  project,
  onProjectChange,
}: {
  snapshot: Snapshot;
  act: Act;
  onAsk: (question: string) => void;
  projects: readonly string[];
  project: string | null;
  onProjectChange: (project: string | null) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [dismissing, setDismissing] = useState(false);
  const seen = useLastSeen();
  const peek = usePeek();
  const [finishedOpen, setFinishedOpen] = useState(true);
  const [limit, setLimit] = useState(RESULTS_BATCH_SIZE);
  const [refresh, setRefresh] = useState(0);
  const [previousProject, setPreviousProject] = useState(project);
  if (previousProject !== project) {
    setPreviousProject(project);
    setLimit(RESULTS_BATCH_SIZE);
    setSelected(new Set());
  }
  const { page, resultProjects, appending, error } = useResults(project, limit, refresh);
  const more = useRef<HTMLButtonElement>(null);
  const hasMore = page !== undefined && page.finished.length < page.total;
  const act: Act = async (action) => {
    await change(action);
    setRefresh((current) => current + 1);
  };

  useEffect(() => {
    if (
      !finishedOpen ||
      !hasMore ||
      appending ||
      error ||
      !more.current ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          setLimit(limit + RESULTS_BATCH_SIZE);
        }
      },
      { rootMargin: "0px 0px 240px 0px" },
    );
    observer.observe(more.current);
    return () => observer.disconnect();
  }, [finishedOpen, hasMore, appending, error, limit, page?.repo]);

  const problem = error && (
    <p role="alert" className="text-sm text-destructive">
      Can't load results: {error}
    </p>
  );
  const filter = (
    <div className="px-3">
      <ProjectsFilter
        projects={[...projects, ...resultProjects]}
        project={project}
        onProjectChange={onProjectChange}
      />
    </div>
  );
  if (!page)
    return (
      <div className="flex flex-col gap-6 pt-2">
        {filter}
        <div className="flex gap-2 p-3" role="status">
          {problem || (
            <>
              <Spinner /> Loading results…
            </>
          )}
        </div>
      </div>
    );

  const { running, finished, total, prs, train, reviewed, queuedFollowups } = page;
  const snapshot = { ...live, prs, train, reviewed, queuedFollowups };
  if (running.length === 0 && total === 0)
    return (
      <div className="flex flex-col gap-6 pt-2">
        {filter}
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {project === null ? "Nothing done yet" : "No results for this project"}
            </EmptyTitle>
            <EmptyDescription>
              What the agents did shows up here, with their PRs to review and merge.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );

  const selection = [...running, ...finished].filter(
    (job) => canDismiss(job) && selected.has(job.id),
  );
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
      selection.some(dismissLoses) &&
      !(await confirm({
        title: "Dismiss selected results?",
        description: "This deletes their unpushed branches and images too.",
        action: "Dismiss",
        destructive: true,
      }))
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

  const merge = async (merging: Job[]) => {
    if (await mergeTrain(merging, act)) setSelected(new Set());
  };

  const list = (shown: readonly Job[]) =>
    byDay(shown).map(([day, dayJobs]) => (
      <div key={day} className="flex flex-col gap-2">
        <h3 className="px-3 text-xs text-muted-foreground">{day}</h3>
        <RowGroup>
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
              {...peek(job.id)}
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
        </RowGroup>
      </div>
    ));

  /** A section's title with a checkbox that selects its loaded dismissible results. */
  const heading = (title: string, shown: Job[], count = shown.length) => {
    const ids = shown.filter(canDismiss).map((job) => job.id);
    const all = ids.length > 0 && ids.every((id) => selected.has(id));
    return (
      <span className="flex items-center gap-3">
        {ids.length > 0 && (
          <NeutralCheckbox
            aria-label={
              all
                ? `Clear ${title}`
                : `Select ${shown.length < count ? "shown" : "all"} in ${title}`
            }
            checked={all}
            disabled={dismissing}
            onCheckedChange={(checked) => select(ids, checked)}
          />
        )}
        <h2 className="text-sm font-medium">
          {title} <span className="font-normal text-muted-foreground">{count}</span>
        </h2>
      </span>
    );
  };

  return (
    <div className="flex flex-col gap-6 pt-2">
      {filter}
      {problem}
      {/* Keep both groups the same width so only resizing, not selection, can rewrap them. */}
      <div
        role="group"
        aria-label="Batch actions"
        className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2"
      >
        <div className="flex items-center gap-2">
          <span className="w-24 whitespace-nowrap text-sm font-medium tabular-nums">
            {selection.length} selected
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={selection.length === 0}
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="w-24"
            disabled={selection.length === 0 || dismissing}
            onClick={dismissSelected}
          >
            {dismissing ? "Dismissing…" : "Dismiss"}
          </Button>
          <MergeButton
            className="w-28 [&>button]:w-full"
            disabled={boarding.length === 0 || dismissing}
            onClick={() => merge(boarding)}
          >
            Merge{" "}
            {boarding.length > 0 && boarding.length < selection.length && `(${boarding.length})`}
          </MergeButton>
        </div>
      </div>
      {running.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="flex min-h-8 items-center px-3">{heading("In progress", running)}</div>
          {list(running)}
        </section>
      )}
      {total > 0 && (
        <Collapsible open={finishedOpen} onOpenChange={setFinishedOpen}>
          <section className="flex flex-col gap-3">
            <div className="flex min-h-8 items-center gap-2 px-3">
              {heading("Finished", finished, total)}
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
              <div className="flex flex-col gap-3">
                {list(finished)}
                {hasMore && (
                  <Button
                    ref={more}
                    variant="outline"
                    size="sm"
                    className="self-center"
                    aria-disabled={appending && !error}
                    onClick={() => {
                      if (error) setRefresh((current) => current + 1);
                      else if (!appending) setLimit(limit + RESULTS_BATCH_SIZE);
                    }}
                  >
                    {appending && !error ? "Loading results…" : "Load more results"}
                  </Button>
                )}
              </div>
            </CollapsibleContent>
          </section>
        </Collapsible>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { api, type Act } from "@/api";
import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import {
  scannedAt,
  type Candidates,
  type Item,
  type Job,
  type Pin,
  type Settings,
  type Snapshot,
} from "@/backend/types.ts";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/soleone/tooltip/tooltip";
import { ProjectsFilter } from "@/ProjectsFilter";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ago, itemTitle, repoName } from "@/format";
import { PinMenuItems } from "@/PinMenu";
import { Row, Section } from "@/Row";
import { NeutralCheckbox } from "@/components/variants/checkbox";
import { RowGroup } from "@/components/variants/item";
import { StateIcon, StatePill, TaskDetails, taskState, type TaskState } from "@/TaskDetails";

const ALL = "";
const PAGE = 100;
const key = (item: { repo: string; id: string }) => `${item.repo} ${item.id}`;
/** Under way or waiting on its PR: queueing it again would do the same work twice. */
const UNDER_WAY: TaskState[] = ["queued", "running", "blocked", "review"];
/** Finished without a failure: workwork no longer lists it, unless it was asked before the job ended. */
const HANDLED: TaskState[] = ["merged", "done", "unchanged"];

/** Everything workwork found, by blueprint, to pick from. */
export function CandidatesView({
  snapshot,
  act,
  projects,
  project,
  onProjectChange,
}: {
  snapshot: Snapshot;
  act: Act;
  projects: readonly string[];
  project: string | null;
  onProjectChange: (project: string | null) => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [scans, setScans] = useState<Pick<Candidates, "at" | "repoAt">>({ at: "", repoAt: {} });
  const [blueprint, setBlueprint] = useState(ALL);
  const [attention, setAttention] = useState(["none", "skim", "decide"]);
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(PAGE);
  /** Kept across filters, so one batch can take candidates from several blueprints. */
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  /** What each blueprint does, by name; empty until workwork answers. */
  const [described, setDescribed] = useState(new Map<string, string>());
  const { at } = snapshot.candidates;
  const refreshing =
    snapshot.candidates.refreshing.all ||
    (project !== null && snapshot.candidates.refreshing.repos.includes(project));
  const refresh = () => act(() => api.refreshCandidates(project ?? undefined));

  useEffect(() => {
    let ignore = false;
    void api.candidates().then(({ items, at, repoAt }) => {
      if (ignore) return;
      setItems(items);
      setScans({ at: at ?? "", repoAt });
    });
    return () => {
      ignore = true;
    };
  }, [at]);

  useEffect(() => {
    void api
      .blueprints()
      .then((blueprints) =>
        setDescribed(new Map(blueprints.map((each) => [each.name, each.description]))),
      );
  }, [at]);

  // The latest job per candidate, so the list says what already happened to it.
  const jobs = useMemo(() => {
    const byItem = new Map<string, Job>();
    for (const job of snapshot.jobs) if (job.state !== "removed") byItem.set(key(job.item), job);
    return byItem;
  }, [snapshot.jobs]);

  // A job that ended after workwork last looked at its repo leaves a stale candidate; one that
  // ended before means workwork offers it again, like a sweep of code that changed since.
  const stale = (item: Item) => {
    const job = jobs.get(key(item));
    const scanned = scannedAt(scans, item.repo);
    const ended = job?.attempts.at(-1)?.end;
    return (
      !!job &&
      HANDLED.includes(taskState(job, snapshot.prs)) &&
      !!ended &&
      (!scanned || ended > scanned)
    );
  };
  /** The job a candidate is already in, if it's still under way. */
  const pending = (item: Item) => {
    const job = jobs.get(key(item));
    return job && UNDER_WAY.includes(taskState(job, snapshot.prs)) ? job : undefined;
  };

  const inProject = project === null ? items : items.filter((item) => item.repo === project);
  const inRepo = inProject.filter((item) => !stale(item));
  const handled = inProject.length - inRepo.length;
  const lastScan = project === null ? scans.at : scannedAt(scans, project);
  const blueprintCounts = new Map<string, number>();
  for (const item of inRepo)
    blueprintCounts.set(item.blueprint, (blueprintCounts.get(item.blueprint) ?? 0) + 1);
  const blueprints = [...blueprintCounts].sort((a, b) => a[1] - b[1]);

  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = inRepo.filter(
    (item) =>
      (blueprint === ALL || item.blueprint === blueprint) &&
      attention.includes(item.attention) &&
      words.every((word) =>
        `${itemTitle(item)} ${item.id} ${item.label}`.toLowerCase().includes(word),
      ),
  );
  const queue = (wanted: Item[], pin?: Pin) => act(() => api.queue(wanted, pin));
  const open = matches.filter((item) => !pending(item));
  const selection = items.filter(
    (item) => selected.has(key(item)) && !pending(item) && !stale(item),
  );
  const allOpenSelected = open.length > 0 && open.every((item) => selected.has(key(item)));

  const select = (wanted: Item[], checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const item of wanted) {
        if (checked) next.add(key(item));
        else next.delete(key(item));
      }
      return next;
    });
  };

  const empty = (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{refreshing ? "Asking workwork" : "No candidates yet"}</EmptyTitle>
        <EmptyDescription>
          {project === null
            ? refreshing
              ? "workwork is looking through every repo under $SRC. That takes a few minutes."
              : "Ask workwork for candidates across your repos. It takes a few minutes."
            : refreshing
              ? `workwork is looking through ${repoName(project)}. That takes under a minute.`
              : `There are no candidates for ${repoName(project)}${handled ? ` left: ${handled} handled since workwork last looked` : ""}.`}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" disabled={refreshing} onClick={refresh}>
          {refreshing && <Spinner />} Ask workwork
        </Button>
      </EmptyContent>
    </Empty>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Tasks that blueprints found in your repos. What you queue here runs before auto mode.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-xs"
          placeholder="Search titles, ids, repos"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <ToggleGroup multiple variant="outline" value={attention} onValueChange={setAttention}>
          {["none", "skim", "decide"].map((value) => (
            <ToggleGroupItem key={value} value={value}>
              {value}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <ProjectsFilter
          projects={projects}
          project={project}
          onProjectChange={(next) => {
            onProjectChange(next);
            setShown(PAGE);
            if (
              !items.some(
                (item) => item.blueprint === blueprint && (next === null || item.repo === next),
              )
            )
              setBlueprint(ALL);
          }}
        />
        <span className="flex flex-1 items-center justify-end gap-2 text-sm text-muted-foreground">
          {refreshing
            ? "Asking workwork…"
            : `${inRepo.length} candidates${lastScan ? `, ${ago(lastScan)}` : ""}`}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Refresh candidates"
                  disabled={refreshing}
                  onClick={() => void refresh()}
                />
              }
            >
              <RefreshCwIcon
                className={refreshing ? "animate-spin motion-reduce:animate-none" : undefined}
              />
            </TooltipTrigger>
            <TooltipContent>
              {project === null
                ? refreshing
                  ? "Asking workwork about every repo, takes a few minutes"
                  : "Ask workwork about every repo again, takes a few minutes"
                : refreshing
                  ? `Asking workwork about ${repoName(project)}`
                  : `Ask workwork about ${repoName(project)} again, under a minute`}
            </TooltipContent>
          </Tooltip>
        </span>
      </div>

      {selection.length > 0 && (
        <div
          role="group"
          aria-label="Batch actions"
          className="flex flex-wrap items-center gap-2 rounded-lg border bg-background px-3 py-2"
        >
          <span className="text-sm font-medium">{selection.length} selected</span>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
          <span className="sm:ml-auto">
            <QueueButton
              label={`Queue ${selection.length}`}
              settings={snapshot.settings}
              onQueue={async (pin) => {
                await queue(selection, pin);
                setSelected(new Set());
              }}
            />
          </span>
        </div>
      )}

      {inRepo.length === 0 ? (
        empty
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-6 md:flex-row">
          <nav className="flex flex-wrap gap-1 md:w-48 md:flex-none md:flex-col">
            {[[ALL, inRepo.length] as const, ...blueprints].map(([name, total]) => (
              <Tooltip key={name} disabled={!described.has(name)}>
                <TooltipTrigger
                  render={
                    <Button
                      variant={blueprint === name ? "secondary" : "ghost"}
                      size="sm"
                      onClick={() => {
                        setBlueprint(name);
                        setShown(PAGE);
                      }}
                    />
                  }
                >
                  <span className="flex-1 text-left">{name || "All blueprints"}</span>
                  <span className="text-muted-foreground">{total}</span>
                </TooltipTrigger>
                <TooltipContent side="right">{described.get(name)}</TooltipContent>
              </Tooltip>
            ))}
          </nav>

          {/* The one part that scrolls, so the filters and blueprints stay in view. */}
          <div className="-m-1 min-w-0 flex-1 overflow-y-auto p-1 [scrollbar-gutter:stable]">
            <Section
              title={
                <span className="flex min-h-8 items-center gap-3 px-3">
                  {open.length > 0 && (
                    <NeutralCheckbox
                      aria-label={
                        allOpenSelected
                          ? `Clear all ${open.length} not queued`
                          : `Select all ${open.length} not queued`
                      }
                      checked={allOpenSelected}
                      onCheckedChange={(checked) => select(open, checked)}
                    />
                  )}
                  <span>
                    {matches.length} matching, {open.length} not queued yet
                    {handled > 0 && `, ${handled} handled since workwork last looked`}
                  </span>
                </span>
              }
            >
              <RowGroup>
                {matches.slice(0, shown).map((item) => {
                  const job = pending(item);
                  const last = job ? undefined : jobs.get(key(item));
                  const queueButton = (
                    <QueueButton
                      label="Queue"
                      settings={snapshot.settings}
                      onQueue={(pin) => queue([item], pin)}
                    />
                  );
                  return (
                    <Row
                      key={key(item)}
                      leading={
                        job ? (
                          <StateIcon state={taskState(job, snapshot.prs)} />
                        ) : (
                          <NeutralCheckbox
                            aria-label={`Select ${itemTitle(item)}`}
                            checked={selected.has(key(item))}
                            onCheckedChange={(checked) => select([item], checked)}
                          />
                        )
                      }
                      title={
                        <TaskDetails
                          item={item}
                          job={job}
                          blueprint={described.get(item.blueprint)}
                          snapshot={snapshot}
                          act={act}
                          actions={!job && queueButton}
                        />
                      }
                      meta={
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <StatePill state={taskState(job, snapshot.prs)} />
                          {[
                            item.blueprint,
                            item.attention,
                            item.id,
                            last && `last run ${taskState(last, snapshot.prs)}`,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      }
                    >
                      {!job && queueButton}
                    </Row>
                  );
                })}
              </RowGroup>
              {matches.length > shown && (
                <Button variant="ghost" onClick={() => setShown(shown + PAGE)}>
                  Show {Math.min(PAGE, matches.length - shown)} more
                </Button>
              )}
            </Section>
          </div>
        </div>
      )}
    </div>
  );
}

/** Queues for the first free worker, or, from the arrow's menu, for a role or one worker. */
function QueueButton({
  label,
  settings,
  onQueue,
}: {
  label: string;
  settings: Settings;
  onQueue: (pin?: Pin) => void;
}) {
  return (
    <ButtonGroup>
      <Button variant="outline" size="sm" onClick={() => onQueue()}>
        {label}
      </Button>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={<Button variant="outline" size="icon-sm" aria-label={`${label} with`} />}
              />
            }
          >
            <ChevronDownIcon />
          </TooltipTrigger>
          <TooltipContent>{label} for a role or a specific worker</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-auto">
          <PinMenuItems settings={settings} onPin={onQueue} />
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}

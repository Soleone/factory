import { useEffect, useMemo, useState } from "react";
import { api, type Act } from "@/api";
import { ChevronDownIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import {
  scannedAt,
  type Blueprint,
  type Candidates,
  type Item,
  type Job,
  type Pin,
  type Scan,
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
import { confirm } from "@/Confirm";
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
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

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
  const [scans, setScans] = useState<Pick<Candidates, "at" | "scans">>({ at: "", scans: {} });
  const [blueprint, setBlueprint] = useState(ALL);
  const [attention, setAttention] = useState(["none", "skim", "decide"]);
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(PAGE);
  /** Kept across filters, so one batch can take candidates from several blueprints. */
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  /** Every blueprint workwork knows; empty until it answers. */
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const { at } = snapshot.candidates;

  useEffect(() => {
    let ignore = false;
    void api.candidates().then(({ items, at, scans }) => {
      if (ignore) return;
      setItems(items);
      setScans({ at: at ?? "", scans });
    });
    return () => {
      ignore = true;
    };
  }, [at]);

  useEffect(() => {
    void api.blueprints().then(setBlueprints);
  }, [at]);

  // The latest job per candidate, so the list says what already happened to it.
  const jobs = useMemo(() => {
    const byItem = new Map<string, Job>();
    for (const job of snapshot.jobs) if (job.state !== "removed") byItem.set(key(job.item), job);
    return byItem;
  }, [snapshot.jobs]);

  const described = new Map(blueprints.map((each) => [each.name, each]));
  // Scans that cover what's on screen: in this project or every repo, for one blueprint or all.
  const inScope = (scan: Scan) => !scan.repo || scan.repo === project;
  const running = snapshot.candidates.refreshing.filter(inScope);
  const refreshing = running.some((scan) => !scan.blueprint);
  const sweep = running.find((scan) => scan.total !== undefined);
  const scanning = (name: string) =>
    running.some((scan) =>
      scan.blueprint ? scan.blueprint === name : !described.get(name)?.onRequest,
    );
  const scope = project === null ? {} : { repo: project };
  const refresh = () => act(() => api.refreshCandidates(scope));
  const scan = (name: string) => act(() => api.refreshCandidates({ ...scope, blueprint: name }));

  // A job that ended after workwork last looked leaves a stale candidate; one that ended before
  // means workwork offers it again, like a sweep of code that changed since.
  const stale = (item: Item) => {
    const job = jobs.get(key(item));
    const ended = job?.attempts.at(-1)?.end;
    return (
      !!job &&
      !!ended &&
      HANDLED.includes(taskState(job, snapshot.prs)) &&
      ended > scannedAt(scans, item.repo, item.blueprint)
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
  const counts = new Map<string, number>();
  for (const item of inRepo) counts.set(item.blueprint, (counts.get(item.blueprint) ?? 0) + 1);

  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = inRepo.filter(
    (item) =>
      (blueprint === ALL || item.blueprint === blueprint) &&
      attention.includes(item.attention) &&
      words.every((word) =>
        `${itemTitle(item)} ${item.id} ${item.label}`.toLowerCase().includes(word),
      ),
  );
  const open = matches.filter((item) => !pending(item));
  const selection = items.filter(
    (item) => selected.has(key(item)) && !pending(item) && !stale(item),
  );

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
  const queue = (wanted: Item[], pin?: Pin) => act(() => api.queue(wanted, pin));
  const decide = async (verdict: "reject" | "defer") => {
    if (
      verdict === "reject" &&
      !(await confirm({
        title: `Dismiss ${plural(selection.length, "candidate")}?`,
        description:
          "workwork records the rejection in each repo and won't offer them again, even after their code changes.",
        action: "Dismiss",
        destructive: true,
      }))
    )
      return;
    await act(() => api.decideCandidates(selection, verdict));
    setSelected(new Set());
  };

  // Several candidates of one blueprint in one repo, like clarify's batches, fold into one row.
  const grouped = new Map<string, Item[]>();
  for (const item of matches) {
    const group = blueprint === ALL ? `${item.repo} ${item.blueprint}` : key(item);
    grouped.set(group, [...(grouped.get(group) ?? []), item]);
  }
  const groups = [...grouped.values()];

  const status = sweep
    ? `Asking workwork… ${sweep.done ?? 0} of ${plural(sweep.total ?? 0, "repo")}`
    : refreshing
      ? "Asking workwork…"
      : `${plural(inRepo.length, "candidate")}${lastScan ? `, ${ago(lastScan)}` : ""}`;
  const where = project === null ? "every repo" : repoName(project);

  const selectedBlueprint = described.get(blueprint);
  const empty = (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>
          {refreshing || (blueprint !== ALL && scanning(blueprint))
            ? "Asking workwork"
            : "No candidates"}
        </EmptyTitle>
        <EmptyDescription>
          {blueprint !== ALL
            ? `${blueprint} found nothing in ${where}${selectedBlueprint?.onRequest ? " yet: it looks only when asked" : ""}.`
            : project === null
              ? "Ask workwork for candidates across your repos. It takes a few minutes."
              : `There are no candidates for ${repoName(project)}${handled ? ` left: ${handled} handled since workwork last looked` : ""}.`}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {blueprint === ALL ? (
          <Button variant="outline" disabled={refreshing} onClick={refresh}>
            {refreshing && <Spinner />} Ask workwork
          </Button>
        ) : (
          <Button
            variant="outline"
            disabled={scanning(blueprint)}
            onClick={() => void scan(blueprint)}
          >
            {scanning(blueprint) && <Spinner />} Look for {blueprint} in {where}
          </Button>
        )}
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
          }}
        />
        <span className="flex flex-1 items-center justify-end gap-2 text-sm whitespace-nowrap text-muted-foreground tabular-nums">
          {status}
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
                ? "Ask workwork about every repo again, a few at a time"
                : `Ask workwork about ${repoName(project)} again, under a minute`}
            </TooltipContent>
          </Tooltip>
        </span>
      </div>

      {/* Always there, so selecting the first candidate doesn't push the list down. */}
      <div
        role="group"
        aria-label="Batch actions"
        className="flex flex-wrap items-center gap-2 rounded-lg border bg-background px-3 py-2"
      >
        <span className="text-sm font-medium tabular-nums">
          {selection.length ? `${selection.length} selected` : "Select candidates to act on"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={!selection.length}
          onClick={() => setSelected(new Set())}
        >
          Clear
        </Button>
        <span className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!selection.length}
                  onClick={() => void decide("defer")}
                />
              }
            >
              Not now
            </TooltipTrigger>
            <TooltipContent>Hide them in their repos until their code changes</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!selection.length}
                  onClick={() => void decide("reject")}
                />
              }
            >
              Dismiss
            </TooltipTrigger>
            <TooltipContent>Hide them in their repos for good</TooltipContent>
          </Tooltip>
          <QueueButton
            label={selection.length ? `Queue ${selection.length}` : "Queue"}
            disabled={!selection.length}
            settings={snapshot.settings}
            onQueue={async (pin) => {
              await queue(selection, pin);
              setSelected(new Set());
            }}
          />
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-6 md:flex-row">
        <BlueprintNav
          blueprints={blueprints}
          counts={counts}
          total={inRepo.length}
          current={blueprint}
          scanning={scanning}
          where={where}
          onSelect={(name) => {
            setBlueprint(name);
            setShown(PAGE);
          }}
          onScan={(name) => void scan(name)}
        />

        {matches.length === 0 ? (
          <div className="flex-1">{empty}</div>
        ) : (
          // The one part that scrolls, so the filters and blueprints stay in view.
          <div className="-m-1 min-w-0 flex-1 overflow-y-auto p-1 [scrollbar-gutter:stable]">
            <Section
              title={
                <span className="flex min-h-8 items-center gap-3 px-3">
                  <GroupCheckbox
                    items={open}
                    selected={selected}
                    label="not queued"
                    onCheckedChange={(checked) => select(open, checked)}
                  />
                  <span>
                    {matches.length} matching, {open.length} not queued yet
                    {handled > 0 && `, ${handled} handled since workwork last looked`}
                  </span>
                </span>
              }
            >
              <RowGroup>
                {groups.slice(0, shown).map((group) => {
                  const candidate = (item: Item) => (
                    <CandidateRow
                      key={key(item)}
                      item={item}
                      job={pending(item)}
                      last={pending(item) ? undefined : jobs.get(key(item))}
                      blueprint={described.get(item.blueprint)?.description}
                      checked={selected.has(key(item))}
                      onCheckedChange={(checked) => select([item], checked)}
                      onQueue={(pin) => queue([item], pin)}
                      snapshot={snapshot}
                      act={act}
                    />
                  );
                  if (group.length === 1) return candidate(group[0]);
                  return (
                    <CandidateGroup
                      key={key(group[0])}
                      items={group}
                      open={group.filter((item) => !pending(item))}
                      selected={selected}
                      onCheckedChange={(checked) =>
                        select(
                          group.filter((item) => !pending(item)),
                          checked,
                        )
                      }
                    >
                      {group.map(candidate)}
                    </CandidateGroup>
                  );
                })}
              </RowGroup>
              {groups.length > shown && (
                <Button variant="ghost" onClick={() => setShown(shown + PAGE)}>
                  Show {Math.min(PAGE, groups.length - shown)} more
                </Button>
              )}
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The blueprints to filter by, each with a button to look for just its candidates: those that found
 * something, the user's own, and the ones that only look when asked.
 */
function BlueprintNav({
  blueprints,
  counts,
  total,
  current,
  scanning,
  where,
  onSelect,
  onScan,
}: {
  blueprints: Blueprint[];
  counts: Map<string, number>;
  total: number;
  current: string;
  scanning: (name: string) => boolean;
  where: string;
  onSelect: (name: string) => void;
  onScan: (name: string) => void;
}) {
  const known = new Set(blueprints.map((each) => each.name));
  const byCount = (a: string, b: string) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0);
  // Found also lists what the cache has from blueprints workwork no longer knows, like a deleted one.
  const found = [
    ...blueprints.filter((each) => !each.custom && !each.onRequest && counts.has(each.name)),
    ...[...counts.keys()].filter((name) => !known.has(name)).map((name) => ({ name })),
  ]
    .map((each) => each.name)
    .sort(byCount);
  const sections = [
    { title: "Found", names: found },
    {
      title: "Yours",
      names: blueprints.filter((each) => each.custom).map((each) => each.name),
    },
    {
      title: "On request",
      names: blueprints
        .filter((each) => !each.custom && each.onRequest)
        .map((each) => each.name)
        .sort(byCount),
    },
  ].filter((section) => section.names.length > 0);
  const described = new Map(blueprints.map((each) => [each.name, each.description]));

  const entry = (name: string) => (
    <div key={name} className="flex items-center gap-0.5">
      <Tooltip disabled={!described.get(name)}>
        <TooltipTrigger
          render={
            <Button
              variant={current === name ? "secondary" : "ghost"}
              size="sm"
              className="min-w-0 flex-1"
              onClick={() => onSelect(name)}
            />
          }
        >
          <span className="flex-1 truncate text-left">{name}</span>
          <span className="text-muted-foreground tabular-nums">{counts.get(name) ?? 0}</span>
        </TooltipTrigger>
        <TooltipContent side="right">{described.get(name)}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Look for ${name} in ${where}`}
              disabled={scanning(name)}
              onClick={() => onScan(name)}
            />
          }
        >
          <RefreshCwIcon
            className={`text-muted-foreground ${scanning(name) ? "animate-spin motion-reduce:animate-none" : ""}`}
          />
        </TooltipTrigger>
        <TooltipContent side="right">
          Look for {name} in {where}
        </TooltipContent>
      </Tooltip>
    </div>
  );

  return (
    <nav className="flex max-h-36 flex-none flex-col gap-3 overflow-y-auto md:max-h-none md:w-56">
      <Button
        variant={current === ALL ? "secondary" : "ghost"}
        size="sm"
        className="mr-6.5"
        onClick={() => onSelect(ALL)}
      >
        <span className="flex-1 text-left">All blueprints</span>
        <span className="text-muted-foreground tabular-nums">{total}</span>
      </Button>
      {sections.map((section) => (
        <div key={section.title} className="flex flex-col gap-0.5">
          <h3 className="px-2.5 text-xs font-medium text-muted-foreground">{section.title}</h3>
          {section.names.map(entry)}
        </div>
      ))}
    </nav>
  );
}

/** Ticks the candidates not queued yet; part-ticked when only some of them are selected. */
function GroupCheckbox({
  items,
  selected,
  label,
  onCheckedChange,
}: {
  items: Item[];
  selected: Set<string>;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  const ticked = items.filter((item) => selected.has(key(item))).length;
  const all = items.length > 0 && ticked === items.length;
  return (
    <NeutralCheckbox
      aria-label={`${all ? "Clear" : "Select"} all ${items.length} ${label}`}
      disabled={items.length === 0}
      checked={all}
      indeterminate={ticked > 0 && !all}
      onCheckedChange={() => onCheckedChange(!all)}
    />
  );
}

/** Candidates of one blueprint in one repo, folded into a row that opens to show them. */
function CandidateGroup({
  items,
  open,
  selected,
  onCheckedChange,
  children,
}: {
  items: Item[];
  /** The ones not queued yet. */
  open: Item[];
  selected: Set<string>;
  onCheckedChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [{ repo, blueprint, attention }] = items;
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <>
      <Row
        leading={
          <GroupCheckbox
            items={open}
            selected={selected}
            label={`${blueprint} candidates in ${repoName(repo)}`}
            onCheckedChange={onCheckedChange}
          />
        }
        title={
          <button
            type="button"
            aria-expanded={expanded}
            className="flex items-center gap-1 text-left"
            onClick={() => setExpanded(!expanded)}
          >
            <Chevron className="size-4 shrink-0 text-muted-foreground" />
            <span>
              <span className="font-normal text-muted-foreground">{repoName(repo)}: </span>
              {blueprint}, {plural(items.length, "candidate")}
            </span>
          </button>
        }
        meta={[
          blueprint,
          attention,
          open.length < items.length && `${items.length - open.length} queued`,
        ]
          .filter(Boolean)
          .join(" · ")}
      />
      {expanded && <div className="flex flex-col gap-2 pl-6">{children}</div>}
    </>
  );
}

function CandidateRow({
  item,
  job,
  last,
  blueprint,
  checked,
  onCheckedChange,
  onQueue,
  snapshot,
  act,
}: {
  item: Item;
  /** The job it's in, while that's under way. */
  job?: Job;
  /** The job it was last in, now finished: workwork offers it again. */
  last?: Job;
  blueprint?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  onQueue: (pin?: Pin) => void;
  snapshot: Snapshot;
  act: Act;
}) {
  const queueButton = <QueueButton label="Queue" settings={snapshot.settings} onQueue={onQueue} />;
  return (
    <Row
      leading={
        job ? (
          <StateIcon state={taskState(job, snapshot.prs)} />
        ) : (
          <NeutralCheckbox
            aria-label={`Select ${itemTitle(item)}`}
            checked={checked}
            onCheckedChange={onCheckedChange}
          />
        )
      }
      title={
        <TaskDetails
          item={item}
          job={job}
          blueprint={blueprint}
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
}

/** Queues for the first free worker, or, from the arrow's menu, for a role or one worker. */
function QueueButton({
  label,
  disabled,
  settings,
  onQueue,
}: {
  label: string;
  disabled?: boolean;
  settings: Settings;
  onQueue: (pin?: Pin) => void;
}) {
  return (
    <ButtonGroup>
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => onQueue()}>
        {label}
      </Button>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-sm"
                    disabled={disabled}
                    aria-label={`${label} with`}
                  />
                }
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

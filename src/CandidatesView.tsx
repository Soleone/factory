import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Act } from "@/api";
import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import type { Item, Job, Pin, Settings, Snapshot } from "@/backend/types.ts";
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/soleone/tooltip/tooltip";
import { CloneDialog } from "@/CloneDialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ago, itemTitle, repoName } from "@/format";
import { PinMenuItems } from "@/PinMenu";
import { Row, Section } from "@/Row";
import { NeutralCheckbox } from "@/components/variants/checkbox";
import { RowGroup } from "@/components/variants/item";
import { StateIcon, StatePill, TaskDetails, taskState } from "@/TaskDetails";

const ALL = "";
const CLONE = { value: "clone-project", label: "Clone project..." };
const PAGE = 100;
const key = (item: { repo: string; id: string }) => `${item.repo} ${item.id}`;

/** Everything workwork found, by blueprint, to pick from. */
export function CandidatesView({ snapshot, act }: { snapshot: Snapshot; act: Act }) {
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneCount, setCloneCount] = useState(0);
  const repoTrigger = useRef<HTMLButtonElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [repoPaths, setRepoPaths] = useState<string[]>([]);
  const [repo, setRepo] = useState(ALL);
  const [blueprint, setBlueprint] = useState(ALL);
  const [attention, setAttention] = useState(["none", "skim", "decide"]);
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(PAGE);
  /** Kept across filters, so one batch can take candidates from several blueprints. */
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  /** What each blueprint does, by name; empty until workwork answers. */
  const [described, setDescribed] = useState(new Map<string, string>());
  const { at, count, refreshing } = snapshot.candidates;

  useEffect(() => {
    let ignore = false;
    void api.candidates().then(({ items, repos }) => {
      if (ignore) return;
      setItems(items);
      setRepoPaths(repos);
    });
    return () => {
      ignore = true;
    };
  }, [at, cloneCount]);

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

  const allRepos = { value: ALL, label: `All repos (${items.length})` };
  const repos = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.repo, (counts.get(item.repo) ?? 0) + 1);
    return repoPaths
      .map((path) => ({ value: path, label: `${repoName(path)} (${counts.get(path) ?? 0})` }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [items, repoPaths]);

  const inRepo = repo === ALL ? items : items.filter((item) => item.repo === repo);
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
  const open = matches.filter((item) => !jobs.has(key(item)));
  const selection = items.filter((item) => selected.has(key(item)) && !jobs.has(key(item)));
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
          {refreshing
            ? "workwork is looking through every repo under $SRC. That takes a few minutes."
            : repo === ALL
              ? "Ask workwork for candidates across your repos. It takes a few minutes."
              : `There are no candidates for ${repoName(repo)}.`}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" disabled={refreshing} onClick={() => act(api.refreshCandidates)}>
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
        <Select
          items={[allRepos, ...repos, CLONE]}
          value={repo}
          onValueChange={(value) => {
            if (value === CLONE.value) {
              setCloneOpen(true);
              return;
            }
            const next = value ?? ALL;
            setRepo(next);
            setShown(PAGE);
            if (
              !items.some(
                (item) => item.blueprint === blueprint && (next === ALL || item.repo === next),
              )
            )
              setBlueprint(ALL);
          }}
        >
          <SelectTrigger aria-label="Repo" ref={repoTrigger}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              <SelectItem value={allRepos.value}>{allRepos.label}</SelectItem>
              {repos.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
            <SelectSeparator />
            <SelectGroup>
              <SelectItem value={CLONE.value}>{CLONE.label}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <CloneDialog
          act={act}
          open={cloneOpen}
          onOpenChange={setCloneOpen}
          onCloned={() => setCloneCount((count) => count + 1)}
          finalFocus={repoTrigger}
        />
        <span className="flex flex-1 items-center justify-end gap-2 text-sm text-muted-foreground">
          {refreshing ? "Asking workwork…" : `${count} candidates${at ? `, ${ago(at)}` : ""}`}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Refresh candidates"
                  disabled={refreshing}
                  onClick={() => void act(api.refreshCandidates)}
                />
              }
            >
              <RefreshCwIcon
                className={refreshing ? "animate-spin motion-reduce:animate-none" : undefined}
              />
            </TooltipTrigger>
            <TooltipContent>
              {refreshing ? "Asking workwork, takes a few minutes" : "Ask workwork again"}
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
                  </span>
                </span>
              }
            >
              <RowGroup>
                {matches.slice(0, shown).map((item) => {
                  const job = jobs.get(key(item));
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
                          {[item.blueprint, item.attention, item.id].join(" · ")}
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

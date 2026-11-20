import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Act } from "@/api";
import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { AGENT_NAMES } from "@/backend/agents.ts";
import type { Item, Job, Preset, Snapshot } from "@/backend/types.ts";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
import { ItemGroup } from "@/components/ui/item";
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
import { ago, itemTitle, pinName, repoName } from "@/format";
import { Row, Section } from "@/Row";
import { StateIcon, StatePill, TaskDetails, taskState } from "@/TaskDetails";

const ALL = "";
const CLONE = { value: "clone-project", label: "Clone project..." };
const PAGE = 100;
const key = (item: { repo: string; id: string }) => `${item.repo} ${item.id}`;

/** Everything workwork found, by play, to pick from. */
export function CandidatesView({ snapshot, act }: { snapshot: Snapshot; act: Act }) {
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneCount, setCloneCount] = useState(0);
  const repoTrigger = useRef<HTMLButtonElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [repoPaths, setRepoPaths] = useState<string[]>([]);
  const [repo, setRepo] = useState(ALL);
  const [play, setPlay] = useState(ALL);
  const [levels, setLevels] = useState(["auto", "skim", "decide"]);
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(PAGE);
  /** What each play does, by name; empty until workwork answers. */
  const [described, setDescribed] = useState(new Map<string, string>());
  /** Refresh clicks, each turning the icon once. */
  const [turns, setTurns] = useState(0);
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
      .plays()
      .then((plays) => setDescribed(new Map(plays.map((each) => [each.name, each.description]))));
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
  const playCounts = new Map<string, number>();
  for (const item of inRepo) playCounts.set(item.play, (playCounts.get(item.play) ?? 0) + 1);
  const plays = [...playCounts].sort((a, b) => a[1] - b[1]);

  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = inRepo.filter(
    (item) =>
      (play === ALL || item.play === play) &&
      levels.includes(item.level) &&
      words.every((word) =>
        `${itemTitle(item)} ${item.id} ${item.label}`.toLowerCase().includes(word),
      ),
  );
  const queue = (wanted: Item[], pin?: Preset) => act(() => api.queue(wanted, pin));
  const open = matches.filter((item) => !jobs.has(key(item)));

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
    <div className="flex flex-col gap-4 pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-xs"
          placeholder="Search titles, ids, repos"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <ToggleGroup multiple variant="outline" value={levels} onValueChange={setLevels}>
          {["auto", "skim", "decide"].map((level) => (
            <ToggleGroupItem key={level} value={level}>
              {level}
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
            if (!items.some((item) => item.play === play && (next === ALL || item.repo === next)))
              setPlay(ALL);
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
                  onClick={() => {
                    setTurns(turns + 1);
                    void act(api.refreshCandidates);
                  }}
                />
              }
            >
              {/* A new key replays the turn on every click. */}
              <RefreshCwIcon key={turns} className={turns ? "refresh-turn" : undefined} />
            </TooltipTrigger>
            <TooltipContent>
              {refreshing ? "Asking workwork, takes a few minutes" : "Ask workwork again"}
            </TooltipContent>
          </Tooltip>
        </span>
      </div>

      {inRepo.length === 0 ? (
        empty
      ) : (
        <div className="flex flex-col gap-6 md:flex-row">
          <nav className="flex flex-wrap gap-1 md:w-48 md:flex-none md:flex-col">
            {[[ALL, inRepo.length] as const, ...plays].map(([name, total]) => (
              <Tooltip key={name} disabled={!described.has(name)}>
                <TooltipTrigger
                  render={
                    <Button
                      variant={play === name ? "secondary" : "ghost"}
                      size="sm"
                      onClick={() => {
                        setPlay(name);
                        setShown(PAGE);
                      }}
                    />
                  }
                >
                  <span className="flex-1 text-left">{name || "All plays"}</span>
                  <span className="text-muted-foreground">{total}</span>
                </TooltipTrigger>
                <TooltipContent side="right">{described.get(name)}</TooltipContent>
              </Tooltip>
            ))}
          </nav>

          <div className="min-w-0 flex-1">
            <Section
              title={
                <span className="flex items-center gap-2">
                  <span className="flex-1">
                    {matches.length} matching, {open.length} not queued yet
                  </span>
                  {open.length > 0 && open.length <= 20 && (
                    <QueueButton
                      label={`Queue all ${open.length}`}
                      presets={snapshot.settings.presets}
                      onQueue={(pin) => queue(open, pin)}
                    />
                  )}
                </span>
              }
            >
              <ItemGroup>
                {matches.slice(0, shown).map((item) => {
                  const job = jobs.get(key(item));
                  const queueButton = (
                    <QueueButton
                      label="Queue"
                      presets={snapshot.settings.presets}
                      onQueue={(pin) => queue([item], pin)}
                    />
                  );
                  return (
                    <Row
                      key={key(item)}
                      leading={<StateIcon state={taskState(job, snapshot.prs)} />}
                      title={
                        <TaskDetails
                          item={item}
                          job={job}
                          play={described.get(item.play)}
                          snapshot={snapshot}
                          act={act}
                          actions={!job && queueButton}
                        />
                      }
                      meta={
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <StatePill state={taskState(job, snapshot.prs)} />
                          {[item.play, item.level, item.id].join(" · ")}
                        </span>
                      }
                    >
                      {!job && queueButton}
                    </Row>
                  );
                })}
              </ItemGroup>
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

/** Queues for whichever agent is free first, or, from the arrow's menu, for one agent or preset. */
function QueueButton({
  label,
  presets,
  onQueue,
}: {
  label: string;
  presets: Preset[];
  onQueue: (pin?: Preset) => void;
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
          <TooltipContent>{label} for a specific agent or preset</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-auto">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Agent</DropdownMenuLabel>
            {AGENT_NAMES.map((agent) => (
              <DropdownMenuItem key={agent} onClick={() => onQueue({ agent })}>
                {agent}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Preset</DropdownMenuLabel>
            {presets.length === 0 && (
              <DropdownMenuItem disabled>Add presets in Settings</DropdownMenuItem>
            )}
            {presets.map((preset, index) => (
              <DropdownMenuItem key={index} onClick={() => onQueue(preset)}>
                {pinName(preset)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}

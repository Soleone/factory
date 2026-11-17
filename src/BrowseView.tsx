import { useEffect, useMemo, useState } from "react";
import { api, type Act } from "@/api";
import { AGENT_NAMES } from "@/backend/agents.ts";
import type { Item, Job, Snapshot } from "@/backend/types.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ago, itemTitle, JOB_BADGE } from "@/format";
import { Row, Section } from "@/Row";

const ALL = "";
const ANY_AGENT = "any";
const PAGE = 100;
const key = (item: { repo: string; id: string }) => `${item.repo} ${item.id}`;

/** Everything workwork found, by play, to pick from. */
export function BrowseView({ snapshot, act }: { snapshot: Snapshot; act: Act }) {
  const [items, setItems] = useState<Item[]>([]);
  const [play, setPlay] = useState(ALL);
  const [levels, setLevels] = useState(["auto", "skim", "decide"]);
  const [search, setSearch] = useState("");
  const [agent, setAgent] = useState(ANY_AGENT);
  const [shown, setShown] = useState(PAGE);
  const { at, count, refreshing } = snapshot.candidates;

  useEffect(() => {
    void api.candidates().then((candidates) => setItems(candidates.items));
  }, [at]);

  // The latest job per candidate, so the list says what already happened to it.
  const jobs = useMemo(() => {
    const byItem = new Map<string, Job>();
    for (const job of snapshot.jobs) if (job.state !== "removed") byItem.set(key(job.item), job);
    return byItem;
  }, [snapshot.jobs]);

  const plays = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.play, (counts.get(item.play) ?? 0) + 1);
    return [...counts].sort((a, b) => a[1] - b[1]);
  }, [items]);

  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = items.filter(
    (item) =>
      (play === ALL || item.play === play) &&
      levels.includes(item.level) &&
      words.every((word) => `${item.title} ${item.id} ${item.label}`.toLowerCase().includes(word)),
  );
  const queue = (wanted: Item[]) =>
    act(() => api.queue(wanted, agent === ANY_AGENT ? undefined : agent));
  const open = matches.filter((item) => !jobs.has(key(item)));

  if (items.length === 0)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{refreshing ? "Asking workwork" : "No candidates yet"}</EmptyTitle>
          <EmptyDescription>
            {refreshing
              ? "workwork is looking through every repo under $SRC. That takes a few minutes."
              : "Ask workwork for candidates across your repos. It takes a few minutes."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button disabled={refreshing} onClick={() => act(api.refreshCandidates)}>
            {refreshing && <Spinner />} Ask workwork
          </Button>
        </EmptyContent>
      </Empty>
    );

  const agents = [{ value: ANY_AGENT, label: "Any agent" }].concat(
    AGENT_NAMES.map((name) => ({ value: name, label: name })),
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
          items={agents}
          value={agent}
          onValueChange={(value) => setAgent(value ?? ANY_AGENT)}
        >
          <SelectTrigger aria-label="Queue for">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {agents.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="flex flex-1 items-center justify-end gap-2 text-sm text-muted-foreground">
          {count} candidates{at ? `, ${ago(at)}` : ""}
          <Button
            variant="outline"
            size="sm"
            disabled={refreshing}
            onClick={() => act(api.refreshCandidates)}
          >
            {refreshing && <Spinner />} {refreshing ? "Asking workwork" : "Refresh"}
          </Button>
        </span>
      </div>

      <div className="flex flex-col gap-6 md:flex-row">
        <nav className="flex flex-wrap gap-1 md:w-48 md:flex-none md:flex-col">
          {[[ALL, items.length] as const, ...plays].map(([name, total]) => (
            <Button
              key={name}
              variant={play === name ? "secondary" : "ghost"}
              size="sm"
              onClick={() => {
                setPlay(name);
                setShown(PAGE);
              }}
            >
              <span className="flex-1 text-left">{name || "All plays"}</span>
              <span className="text-muted-foreground">{total}</span>
            </Button>
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
                  <Button variant="outline" size="sm" onClick={() => queue(open)}>
                    Queue all {open.length}
                  </Button>
                )}
              </span>
            }
          >
            <ItemGroup>
              {matches.slice(0, shown).map((item) => {
                const job = jobs.get(key(item));
                return (
                  <Row
                    key={key(item)}
                    title={itemTitle(item)}
                    meta={[item.play, item.level, item.id].join(" · ")}
                  >
                    {job ? (
                      <Badge variant={JOB_BADGE[job.state]}>{job.state}</Badge>
                    ) : (
                      <Button variant="outline" size="sm" onClick={() => queue([item])}>
                        Queue
                      </Button>
                    )}
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
    </div>
  );
}

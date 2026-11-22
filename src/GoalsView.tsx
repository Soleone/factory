import { useState } from "react";
import Markdown from "markdown-to-jsx/react";
import { ArrowLeftIcon, ChevronRightIcon, FlameIcon, GitBranchIcon, PlusIcon } from "lucide-react";
import { api, type Act } from "@/api";
import {
  critical,
  depths,
  PLANNING,
  prUrl,
  TIERS,
  type Job,
  type Snapshot,
  type Tier,
} from "@/backend/types.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { ItemGroup } from "@/components/ui/item";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/soleone/tooltip/tooltip";
import { ago, minutesSince } from "@/format";
import { useQueryParam } from "@/hooks/use-query-param";
import { NewGoalDialog } from "@/NewGoalDialog";
import { MARKDOWN } from "@/PrReview";
import { Row, Section } from "@/Row";
import { StateIcon, StatePill, TaskDetails } from "@/TaskDetails";

const TIER_SHORT: Record<Tier, string> = { communicator: "comm", builder: "build", grunt: "grunt" };

/** How a goal's own state reads: planning until its plan is in, then working, not queued. */
function goalLabel(goal: Job, nodes: Job[]): string | undefined {
  if (goal.blocked) return BLOCKED[goal.blocked];
  if (goal.state !== "queued") return undefined;
  const planning = nodes.some(
    (node) =>
      node.item.blueprint === "decompose" && (node.state === "queued" || node.state === "running"),
  );
  return planning ? "planning" : "working";
}

const BLOCKED: Record<string, string> = {
  checkpoint: "needs your approval",
  paused: "paused",
  red: "integration branch red",
  asked: "waiting for you",
  held: "held by a failure",
  review: "merging",
};

/** The brief the goal started from; goals from before it was kept have it only in their decomposer's prompt. */
function briefOf(goal: Job, nodes: Job[]): string | undefined {
  if (goal.goal!.brief) return goal.goal!.brief;
  const prompt = nodes.find((node) => node.item.blueprint === "decompose")?.prompt;
  const brief = prompt?.match(/^Repo: .*\n\n([^]*?)\n\n## The plan format/m)?.[1];
  return brief === "(no brief beyond the title)" ? undefined : brief;
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1) + ".";

/** Everything under a goal, in the order the queue takes it. */
const nodesOf = (jobs: Job[], goal: Job) =>
  jobs.filter((job) => job.of === goal.id && job.state !== "removed");

/** The latest thing that happened under the goal. */
function lastActivity(nodes: Job[], goal: Job): string {
  const times = [goal, ...nodes].flatMap((job) => [
    job.added,
    ...job.notes.map((note) => note.at),
    ...job.attempts.map((attempt) => attempt.end),
  ]);
  return times.sort().at(-1)!;
}

/** Goals: large tasks as graphs of jobs, each on its own integration branch. */
export function GoalsView({ snapshot, act }: { snapshot: Snapshot; act: Act }) {
  const [open, setOpen] = useQueryParam("goal", "");
  const [creating, setCreating] = useState(false);
  const goals = snapshot.jobs.filter((job) => job.goal && job.state !== "removed");
  const shown = goals.find((goal) => goal.id === open);
  if (shown)
    return <GoalView goal={shown} snapshot={snapshot} act={act} onBack={() => setOpen("")} />;
  // One dialog for both the empty page and the list, so the goal appearing mid-create doesn't remount it.
  return (
    <>
      <GoalList
        goals={goals}
        snapshot={snapshot}
        onNew={() => setCreating(true)}
        onOpen={setOpen}
      />
      <NewGoalDialog
        act={act}
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => {
          setCreating(false);
          setOpen(id);
        }}
      />
    </>
  );
}

function GoalList({
  goals,
  snapshot,
  onNew,
  onOpen,
}: {
  goals: Job[];
  snapshot: Snapshot;
  onNew: () => void;
  onOpen: (id: string) => void;
}) {
  const newGoal = (
    <Button variant="outline" onClick={onNew}>
      <PlusIcon /> New goal
    </Button>
  );
  if (goals.length === 0)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No goals yet</EmptyTitle>
          <EmptyDescription>
            A goal is one large task, planned into jobs that run on their own branch.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>{newGoal}</EmptyContent>
      </Empty>
    );
  return (
    <div className="flex flex-col gap-4 pt-2">
      <div className="flex justify-end">{newGoal}</div>
      <ItemGroup>
        {goals.map((goal) => {
          const nodes = nodesOf(snapshot.jobs, goal);
          const done = nodes.filter((node) => node.state === "done").length;
          const used = nodes.reduce((sum, node) => sum + node.attempts.length, 0);
          const budget = goal.goal!.budget?.attempts;
          return (
            <Row
              key={goal.id}
              leading={<StateIcon state={goal.state} />}
              progress={nodes.length ? done / nodes.length : 0}
              title={
                <button
                  type="button"
                  className="text-left hover:underline"
                  onClick={() => onOpen(goal.id)}
                >
                  {goal.item.title}
                </button>
              }
              meta={
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <StatePill state={goal.state} label={goalLabel(goal, nodes)} />
                  <span>
                    {done}/{nodes.length} done
                  </span>
                  {TIERS.map((tier) => {
                    const of = nodes.filter((node) => node.tier === tier);
                    return of.length ? (
                      <span key={tier}>
                        {TIER_SHORT[tier]} {of.filter((node) => node.state === "done").length}/
                        {of.length}
                      </span>
                    ) : null;
                  })}
                  <span>
                    {used}
                    {budget ? `/${budget}` : ""} attempts
                  </span>
                  <span>{ago(lastActivity(nodes, goal))}</span>
                </span>
              }
            >
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Open goal"
                onClick={() => onOpen(goal.id)}
              >
                <ChevronRightIcon />
              </Button>
            </Row>
          );
        })}
      </ItemGroup>
    </div>
  );
}

function GoalView({
  goal,
  snapshot,
  act,
  onBack,
}: {
  goal: Job;
  snapshot: Snapshot;
  act: Act;
  onBack: () => void;
}) {
  const { jobs, status } = snapshot;
  const nodes = nodesOf(jobs, goal);
  const info = goal.goal!;
  const done = nodes.filter((node) => node.state === "done").length;
  const used = nodes.reduce((sum, node) => sum + node.attempts.length, 0);
  const red = goal.blocked === "red";
  const factorySaid = goal.notes.findLast((note) => note.kind === "factory");
  const final = prUrl(goal);
  const brief = briefOf(goal, nodes);
  const planning = nodes.filter((node) =>
    (PLANNING as readonly string[]).includes(node.item.blueprint),
  );
  const unverified = nodes.flatMap((node) => node.unverified.map((need) => ({ node, need })));
  const assumed = nodes.flatMap((node) =>
    node.notes.flatMap((note, index) =>
      note.kind === "assume" &&
      !node.notes.some((other) => other.kind === "answer" && other.re === index)
        ? [{ node, note }]
        : [],
    ),
  );

  return (
    <div className="flex flex-col gap-6 pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="icon-sm" aria-label="All goals" onClick={onBack}>
          <ArrowLeftIcon />
        </Button>
        <h2 className="font-heading text-lg font-semibold">{goal.item.title}</h2>
        <StatePill state={goal.state} label={goalLabel(goal, nodes)} />
        <span className="ml-auto flex gap-1">
          {goal.blocked === "paused" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => act(() => api.goal(goal.id, "resume"))}
            >
              Resume
            </Button>
          ) : (
            goal.state !== "done" && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => act(() => api.goal(goal.id, "pause"))}
              >
                Pause
              </Button>
            )
          )}
          {goal.state !== "done" && <Replan goal={goal} act={act} />}
          {goal.state !== "done" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => act(() => api.goal(goal.id, "cancel"))}
            >
              Cancel goal
            </Button>
          )}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span className="flex items-center gap-1">
          <GitBranchIcon className="size-4" /> goal/{info.slug}
        </span>
        <span className={red ? "text-destructive" : ""}>
          {info.gates.length === 0
            ? "no goal gates"
            : `${red ? "red" : "green"}: ${info.gates.map((gate) => `\`${gate}\``).join(", ")}`}
        </span>
        <span>
          {done}/{nodes.length} done
        </span>
        <span>
          {used}
          {info.budget ? ` of ${info.budget.attempts}` : ""} attempts
        </span>
        {final && (
          <a className="text-primary hover:underline" href={final} target="_blank" rel="noreferrer">
            final PR
          </a>
        )}
      </div>

      {brief && (
        <Collapsible>
          <CollapsibleTrigger
            render={
              <button
                type="button"
                className="group flex items-center gap-1 text-sm font-medium text-muted-foreground"
              />
            }
          >
            <ChevronRightIcon className="size-4 transition-transform group-aria-expanded:rotate-90" />
            Brief
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <div className="flex flex-col gap-2 rounded-md border p-3 text-sm wrap-anywhere">
              <Markdown options={MARKDOWN}>{brief}</Markdown>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {goal.blocked === "checkpoint" && (
        <div className="flex flex-col gap-3 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm sm:flex-row sm:items-center">
          <p className="flex-1">
            {sentence(goal.why ?? factorySaid?.text ?? "waiting for your approval")}
          </p>
          <Button
            size="sm"
            className="self-start sm:self-auto"
            onClick={() => act(() => api.goal(goal.id, "approve"))}
          >
            Approve
          </Button>
        </div>
      )}
      {red && factorySaid && (
        <p className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
          {factorySaid.text}; a fix is queued at the front.
        </p>
      )}

      {(unverified.length > 0 || assumed.length > 0) && (
        <Section title="For you to check">
          <ul className="flex flex-col gap-2 text-sm">
            {unverified.map(({ node, need }) => (
              <li key={`${node.id} ${need}`} className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">unverified</Badge>
                <span className="flex-1">
                  {node.item.title}: {need}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => act(() => api.verify(node.id, need))}
                >
                  Checked
                </Button>
              </li>
            ))}
            {assumed.map(({ node, note }) => (
              <Assumption
                key={`${node.id} ${note.at}`}
                node={node}
                question={note.text}
                assumed={note.assumed ?? ""}
                act={act}
              />
            ))}
          </ul>
        </Section>
      )}

      {planning.length > 0 && (
        <Section title="Planning">
          <div className="flex flex-wrap gap-2">
            {planning.map((node) => (
              <NodeCard
                key={node.id}
                node={node}
                snapshot={snapshot}
                act={act}
                status={status}
                onPath={false}
                dependency={false}
                onHover={() => {}}
              />
            ))}
          </div>
        </Section>
      )}

      <Section title="Plan">
        <div className="overflow-x-auto pb-2">
          <Columns
            nodes={nodes.filter((node) => !node.parent && !planning.includes(node))}
            all={nodes}
            snapshot={snapshot}
            act={act}
            status={status}
          />
        </div>
      </Section>
    </div>
  );
}

/**
 * The plan as columns by dependency depth, left to right. A milestone is one card holding its own
 * columns, collapsed once it's done. Factory's helpers sit in the column of the node they serve.
 */
function Columns({
  nodes,
  all,
  snapshot,
  act,
  status,
}: {
  nodes: Job[];
  all: Job[];
  snapshot: Snapshot;
  act: Act;
  status: Snapshot["status"];
}) {
  const [hovered, setHovered] = useState<string>();
  const planned = nodes.filter((node) => !node.branchOf);
  const depth = depths(planned);
  for (const helper of nodes.filter((node) => node.branchOf))
    depth.set(helper.id, depth.get(helper.branchOf!) ?? 0);
  const path = critical(all);
  const highlighted = new Set(all.find((node) => node.id === hovered)?.after ?? []);
  const layers = [...new Set(depth.values())].sort((a, b) => a - b);
  return (
    <div className="flex w-max gap-3">
      {layers.map((layer) => (
        <div key={layer} className="flex flex-col gap-2">
          {nodes
            .filter((node) => depth.get(node.id) === layer)
            .map((node) => {
              const children = all.filter((each) => each.parent === node.id);
              const props = {
                node,
                snapshot,
                act,
                status,
                // One node is trivially on the path, so it says nothing then.
                onPath: path.size > 1 && path.has(node.id),
                dependency: highlighted.has(node.id),
                onHover: setHovered,
              };
              return children.length > 0 ? (
                <Milestone key={node.id} {...props} members={children} all={all} />
              ) : (
                <NodeCard key={node.id} {...props} />
              );
            })}
        </div>
      ))}
    </div>
  );
}

type CardProps = {
  node: Job;
  snapshot: Snapshot;
  act: Act;
  status: Snapshot["status"];
  onPath: boolean;
  dependency: boolean;
  onHover: (id: string | undefined) => void;
};

function Milestone({ members, all, ...props }: CardProps & { members: Job[]; all: Job[] }) {
  const { node, snapshot, act, status } = props;
  const done = members.filter((member) => member.state === "done").length;
  return (
    <div className="min-w-60 rounded-md border border-dashed p-2">
      <Collapsible defaultOpen={node.state !== "done"}>
        <CollapsibleTrigger
          render={
            <button
              type="button"
              className="flex w-full items-center gap-2 text-left text-sm font-medium"
            />
          }
        >
          <StateIcon state={node.state} />
          <span className="flex-1">{node.item.title}</span>
          <span className="text-xs text-muted-foreground">
            {done}/{members.length}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">
          <Columns nodes={members} all={all} snapshot={snapshot} act={act} status={status} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/** One node: state, tier, what it's doing right now, and its details on click. */
function NodeCard({ node, snapshot, act, status, onPath, dependency, onHover }: CardProps) {
  const worker = status?.workers.find((each) => each.job === node.id);
  const step = node.notes.findLast(
    (note) => note.kind === "step" && note.attempt === node.attempts.length + 1,
  );
  const heavy = node.attempts.some((attempt) => (attempt.compactions ?? 0) > 2);
  const ring = dependency ? "ring-2 ring-accent" : onPath ? "border-primary/60" : "";
  return (
    <div
      className={`flex w-60 flex-col gap-1 rounded-md border bg-card p-2 text-sm ${ring}`}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(undefined)}
    >
      <div className="flex items-start gap-2">
        <StateIcon state={node.state} />
        <span className="min-w-0 flex-1 wrap-anywhere [&_button]:whitespace-normal">
          <TaskDetails item={node.item} job={node} snapshot={snapshot} act={act} bare />
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {node.tier && <Badge variant="secondary">{node.tier}</Badge>}
        {node.front && <Badge variant="outline">factory</Badge>}
        {node.blocked && <span>{BLOCKED[node.blocked]}</span>}
        {node.attempts.length > 0 && (
          <span>
            {node.attempts.length} attempt{node.attempts.length === 1 ? "" : "s"}
          </span>
        )}
        {heavy && (
          <Tooltip>
            <TooltipTrigger render={<span className="flex items-center text-warning" />}>
              <FlameIcon className="size-3.5" /> heavy
            </TooltipTrigger>
            <TooltipContent>
              Compacted more than twice; replans split work like this smaller.
            </TooltipContent>
          </Tooltip>
        )}
        {onPath && <span className="text-primary">critical path</span>}
      </div>
      {worker && (
        <div className="text-xs">
          <span className="text-primary">{worker.id}</span>, {minutesSince(worker.since)} min
          {worker.context ? `, ${Math.round(worker.context / 1000)}k context` : ""}
          <div className="truncate text-muted-foreground">
            {step
              ? `${step.text}${step.of ? ` (${step.done ?? 0}/${step.of})` : ""}`
              : (worker.activity ?? "starting")}
          </div>
        </div>
      )}
    </div>
  );
}

function Assumption({
  node,
  question,
  assumed,
  act,
}: {
  node: Job;
  question: string;
  assumed: string;
  act: Act;
}) {
  const [text, setText] = useState("");
  return (
    <li className="flex flex-col gap-1">
      <span>
        <Badge variant="outline">assumed</Badge> {node.item.title}: assumed{" "}
        <strong>{assumed}</strong>, asked {question}
      </span>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void act(() => api.answer(node.id, text));
        }}
      >
        <Input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="A different answer queues a change"
        />
        <Button type="submit" variant="outline" size="sm" disabled={!text.trim()}>
          Answer
        </Button>
        <Button type="button" size="sm" onClick={() => act(() => api.answer(node.id, "fine"))}>
          Fine
        </Button>
      </form>
    </li>
  );
}

function Replan({ goal, act }: { goal: Job; act: Act }) {
  const [why, setWhy] = useState<string>();
  if (why === undefined)
    return (
      <Button variant="outline" size="sm" onClick={() => setWhy("")}>
        Replan
      </Button>
    );
  return (
    <form
      className="flex gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        void act(() => api.replan(goal.id, why)).then(() => setWhy(undefined));
      }}
    >
      <Input
        autoFocus
        value={why}
        onChange={(event) => setWhy(event.target.value)}
        placeholder="Why replan?"
        className="h-8 w-48"
      />
      <Button type="submit" size="sm" disabled={!why.trim()}>
        Queue
      </Button>
    </form>
  );
}

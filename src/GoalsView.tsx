import { useState, type ReactNode } from "react";
import Markdown from "markdown-to-jsx/react";
import { ArrowLeftIcon, ChevronRightIcon, FlameIcon, GitBranchIcon, PlusIcon } from "lucide-react";
import { api, type Act } from "@/api";
import {
  critical,
  depths,
  PLANNING,
  prUrl,
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
import { ago, minutesSince, repoName } from "@/format";
import { useQueryParam } from "@/hooks/use-query-param";
import { NewGoalDialog } from "@/NewGoalDialog";
import { MARKDOWN } from "@/PrReview";
import { Row, Section } from "@/Row";
import { StateIcon, StatePill, TaskDetails } from "@/TaskDetails";

/** How a goal's own state reads: planning until its plan is in, then working, not queued. */
function goalLabel(goal: Job, nodes: Job[], on: boolean): string | undefined {
  if (goal.blocked) return BLOCKED[goal.blocked];
  if (goal.state !== "queued") return undefined;
  if (!on) return "waiting for the factory";
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
                  <span className="font-normal text-muted-foreground">
                    {repoName(goal.goal!.repo)}:{" "}
                  </span>
                  {goal.item.title}
                </button>
              }
              meta={
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <StatePill state={goal.state} label={goalLabel(goal, nodes, snapshot.on)} />
                  <span>
                    {done}/{nodes.length} jobs done
                  </span>
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
  const { jobs } = snapshot;
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
        <StatePill state={goal.state} label={goalLabel(goal, nodes, snapshot.on)} />
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
              onClick={() => {
                if (
                  confirm(
                    `Cancel ${goal.item.title}? Every job that hasn't finished is removed; this can't be undone.`,
                  )
                )
                  void act(() => api.goal(goal.id, "cancel"));
              }}
            >
              Cancel goal
            </Button>
          )}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <Fact explain="The integration branch: each job merges here, and it becomes one PR to main when the goal is done.">
          <GitBranchIcon className="size-4" /> goal/{info.slug}
        </Fact>
        <Fact explain="Commands run on the integration branch after every merge. While one fails, the goal stops and a fix goes first.">
          {info.gates.length === 0 ? (
            "no goal checks"
          ) : (
            <span className={red ? "text-destructive" : ""}>
              {info.gates.map((gate) => (
                <code key={gate} className="mr-1 font-mono text-xs">
                  {gate}
                </code>
              ))}
              {red ? "failing" : "passing"}
            </span>
          )}
        </Fact>
        <span>
          {done}/{nodes.length} jobs done
        </span>
        <Fact explain="Agent attempts used so far. At the budget the goal stops and asks before going on.">
          {used}
          {info.budget ? ` of ${info.budget.attempts}` : ""} attempts
        </Fact>
      </div>

      {goal.state === "done" && (
        <div className="flex flex-col gap-3 rounded-md border border-success/50 bg-success/10 p-3 text-sm sm:flex-row sm:items-center">
          <p className="flex-1">
            Done: every job merged into goal/{info.slug}
            {final ? ", and it's up for review as one PR." : "."}
          </p>
          {final && (
            <Button
              size="sm"
              variant="outline"
              className="self-start sm:self-auto"
              nativeButton={false}
              render={<a href={final} target="_blank" rel="noreferrer" />}
            >
              Open the PR
            </Button>
          )}
        </div>
      )}

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
      {!snapshot.on && goal.state === "queued" && (
        <p className="rounded-md border p-3 text-sm text-muted-foreground">
          The factory is off. Its jobs are in the queue and start when you turn it on.
        </p>
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

      <Section title="Plan">
        <PlanList
          // Planning first: it made the plan, and while it runs it's all there is.
          nodes={[...planning, ...nodes.filter((node) => !node.parent && !planning.includes(node))]}
          all={nodes}
          path={critical(nodes)}
          snapshot={snapshot}
          act={act}
        />
      </Section>
    </div>
  );
}

/**
 * The plan top to bottom in the order its dependencies allow, as rows like the queue's. A milestone
 * is a heading over its own nodes, collapsed once it's done. Factory's helpers follow the node they serve.
 */
function PlanList({
  nodes,
  all,
  path,
  snapshot,
  act,
}: {
  nodes: Job[];
  all: Job[];
  path: Set<string>;
  snapshot: Snapshot;
  act: Act;
}) {
  const depth = depths(nodes.filter((node) => !node.branchOf));
  for (const helper of nodes.filter((node) => node.branchOf))
    depth.set(helper.id, (depth.get(helper.branchOf!) ?? 0) + 0.5);
  const sorted = nodes.toSorted((a, b) => depth.get(a.id)! - depth.get(b.id)!);
  return (
    <ItemGroup>
      {sorted.map((node) => {
        const members = all.filter((each) => each.parent === node.id);
        return members.length > 0 ? (
          <Milestone
            key={node.id}
            node={node}
            members={members}
            all={all}
            path={path}
            snapshot={snapshot}
            act={act}
          />
        ) : (
          <NodeRow
            key={node.id}
            node={node}
            snapshot={snapshot}
            act={act}
            // One node is trivially on the path, so it says nothing then.
            onPath={path.size > 1 && path.has(node.id)}
          />
        );
      })}
    </ItemGroup>
  );
}

function Milestone({
  node,
  members,
  all,
  path,
  snapshot,
  act,
}: {
  node: Job;
  members: Job[];
  all: Job[];
  path: Set<string>;
  snapshot: Snapshot;
  act: Act;
}) {
  const done = members.filter((member) => member.state === "done").length;
  return (
    <Collapsible defaultOpen={node.state !== "done"} className="mt-2">
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="group flex w-full items-center gap-2 pb-2 text-left text-sm font-medium"
          />
        }
      >
        <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-aria-expanded:rotate-90" />
        <span className="flex-1">{node.item.title}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {done}/{members.length}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-l pl-3">
          <PlanList nodes={members} all={all} path={path} snapshot={snapshot} act={act} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** One node as a row like the queue's: state, tier, what it waits for, and what it's doing right now. */
function NodeRow({
  node,
  snapshot,
  act,
  onPath,
}: {
  node: Job;
  snapshot: Snapshot;
  act: Act;
  onPath: boolean;
}) {
  const worker = snapshot.status?.workers.find((each) => each.job === node.id);
  const step = node.notes.findLast(
    (note) => note.kind === "step" && note.attempt === node.attempts.length + 1,
  );
  const heavy = node.attempts.some((attempt) => (attempt.compactions ?? 0) > 2);
  const waiting = node.after.flatMap((id) => {
    const before = snapshot.jobs.find((job) => job.id === id);
    return before && before.state !== "done" ? [before.item.title] : [];
  });
  return (
    <Row
      leading={<StateIcon state={node.state} />}
      title={<TaskDetails item={node.item} job={node} snapshot={snapshot} act={act} bare />}
      meta={
        <span className="flex flex-col gap-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {node.tier && <TierBadge tier={node.tier} />}
            {node.front && <Badge variant="outline">factory</Badge>}
            {node.blocked && <span>{BLOCKED[node.blocked]}</span>}
            {waiting.length > 0 && <span>after {waiting.join(", ")}</span>}
            {node.attempts.length > 0 && (
              <span>
                {node.attempts.length} attempt{node.attempts.length === 1 ? "" : "s"}
              </span>
            )}
            {heavy && (
              <Tooltip>
                <TooltipTrigger
                  render={<span className="flex items-center gap-0.5 text-warning" />}
                >
                  <FlameIcon className="size-3.5" /> heavy
                </TooltipTrigger>
                <TooltipContent>
                  Compacted more than twice; replans split work like this smaller.
                </TooltipContent>
              </Tooltip>
            )}
            {onPath && <span className="text-primary">critical path</span>}
          </span>
          {worker && (
            <span>
              <span className="text-primary">{worker.id}</span>, {minutesSince(worker.since)} min
              {worker.context ? `, ${Math.round(worker.context / 1000)}k context` : ""}:{" "}
              {step
                ? `${step.text}${step.of ? ` (${step.done ?? 0}/${step.of})` : ""}`
                : (worker.activity ?? "starting")}
            </span>
          )}
        </span>
      }
    />
  );
}

const TIER_STYLE: Record<Tier, string> = {
  communicator: "border-primary/50 text-primary",
  builder: "border-transparent bg-secondary text-secondary-foreground",
  grunt: "text-muted-foreground border-border",
};

/** Which tier runs a job, louder the more capable (and scarce) it is. */
export function TierBadge({ tier }: { tier: Tier }) {
  return (
    <Badge variant="outline" className={TIER_STYLE[tier]}>
      {tier}
    </Badge>
  );
}

/** A fact in the goal's header, with what it means on hover. */
function Fact({ explain, children }: { explain: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex items-center gap-1" />}>
        {children}
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{explain}</TooltipContent>
    </Tooltip>
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
        placeholder="What should change?"
        className="h-8 w-48"
      />
      <Button type="submit" size="sm" disabled={!why.trim()}>
        Replan
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setWhy(undefined)}>
        Never mind
      </Button>
    </form>
  );
}

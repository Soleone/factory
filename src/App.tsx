import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { GitForkIcon, PlusIcon } from "lucide-react";
import { ActivityView } from "@/ActivityView";
import { BlueprintsView } from "@/BlueprintsView";
import { api, useFactory, type Act } from "@/api";
import { CloneDialog } from "@/CloneDialog";
import type { Snapshot, UsageWindow as Used } from "@/backend/types.ts";
import { AgentSidebar } from "@/components/soleone/agent";
import { isInteractiveTarget } from "@/components/soleone/theme";
import { useRowKeys } from "@/rowKeys";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/soleone/tooltip/tooltip";
import { ThemePicker } from "@/components/soleone/theme-picker";
import { UsageRing, type UsageWindow } from "@/components/soleone/usage-ring/usage-ring";
import { Badge } from "@/components/ui/badge";
import { AccentBadge } from "@/components/variants/badge";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Button } from "@/components/ui/button";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollingTabsContent, TabbedDialogContent } from "@/components/variants/dialog";

import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSidebar } from "@/components/ui/sidebar";
import { CandidatesView } from "@/CandidatesView";
import { Controls } from "@/Controls";
import { GoalsView } from "@/GoalsView";
import { Logo } from "@/Logo";
import { JobDetails } from "@/JobDetails";
import { ChatSwitcher, jobReferences, PlanView, useChat } from "@/PlanView";
import { QueueView, queued } from "@/QueueView";
import { ResultsView } from "@/ResultsView";
import { SettingsDialog } from "@/SettingsDialog";
import { clock, runStart } from "@/format";
import { setQueryParam, useQueryParam } from "@/hooks/use-query-param";
import { inbox } from "@/inbox";
import { NewGoalForm } from "@/NewGoalForm";
import { NewJobForm } from "@/NewJobForm";
import { InboxView } from "@/InboxView";

// Links from before the tabs were merged still open what they named, before any view reads the query.
const old = new URLSearchParams(location.search).get("tab");
if (old === "candidates" || old === "blueprints") {
  setQueryParam("tab", "queue");
  setQueryParam("add", old);
} else if (old === "activity") {
  setQueryParam("tab", "results");
  setQueryParam("view", "activity");
}

export function App() {
  const { snapshot, error, act } = useFactory();
  /** The Live Agent draft, here so the Results tab can fill it with a question. */
  const [plan, setPlan] = useState("");
  const chat = useChat();
  /** The job a chip in the Live Agent's reply opened. */
  const [shownJob, setShownJob] = useState<string>();

  if (!snapshot)
    return (
      <div className="flex min-h-svh items-center justify-center gap-2 p-4 text-muted-foreground">
        {error ?? (
          <>
            <Spinner /> Loading
          </>
        )}
      </div>
    );

  const shown = snapshot.jobs.find((job) => job.id === shownJob);
  return (
    // The agent sits beside every tab, and stays mounted so a reply keeps streaming while it's closed.
    <AgentSidebar
      title="Live Agent"
      header={<ChatSwitcher chat={chat} />}
      busy={chat.transcript.busy}
      agent={
        <PlanView
          chat={chat}
          settings={snapshot.settings}
          prompt={plan}
          onPromptChange={setPlan}
          references={jobReferences(snapshot, setShownJob)}
        />
      }
    >
      <Factory snapshot={snapshot} error={error} act={act} onAsk={setPlan} />
      <Dialog open={shown !== undefined} onOpenChange={(open) => !open && setShownJob(undefined)}>
        {shown && (
          <TabbedDialogContent className="h-[min(48rem,calc(100dvh-8rem))] sm:max-w-5xl">
            <JobDetails item={shown.item} job={shown} snapshot={snapshot} act={act} />
          </TabbedDialogContent>
        )}
      </Dialog>
    </AgentSidebar>
  );
}

function Factory({
  snapshot,
  error,
  act,
  onAsk,
}: {
  snapshot: Snapshot;
  error: string | undefined;
  act: Act;
  onAsk: (question: string) => void;
}) {
  const { stopped, ready } = inbox(snapshot);
  // Decided once, so the page doesn't jump to Queue when the last question gets answered.
  const [landing] = useState(stopped.length > 0 ? "inbox" : "queue");
  const [tab, setTab] = useQueryParam("tab", landing);
  const [view, setView] = useQueryParam("view", "results");
  const [adding, setAdding] = useQueryParam("add", "");
  const [project, setProject] = useState<string | null>(null);
  const [projects, setProjects] = useState<string[]>([]);
  const [projectRefresh, setProjectRefresh] = useState(0);
  const [cloneOpen, setCloneOpen] = useState(false);
  const cloneTrigger = useRef<HTMLButtonElement>(null);
  const candidatesAt = snapshot.candidates.at;

  useEffect(() => {
    const controller = new AbortController();
    // Keep the last list if the server is briefly unavailable.
    void api.projects(controller.signal).then(
      (paths) => {
        if (!controller.signal.aborted) setProjects(paths);
      },
      () => {},
    );
    return () => controller.abort();
  }, [candidatesAt, projectRefresh]);

  useGoKeys(setTab);
  useRowKeys();
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  /** Starts the Live Agent chat with a question about a result. */
  const ask = (question: string) => {
    onAsk(question);
    (isMobile ? setOpenMobile : setOpen)(true);
  };
  const { on, status } = snapshot;
  const goals = snapshot.jobs.filter(
    (job) => job.goal && job.state !== "removed" && job.state !== "done",
  ).length;
  const lined = Object.values(queued(snapshot.jobs)).flat().length;

  const run =
    on && status
      ? [
          `since ${clock(runStart(status.run))}`,
          status.until && `until ${clock(status.until)}`,
          // Only what's happening now; the limit setting itself lives in Settings.
          ...status.pools.map((pool) =>
            pool.stopped
              ? `${pool.name} out of limits`
              : pool.until
                ? `${pool.name} sleeps until ${clock(pool.until)}`
                : undefined,
          ),
        ]
          .filter(Boolean)
          .join(" · ")
      : "";

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-5xl flex-col gap-6 p-4">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex flex-1 items-center gap-2">
          <h1 className="flex items-center gap-2 font-heading text-xl font-semibold">
            <Logo working={on} />
            Factory
          </h1>
          {on ? <AccentBadge>on</AccentBadge> : <Badge variant="outline">off</Badge>}
          {Object.entries(snapshot.usage).map(([pool, usage]) => (
            <UsageRing
              key={pool}
              provider={pool === "openai-codex" ? "openai" : "claude"}
              fiveHour={left(usage.fiveHour)}
              sevenDay={left(usage.sevenDay)}
              asOf={staleAt(usage.at)}
            />
          ))}
          <span className="text-sm text-muted-foreground">{run}</span>
        </div>
        <Controls snapshot={snapshot} act={act} />
        <Button ref={cloneTrigger} variant="outline" size="sm" onClick={() => setCloneOpen(true)}>
          <GitForkIcon /> Clone
        </Button>
        <div className="flex items-center gap-1">
          <ThemePicker />
          <SettingsDialog snapshot={snapshot} act={act} />
        </div>
      </header>
      {error && (
        <p role="alert" className="text-sm wrap-anywhere whitespace-pre-line text-destructive">
          {error}
        </p>
      )}
      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex items-center gap-2">
          {/* The tabs don't fit a phone; they scroll on their own rather than the page. */}
          <div className="min-w-0 overflow-x-auto overflow-y-hidden">
            <TabsList>
              <Tab value="inbox">
                Inbox
                {stopped.length > 0 ? (
                  <AccentBadge>{stopped.length + ready.length}</AccentBadge>
                ) : (
                  <Count n={ready.length} />
                )}
              </Tab>
              <Tab value="queue">
                Queue <Count n={lined} />
              </Tab>
              <Tab value="goals">
                Goals <Count n={goals} />
              </Tab>
              <Tab value="results">Results</Tab>
            </TabsList>
          </div>
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => setAdding("job")}>
            <PlusIcon /> Add work
          </Button>
        </div>
        <TabsContent value="inbox">
          <InboxView
            snapshot={snapshot}
            act={act}
            onAsk={ask}
            onOpenGoal={(id) => {
              setQueryParam("goal", id);
              setTab("goals");
            }}
          />
        </TabsContent>
        <TabsContent value="queue">
          <QueueView snapshot={snapshot} act={act} onAdd={setAdding} />
        </TabsContent>
        <TabsContent value="goals">
          <GoalsView snapshot={snapshot} act={act} />
        </TabsContent>
        <TabsContent value="results">
          <div className="pt-2">
            <Tabs value={view} onValueChange={setView}>
              <TabsList variant="line">
                <TabsTrigger value="results">Results</TabsTrigger>
                <TabsTrigger value="activity">Activity</TabsTrigger>
              </TabsList>
              <TabsContent value="results">
                <ResultsView
                  snapshot={snapshot}
                  act={act}
                  onAsk={ask}
                  projects={projects}
                  project={project}
                  onProjectChange={setProject}
                />
              </TabsContent>
              <TabsContent value="activity">
                <ActivityView snapshot={snapshot} act={act} />
              </TabsContent>
            </Tabs>
          </div>
        </TabsContent>
      </Tabs>
      <CloneDialog
        act={act}
        open={cloneOpen}
        onOpenChange={setCloneOpen}
        onCloned={() => setProjectRefresh((current) => current + 1)}
        finalFocus={cloneTrigger}
      />
      <Dialog open={adding !== ""} onOpenChange={(open) => !open && setAdding("")}>
        <TabbedDialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Add work</DialogTitle>
          </DialogHeader>
          <Tabs className="min-h-0" value={adding} onValueChange={setAdding}>
            <TabsList variant="line">
              <TabsTrigger value="job">Job</TabsTrigger>
              <TabsTrigger value="goal">Goal</TabsTrigger>
              <TabsTrigger value="candidates">Candidates</TabsTrigger>
              <TabsTrigger value="blueprints">Blueprints</TabsTrigger>
            </TabsList>
            <ScrollingTabsContent value="goal">
              <NewGoalForm
                act={act}
                onCreated={(id) => {
                  setAdding("");
                  setQueryParam("goal", id);
                  setTab("goals");
                }}
              />
            </ScrollingTabsContent>
            <ScrollingTabsContent value="candidates" className="flex flex-col overflow-hidden">
              <CandidatesView
                snapshot={snapshot}
                act={act}
                projects={projects}
                project={project}
                onProjectChange={setProject}
              />
            </ScrollingTabsContent>
            <ScrollingTabsContent value="job">
              <NewJobForm act={act} onQueued={() => setAdding("")} />
            </ScrollingTabsContent>
            <ScrollingTabsContent value="blueprints">
              <BlueprintsView act={act} />
            </ScrollingTabsContent>
          </Tabs>
        </TabbedDialogContent>
      </Dialog>
    </div>
  );
}

/** The key after `g` that jumps to each tab. */
const GO_KEYS = { inbox: "i", queue: "q", goals: "g", results: "r" };

/** `g` then a tab's key jumps to that tab, unless the keys go to a field or a dialog. */
function useGoKeys(go: (tab: string) => void) {
  const jump = useEffectEvent(go);
  useEffect(() => {
    let armed = 0;
    const listen = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      if (isInteractiveTarget(event.target)) return;
      const tab =
        Date.now() - armed < 1000 &&
        Object.entries(GO_KEYS).find(([, key]) => key === event.key)?.[0];
      armed = 0;
      if (tab) {
        event.preventDefault();
        jump(tab);
      } else if (event.key === "g") armed = Date.now();
    };
    window.addEventListener("keydown", listen);
    return () => window.removeEventListener("keydown", listen);
  }, []);
}

/** A main tab, with its shortcut on hover. */
function Tab({ value, children }: { value: keyof typeof GO_KEYS; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<TabsTrigger value={value} />}>{children}</TooltipTrigger>
      <TooltipContent>
        <KbdGroup>
          <Kbd>g</Kbd>
          <Kbd>{GO_KEYS[value]}</Kbd>
        </KbdGroup>
      </TooltipContent>
    </Tooltip>
  );
}

/** A tab's quiet count; none when there's nothing. */
function Count({ n }: { n: number }) {
  return n > 0 ? <span className="font-normal text-muted-foreground tabular-nums">{n}</span> : null;
}

// Reads come every minute, so one this old means they're failing, most often on an expired token.
const staleAt = (at: number) => (Date.now() - at > 3 * 60_000 ? at : undefined);
// An old read may predate a reset, after which the window is whole again.
const left = ({ used, resets }: Used): UsageWindow =>
  resets !== undefined && resets < Date.now() ? { left: 100 } : { left: 100 - used, resets };

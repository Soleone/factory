import { useState } from "react";
import { Activity, Inbox, ListOrdered, PackageCheck, Workflow } from "lucide-react";
import { ActivityView } from "@/ActivityView";
import { useFactory, type Act } from "@/api";
import type { Snapshot } from "@/backend/types.ts";
import { AgentSidebar } from "@/components/soleone/agent";
import { ThemePicker } from "@/components/soleone/theme-picker";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSidebar } from "@/components/ui/sidebar";
import { CandidatesView } from "@/CandidatesView";
import { Controls } from "@/Controls";
import { GoalsView } from "@/GoalsView";
import { Logo } from "@/Logo";
import { PlanView } from "@/PlanView";
import { QueueView } from "@/QueueView";
import { ResultsView } from "@/ResultsView";
import { SettingsDialog } from "@/SettingsDialog";
import { clock, runStart } from "@/format";
import { useQueryParam } from "@/hooks/use-query-param";

export function App() {
  const { snapshot, error, act } = useFactory();
  /** The Live Agent draft, here so the Results tab can fill it with a question. */
  const [plan, setPlan] = useState("");

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

  return (
    // The agent sits beside every tab, and stays mounted so a reply keeps streaming while it's closed.
    <AgentSidebar
      title="Live Agent"
      agent={
        <PlanView agent={snapshot.settings.chat.agent} prompt={plan} onPromptChange={setPlan} />
      }
    >
      <Factory snapshot={snapshot} error={error} act={act} onAsk={setPlan} />
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
  const [tab, setTab] = useQueryParam("tab", "queue");
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  const { on, status } = snapshot;
  const goals = snapshot.jobs.filter(
    (job) => job.goal && job.state !== "removed" && job.state !== "done",
  );
  const waiting = goals.filter((goal) => goal.blocked === "checkpoint").length;
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
          <Badge variant={on ? "accent" : "outline"}>{on ? "on" : "off"}</Badge>
          <span className="text-sm text-muted-foreground">{run}</span>
        </div>
        <Controls snapshot={snapshot} act={act} />
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
              <TabsTrigger value="queue">
                <ListOrdered />
                Queue
              </TabsTrigger>
              <TabsTrigger value="goals">
                <Workflow />
                Goals
                {waiting > 0 && <Badge variant="accent">{waiting}</Badge>}
              </TabsTrigger>
              <TabsTrigger value="candidates">
                <Inbox />
                Candidates
              </TabsTrigger>
              <TabsTrigger value="results">
                <PackageCheck />
                Results
              </TabsTrigger>
              <TabsTrigger value="activity">
                <Activity />
                Activity
              </TabsTrigger>
            </TabsList>
          </div>
          <div className="ml-auto" />
        </div>
        <TabsContent value="queue">
          <QueueView snapshot={snapshot} act={act} onCandidates={() => setTab("candidates")} />
        </TabsContent>
        <TabsContent value="goals">
          <GoalsView snapshot={snapshot} act={act} />
        </TabsContent>
        <TabsContent value="candidates">
          <CandidatesView snapshot={snapshot} act={act} />
        </TabsContent>
        <TabsContent value="activity">
          <ActivityView snapshot={snapshot} act={act} />
        </TabsContent>
        <TabsContent value="results">
          <ResultsView
            snapshot={snapshot}
            act={act}
            onAsk={(question) => {
              onAsk(question);
              (isMobile ? setOpenMobile : setOpen)(true);
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

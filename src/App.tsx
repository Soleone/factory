import { useState } from "react";
import { Inbox, ListOrdered, PackageCheck } from "lucide-react";
import { useFactory, type Act } from "@/api";
import type { Snapshot } from "@/backend/types.ts";
import { AgentSidebar } from "@/components/soleone/agent";
import { ThemePicker } from "@/components/soleone/theme-picker";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSidebar } from "@/components/ui/sidebar";
import { CandidatesView } from "@/CandidatesView";
import { CloneDialog } from "@/CloneDialog";
import { Controls } from "@/Controls";
import { Logo } from "@/Logo";
import { PlanView } from "@/PlanView";
import { QueueView } from "@/QueueView";
import { ResultsView } from "@/ResultsView";
import { SettingsDialog } from "@/SettingsDialog";
import { clock, runStart } from "@/format";

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
  const [tab, setTab] = useState("queue");
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  const { on, status } = snapshot;
  const queued = snapshot.jobs.filter((job) => job.state === "queued").length;
  const failed = snapshot.jobs.filter((job) => job.state === "failed").length;
  const run =
    on && status
      ? [
          `since ${clock(runStart(status.run))}`,
          status.limit === null
            ? "always waits for usage resets"
            : status.limit === 1
              ? "stops at usage limits"
              : `waits for ${status.limit - 1} usage reset${status.limit > 2 ? "s" : ""}`,
          status.until && `until ${clock(status.until)}`,
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
          <TabsList>
            <TabsTrigger value="queue">
              <ListOrdered />
              Queue{queued ? ` (${queued})` : ""}
            </TabsTrigger>
            <TabsTrigger value="candidates">
              <Inbox />
              Candidates
            </TabsTrigger>
            <TabsTrigger value="results">
              <PackageCheck />
              Results{failed ? ` (${failed} failed)` : ""}
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto">
            <CloneDialog act={act} />
          </div>
        </div>
        <TabsContent value="queue">
          <QueueView snapshot={snapshot} act={act} onCandidates={() => setTab("candidates")} />
        </TabsContent>
        <TabsContent value="candidates">
          <CandidatesView snapshot={snapshot} act={act} />
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

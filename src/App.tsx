import { useState } from "react";
import { Compass, ListOrdered, MessageSquare, PackageCheck } from "lucide-react";
import { useFactory } from "@/api";
import { ThemePicker } from "@/components/soleone/theme-picker";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BrowseView } from "@/BrowseView";
import { Controls } from "@/Controls";
import { PlanView } from "@/PlanView";
import { QueueView } from "@/QueueView";
import { ResultsView } from "@/ResultsView";
import { SettingsDialog } from "@/SettingsDialog";
import { clock, runStart } from "@/format";

export function App() {
  const { snapshot, error, act } = useFactory();
  const [tab, setTab] = useState("queue");

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

  const { on, status } = snapshot;
  const queued = snapshot.jobs.filter((job) => job.state === "queued").length;
  const failed = snapshot.jobs.filter((job) => job.state === "failed").length;
  const run =
    on && status
      ? [
          `since ${clock(runStart(status.run))}`,
          `limit ${status.limit ?? "none"}`,
          status.until && `until ${clock(status.until)}`,
        ]
          .filter(Boolean)
          .join(" · ")
      : "";

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-5xl flex-col gap-6 p-4">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex flex-1 items-center gap-3">
          <h1 className="flex items-center gap-2 font-heading text-xl font-semibold">
            <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={32} height={32} />
            factory
          </h1>
          <Badge variant={on ? "default" : "outline"}>{on ? "on" : "off"}</Badge>
          <span className="text-sm text-muted-foreground">{run}</span>
        </div>
        <Controls snapshot={snapshot} act={act} />
        <div className="flex items-center gap-1">
          <SettingsDialog snapshot={snapshot} act={act} />
          <ThemePicker />
        </div>
      </header>
      {error && (
        <p role="alert" className="text-sm wrap-anywhere whitespace-pre-line text-destructive">
          {error}
        </p>
      )}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="queue">
            <ListOrdered />
            Queue{queued ? ` (${queued})` : ""}
          </TabsTrigger>
          <TabsTrigger value="browse">
            <Compass />
            Browse
          </TabsTrigger>
          <TabsTrigger value="results">
            <PackageCheck />
            Results{failed ? ` (${failed} failed)` : ""}
          </TabsTrigger>
          <TabsTrigger value="plan">
            <MessageSquare />
            Plan
          </TabsTrigger>
        </TabsList>
        <TabsContent value="queue">
          <QueueView snapshot={snapshot} act={act} onBrowse={() => setTab("browse")} />
        </TabsContent>
        <TabsContent value="browse">
          <BrowseView snapshot={snapshot} act={act} />
        </TabsContent>
        <TabsContent value="results">
          <ResultsView snapshot={snapshot} act={act} />
        </TabsContent>
        {/* Kept mounted so a reply keeps streaming in while another tab is open. */}
        <TabsContent value="plan" keepMounted>
          <PlanView />
        </TabsContent>
      </Tabs>
    </div>
  );
}

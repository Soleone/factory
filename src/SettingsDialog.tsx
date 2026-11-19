import { type ComponentProps, useEffect, useState } from "react";
import { Settings2 } from "lucide-react";
import { api, type Act } from "@/api";
import type { Settings, Snapshot } from "@/backend/types.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AGENT_NAMES } from "@/backend/agents.ts";
import { agentName, repoName } from "@/format";
import { Choice, RunFields, TuningFields } from "@/RunFields";

/** A gear button that opens the defaults every run starts from, and what auto mode may queue. */
export function SettingsDialog({ snapshot, act }: { snapshot: Snapshot; act: Act }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="icon" aria-label="Settings" />}>
        <Settings2 />
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Defaults for every run, and what auto mode may queue. Closing without saving discards
            changes.
          </DialogDescription>
        </DialogHeader>
        <SettingsForm snapshot={snapshot} act={act} onSaved={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** Mounted only while the dialog is open, so every opening starts from the saved settings. */
function SettingsForm({
  snapshot,
  act,
  onSaved,
}: {
  snapshot: Snapshot;
  act: Act;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Settings>(snapshot.settings);
  const [plays, setPlays] = useState<string[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  // The Auto switch in the header saves on its own; this form never changes it.
  const current = { ...draft, auto: { ...draft.auto, on: snapshot.settings.auto.on } };
  const unchanged = JSON.stringify(current) === JSON.stringify(snapshot.settings);

  useEffect(() => {
    void api.candidates().then((candidates) => {
      setPlays([...new Set(candidates.items.map((item) => item.play))].sort());
      setRepos([...new Set(candidates.items.map((item) => item.repo))].sort());
    });
  }, [snapshot.candidates.at]);

  const auto = draft.auto;
  const setAuto = (change: Partial<Settings["auto"]>) =>
    setDraft({ ...draft, auto: { ...auto, ...change } });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void act(async () => {
          await api.saveSettings(current);
          onSaved();
        });
      }}
    >
      <Tabs defaultValue="runs">
        <TabsList>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="auto">Auto mode</TabsTrigger>
          <TabsTrigger value="chat">Live Agent</TabsTrigger>
        </TabsList>
        <div className="mt-2 grid">
          <StackedTabsContent value="runs">
            <FieldGroup>
              <RunFields value={draft} onChange={(run) => setDraft({ ...draft, ...run })} />
              <Field orientation="horizontal">
                <FieldLabel htmlFor="timeout">Minutes before an agent is stopped</FieldLabel>
                <Input
                  id="timeout"
                  type="number"
                  className="w-20"
                  min={1}
                  value={draft.timeout}
                  onChange={(event) => setDraft({ ...draft, timeout: Number(event.target.value) })}
                />
              </Field>
            </FieldGroup>
          </StackedTabsContent>
          <StackedTabsContent value="auto">
            <FieldGroup>
              <FieldDescription>
                While the factory is on, auto mode keeps up to 5 jobs per agent queued, cheapest
                attention first, and never queues a candidate that already had a job. An empty
                filter allows everything.
              </FieldDescription>
              <Field>
                <FieldLabel>Levels</FieldLabel>
                <ToggleGroup
                  multiple
                  variant="outline"
                  value={auto.levels}
                  onValueChange={(levels) => setAuto({ levels })}
                >
                  {["auto", "skim", "decide"].map((level) => (
                    <ToggleGroupItem key={level} value={level}>
                      {level}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
              <Field>
                <FieldLabel>Plays</FieldLabel>
                <ToggleGroup
                  multiple
                  variant="outline"
                  className="flex-wrap"
                  value={auto.plays}
                  onValueChange={(plays) => setAuto({ plays })}
                >
                  {plays.map((play) => (
                    <ToggleGroupItem key={play} value={play}>
                      {play}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
              <Field>
                <FieldLabel>Repos</FieldLabel>
                <ToggleGroup
                  multiple
                  variant="outline"
                  className="flex-wrap"
                  value={auto.repos}
                  onValueChange={(repos) => setAuto({ repos })}
                >
                  {repos.map((repo) => (
                    <ToggleGroupItem key={repo} value={repo}>
                      {repoName(repo)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
            </FieldGroup>
          </StackedTabsContent>
          <StackedTabsContent value="chat">
            <FieldGroup>
              <FieldDescription>
                The agent you plan the queue with. Changing it starts a new chat.
              </FieldDescription>
              <Field orientation="horizontal">
                <Choice
                  label="Chat agent"
                  className="w-24 flex-none"
                  items={AGENT_NAMES.map((name) => ({ value: name, label: agentName(name) }))}
                  value={draft.chat.agent}
                  onChange={(agent) => agent && setDraft({ ...draft, chat: { agent } })}
                />
                <TuningFields
                  agent={draft.chat.agent}
                  value={draft.chat}
                  onChange={(tuning) =>
                    setDraft({ ...draft, chat: { ...tuning, agent: draft.chat.agent } })
                  }
                />
              </Field>
            </FieldGroup>
          </StackedTabsContent>
        </div>
      </Tabs>
      <DialogFooter>
        <Button type="submit" disabled={unchanged}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Every panel stays mounted in the same grid cell, so the dialog keeps the tallest panel's height
 * and its top never moves when switching tabs.
 */
function StackedTabsContent(props: ComponentProps<typeof TabsContent>) {
  return (
    <TabsContent
      keepMounted
      hidden={false}
      className="col-start-1 row-start-1 data-hidden:invisible"
      {...props}
    />
  );
}

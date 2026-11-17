import { useState } from "react";
import { api, type Act } from "@/api";
import type { Snapshot } from "@/backend/types.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { RunFields, type Run } from "@/RunFields";

/** The two switches: auto mode (fills the queue) and the factory itself (works it). */
export function Controls({ snapshot, act }: { snapshot: Snapshot; act: Act }) {
  const { settings, on } = snapshot;
  const [run, setRun] = useState<Run>();

  return (
    <div className="flex items-center gap-4">
      <Field orientation="horizontal">
        <Switch
          id="auto"
          checked={settings.auto.on}
          onCheckedChange={(checked) =>
            act(() => api.saveSettings({ ...settings, auto: { ...settings.auto, on: checked } }))
          }
        />
        <FieldLabel htmlFor="auto">Auto</FieldLabel>
      </Field>
      {on ? (
        <Button variant="outline" onClick={() => act(api.turnOff)}>
          Turn off
        </Button>
      ) : (
        <Button
          onClick={() =>
            setRun({ agents: settings.agents, limit: settings.limit, until: settings.until })
          }
        >
          Turn on
        </Button>
      )}
      <Dialog open={run !== undefined} onOpenChange={(open) => !open && setRun(undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn the factory on</DialogTitle>
            <DialogDescription>
              For this run only; the defaults are under Settings. Your picks go first, then what
              auto mode queues.
            </DialogDescription>
          </DialogHeader>
          {run && <RunFields value={run} onChange={setRun} />}
          <DialogFooter>
            <Button
              disabled={!run || Object.keys(run.agents).length === 0}
              onClick={() =>
                act(async () => {
                  await api.turnOn(run!);
                  setRun(undefined);
                })
              }
            >
              Turn on
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

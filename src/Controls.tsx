import { useState } from "react";
import { api, type Act } from "@/api";
import type { Snapshot } from "@/backend/types.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AnchoredDialogContent } from "@/components/variants/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/soleone/tooltip/tooltip";
import { RunFields, type Run } from "@/RunFields";

/** Auto mode (fills the queue) and the factory's power button (works it). */
export function Controls({ snapshot, act }: { snapshot: Snapshot; act: Act }) {
  const { settings, on } = snapshot;
  const [run, setRun] = useState<Run>();

  return (
    <div className="flex items-center gap-4">
      <Tooltip>
        <TooltipTrigger render={<Field orientation="horizontal" />}>
          <Checkbox
            id="auto"
            checked={settings.auto.on}
            onCheckedChange={(checked) =>
              act(() => api.saveSettings({ ...settings, auto: { ...settings.auto, on: checked } }))
            }
          />
          <FieldLabel htmlFor="auto">Auto</FieldLabel>
        </TooltipTrigger>
        <TooltipContent>
          Keep the queue topped up from candidates while the factory is on
        </TooltipContent>
      </Tooltip>
      <Tooltip disabled={on}>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              onClick={(event) => {
                const defaults = {
                  agents: settings.agents,
                  limit: settings.limit,
                  until: settings.until,
                };
                if (on) void act(api.turnOff);
                else if (event.shiftKey) void act(() => api.turnOn(defaults));
                else setRun(defaults);
              }}
            />
          }
        >
          {on ? "Turn off" : "Turn on"}
        </TooltipTrigger>
        <TooltipContent>Shift-click to turn on with your defaults</TooltipContent>
      </Tooltip>
      <Dialog open={run !== undefined} onOpenChange={(open) => !open && setRun(undefined)}>
        <AnchoredDialogContent>
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
        </AnchoredDialogContent>
      </Dialog>
    </div>
  );
}

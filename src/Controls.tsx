import { PowerIcon } from "lucide-react";
import { useState } from "react";
import { api, type Act } from "@/api";
import {
  presetId,
  workersOf,
  type Preset,
  type RunRequest,
  type Snapshot,
} from "@/backend/types.ts";
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
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/soleone/tooltip/tooltip";
import { RunFields } from "@/RunFields";
import { WorkerName } from "@/WorkerName";

/** Auto mode (fills the queue) and the factory's power button (works it). */
export function Controls({ snapshot, act }: { snapshot: Snapshot; act: Act }) {
  const { settings, on } = snapshot;
  const [run, setRun] = useState<RunRequest>();
  const count = (preset: Preset) => run?.workers[presetId(preset)] ?? workersOf(preset);

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
                  workers: {},
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
          <PowerIcon data-icon="inline-start" />
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
          {run && (
            <FieldGroup>
              <FieldSet>
                <FieldLegend variant="label">Workers</FieldLegend>
                {settings.presets.map((preset) => {
                  const id = presetId(preset);
                  return (
                    <Field key={id} orientation="horizontal">
                      <FieldLabel htmlFor={`run-${id}`}>
                        <WorkerName of={preset} />
                      </FieldLabel>
                      <Input
                        id={`run-${id}`}
                        type="number"
                        min={0}
                        className="w-20"
                        value={count(preset)}
                        onChange={(event) =>
                          setRun({
                            ...run,
                            workers: { ...run.workers, [id]: Number(event.target.value) },
                          })
                        }
                      />
                    </Field>
                  );
                })}
              </FieldSet>
              <RunFields value={run} onChange={setRun} />
            </FieldGroup>
          )}
          <DialogFooter>
            <Button
              disabled={!run || settings.presets.every((preset) => count(preset) === 0)}
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

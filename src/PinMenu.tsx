import { ChevronDownIcon } from "lucide-react";
import { api, type Act } from "@/api";
import { presetId, TIERS, workersOf, type Job, type Pin, type Settings } from "@/backend/types.ts";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TierBadge } from "@/TierBadge";
import { WorkerName } from "@/WorkerName";

/**
 * What a job may run on: any free worker, a role (a tier, in code), or one worker. A worker pin
 * carries its tuning, so a run without that worker still runs it on a free worker of its agent.
 */
export function PinMenuItems({
  settings,
  onPin,
}: {
  settings: Settings;
  onPin: (pin: Pin) => void;
}) {
  return (
    <>
      <DropdownMenuItem onClick={() => onPin({})}>
        Any free worker <span className="ml-auto text-xs text-muted-foreground">default</span>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>Role</DropdownMenuLabel>
        {TIERS.map((tier) => (
          <DropdownMenuItem key={tier} onClick={() => onPin({ tier })}>
            {tier}
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>Worker</DropdownMenuLabel>
        {settings.presets.map((preset) => (
          <DropdownMenuItem
            key={presetId(preset)}
            onClick={() =>
              onPin({
                preset: presetId(preset),
                agent: preset.agent,
                model: preset.model,
                effort: preset.effort,
              })
            }
          >
            <WorkerName of={preset} />
            {workersOf(preset) === 0 && (
              <span className="ml-auto pl-3 text-xs text-muted-foreground">not running</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>
    </>
  );
}

/**
 * A waiting job's role or worker, changeable from the same menu until a worker takes it. A paused
 * job can move too, after a warning: it loses its session and starts fresh.
 */
export function PinChip({ job, settings, act }: { job: Job; settings: Settings; act: Act }) {
  const preset = settings.presets.find((each) => presetId(each) === job.preset);
  const current = job.tier ? (
    <TierBadge tier={job.tier} more />
  ) : (
    <Badge variant={job.agent ? "outline" : "ghost"}>
      {job.agent ? <WorkerName of={preset ?? { ...job, agent: job.agent }} /> : "any"}
      <ChevronDownIcon data-icon="inline-end" />
    </Badge>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<button type="button" aria-label="Run on" className="inline-flex" />}
      >
        {current}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto">
        <PinMenuItems
          settings={settings}
          onPin={(pin) => {
            if (
              job.open &&
              !window.confirm(
                "This job already started and has context. Reassigning it drops that session and starts fresh. Continue?",
              )
            )
              return;
            void act(() => api.pin(job.id, pin));
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

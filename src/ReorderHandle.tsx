import { GripVerticalIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/soleone/tooltip/tooltip";

/**
 * The only place a row drags from, so touching the rest of the row scrolls the page; `grip` takes
 * the drag listeners. Also keeps a keyboard path.
 */
export function ReorderHandle({
  label,
  index,
  count,
  onMove,
  grip,
}: {
  label: string;
  index: number;
  count: number;
  onMove: (target: number) => void;
  grip?: ComponentProps<"span">;
}) {
  if (count < 2)
    return <GripVerticalIcon aria-hidden="true" className="size-4 text-muted-foreground" />;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            {...grip}
            role="group"
            tabIndex={0}
            aria-label={`Reorder ${label} with the Up and Down arrow keys`}
            aria-keyshortcuts="ArrowUp ArrowDown"
            className="shrink-0 cursor-grab touch-none rounded-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
            onKeyDown={(event) => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault();
              event.stopPropagation();
              const target = index + (event.key === "ArrowUp" ? -1 : 1);
              if (target >= 0 && target < count) onMove(target);
            }}
          />
        }
      >
        <GripVerticalIcon aria-hidden="true" className="size-4" />
      </TooltipTrigger>
      <TooltipContent>Drag to reorder, or focus and use the Up and Down arrow keys</TooltipContent>
    </Tooltip>
  );
}

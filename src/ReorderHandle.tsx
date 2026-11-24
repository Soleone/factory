import { GripVerticalIcon } from "lucide-react";

/** Keep a keyboard path for lists that use native drag and drop. */
export function ReorderHandle({
  label,
  index,
  count,
  onMove,
}: {
  label: string;
  index: number;
  count: number;
  onMove: (target: number) => void;
}) {
  if (count < 2)
    return <GripVerticalIcon aria-hidden="true" className="size-4 text-muted-foreground" />;

  return (
    <span
      role="group"
      tabIndex={0}
      aria-label={`Reorder ${label} with the Up and Down arrow keys`}
      aria-keyshortcuts="ArrowUp ArrowDown"
      title="Drag to reorder, or focus and use the Up and Down arrow keys"
      className="shrink-0 cursor-grab rounded-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
      onKeyDown={(event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        event.stopPropagation();
        const target = index + (event.key === "ArrowUp" ? -1 : 1);
        if (target >= 0 && target < count) onMove(target);
      }}
    >
      <GripVerticalIcon aria-hidden="true" className="size-4" />
    </span>
  );
}

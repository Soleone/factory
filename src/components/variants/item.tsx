import type { ComponentProps } from "react";
import { cn } from "cn";
import { Item, ItemGroup } from "@/components/ui/item";

/** A flat list row like the tasks app's: no border, a fill on hover and a thin ring on keyboard focus. */
export function RowItem({ className, ...props }: ComponentProps<typeof Item>) {
  return (
    <Item
      className={cn(
        "hover:bg-muted/50 focus-visible:border-transparent focus-visible:bg-muted/50 focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      {...props}
    />
  );
}

/** Rows that touch, so a list reads as one block and the fills alone set rows apart. */
export function RowGroup({ className, ...props }: ComponentProps<typeof ItemGroup>) {
  return <ItemGroup className={cn("gap-0 has-data-[size=sm]:gap-0", className)} {...props} />;
}

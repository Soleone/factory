import type { ComponentProps } from "react";
import { cn } from "cn";
import { Item, ItemGroup } from "@/components/ui/item";

/** A list row as its own soft card: a muted fill that deepens on hover and a primary tint, not a ring, on keyboard focus. */
export function RowItem({ className, ...props }: ComponentProps<typeof Item>) {
  return (
    <Item
      variant="muted"
      className={cn(
        "hover:bg-muted focus-visible:border-transparent focus-visible:bg-primary/10 focus-visible:ring-0",
        className,
      )}
      {...props}
    />
  );
}

/** Rows a little apart, so each one reads as a thing of its own. */
export function RowGroup({ className, ...props }: ComponentProps<typeof ItemGroup>) {
  return <ItemGroup className={cn("gap-1.5 has-data-[size=sm]:gap-1.5", className)} {...props} />;
}

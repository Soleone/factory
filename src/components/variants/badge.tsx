import type { ComponentProps } from "react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";

/** A badge filled with the theme accent, for an "on" state or a count that needs attention. */
export function AccentBadge({ className, ...props }: ComponentProps<typeof Badge>) {
  return (
    <Badge className={cn("bg-(--om-accent) text-(--om-dark-background)", className)} {...props} />
  );
}

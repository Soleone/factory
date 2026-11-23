import type { ComponentProps } from "react";
import { cn } from "cn";
import { DialogContent } from "@/components/ui/dialog";

/**
 * Dialog content pinned near the top instead of centered, so its top edge stays put while the
 * content changes height (switching tabs, a field appearing) and only the bottom edge moves.
 */
export function AnchoredDialogContent({
  className,
  ...props
}: ComponentProps<typeof DialogContent>) {
  return (
    <DialogContent
      className={cn("top-16 max-h-[calc(100dvh-8rem)] translate-y-0 overflow-y-auto", className)}
      {...props}
    />
  );
}

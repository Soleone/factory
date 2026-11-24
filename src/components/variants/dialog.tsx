import type { ComponentProps } from "react";
import { cn } from "cn";
import { DialogContent } from "@/components/ui/dialog";
import { TabsContent } from "@/components/ui/tabs";

/**
 * Dialog content pinned near the top instead of centered, so its top edge stays put while the
 * content changes height (switching tabs, a field appearing) and only the bottom edge moves. The
 * scrollbar's room is always kept, so content doesn't shift sideways when it starts to scroll.
 */
export function AnchoredDialogContent({
  className,
  ...props
}: ComponentProps<typeof DialogContent>) {
  return (
    <DialogContent
      className={cn(
        "top-16 max-h-[calc(100dvh-8rem)] translate-y-0 overflow-y-auto [scrollbar-gutter:stable]",
        className,
      )}
      {...props}
    />
  );
}

/** Tabbed dialog content whose header and tabs stay put while only the active panel scrolls. */
export function TabbedDialogContent({ className, ...props }: ComponentProps<typeof DialogContent>) {
  return (
    <AnchoredDialogContent
      className={cn("flex flex-col overflow-hidden [scrollbar-gutter:auto]", className)}
      {...props}
    />
  );
}

/** The panel of a `TabbedDialogContent`: the one part that scrolls, with the scrollbar's room kept. */
export function ScrollingTabsContent({ className, ...props }: ComponentProps<typeof TabsContent>) {
  return (
    <TabsContent
      className={cn("-m-1 min-h-0 overflow-y-auto p-1 [scrollbar-gutter:stable]", className)}
      {...props}
    />
  );
}

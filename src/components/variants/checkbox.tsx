import type { ComponentProps } from "react";
import { cn } from "cn";
import { Checkbox as StockCheckbox } from "@/components/ui/checkbox";

/**
 * A checkbox that fills with the foreground, so a ticked list doesn't light up in the accent.
 * Part-ticked (`indeterminate`) shows a dash: the stock indicator only has a tick.
 */
export function NeutralCheckbox({ className, ...props }: ComponentProps<typeof StockCheckbox>) {
  return (
    <StockCheckbox
      className={cn(
        "data-checked:border-foreground data-checked:bg-foreground data-checked:text-background dark:data-checked:bg-foreground",
        "data-indeterminate:border-foreground data-indeterminate:bg-foreground dark:data-indeterminate:bg-foreground data-indeterminate:before:h-0.5 data-indeterminate:before:w-2 data-indeterminate:before:rounded-full data-indeterminate:before:bg-background data-indeterminate:[&_svg]:hidden",
        className,
      )}
      {...props}
    />
  );
}

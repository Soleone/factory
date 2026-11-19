import type { ComponentProps } from "react";
import { cn } from "cn";
import { Checkbox as StockCheckbox } from "@/components/ui/checkbox";

/** A checkbox that fills with the foreground, so a ticked list doesn't light up in the accent. */
export function NeutralCheckbox({ className, ...props }: ComponentProps<typeof StockCheckbox>) {
  return (
    <StockCheckbox
      className={cn(
        "data-checked:border-foreground data-checked:bg-foreground data-checked:text-background dark:data-checked:bg-foreground",
        className,
      )}
      {...props}
    />
  );
}

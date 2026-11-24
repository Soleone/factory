import type { CSSProperties, ReactNode } from "react";
import {
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { RowItem } from "@/components/variants/item";

/**
 * One line in a list: a title, a muted line under it, and buttons on the right. Flat, filled on
 * hover; focusable for the list keys in `useRowKeys`, which find it by `data-row`.
 */
export function Row({
  leading,
  title,
  meta,
  below,
  progress,
  marked,
  children,
}: {
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  /** Blocks that can't sit in the description's paragraph, like a form. */
  below?: ReactNode;
  /** How much of its time a running job has used, from 0 to 1, as a bar along the bottom. */
  progress?: number;
  /** Draws a bar along the left edge, like for what ended since the last visit. */
  marked?: boolean;
  children?: ReactNode;
}) {
  return (
    <RowItem size="sm" tabIndex={-1} data-row className="relative overflow-hidden">
      {progress !== undefined && (
        <span
          aria-hidden
          className="absolute bottom-0 left-0 h-0.5 w-(--progress) bg-primary transition-all duration-700"
          style={{ "--progress": `${Math.min(progress, 1) * 100}%` } as CSSProperties}
        />
      )}
      {/* Here, not in `leading`: ItemMedia's translate would make the bar fill the icon instead. */}
      {marked && <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-foreground" />}
      {leading && <ItemMedia>{leading}</ItemMedia>}
      {/* min-w-0 lets long text truncate instead of wrapping the content under the icon. */}
      <ItemContent className="min-w-0">
        <ItemTitle>{title}</ItemTitle>
        {meta && <ItemDescription>{meta}</ItemDescription>}
        {below}
      </ItemContent>
      {/* A form below would center the actions on it; keep them on the title line. */}
      {children && (
        <ItemActions className={below ? "self-start" : undefined}>{children}</ItemActions>
      )}
    </RowItem>
  );
}

export function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

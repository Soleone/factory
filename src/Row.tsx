import type { CSSProperties, ReactNode } from "react";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";

/** One line in a list: a title, a muted line under it, and buttons on the right. */
export function Row({
  leading,
  title,
  meta,
  below,
  progress,
  children,
}: {
  leading?: ReactNode;
  title: ReactNode;
  meta: ReactNode;
  /** Blocks that can't sit in the description's paragraph, like a form. */
  below?: ReactNode;
  /** How much of its time a running job has used, from 0 to 1, as a bar along the bottom. */
  progress?: number;
  children?: ReactNode;
}) {
  return (
    <Item variant="outline" size="sm" className="relative overflow-hidden">
      {progress !== undefined && (
        <span
          aria-hidden
          className="absolute bottom-0 left-0 h-0.5 w-(--progress) bg-primary transition-all duration-700"
          style={{ "--progress": `${Math.min(progress, 1) * 100}%` } as CSSProperties}
        />
      )}
      {leading && <ItemMedia>{leading}</ItemMedia>}
      {/* min-w-0 lets long text truncate instead of wrapping the content under the icon. */}
      <ItemContent className="min-w-0">
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription>{meta}</ItemDescription>
        {below}
      </ItemContent>
      {children && <ItemActions>{children}</ItemActions>}
    </Item>
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

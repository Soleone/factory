import type { ReactNode } from "react";
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
  children,
}: {
  leading?: ReactNode;
  title: ReactNode;
  meta: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Item variant="outline" size="sm">
      {leading && <ItemMedia>{leading}</ItemMedia>}
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription>{meta}</ItemDescription>
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

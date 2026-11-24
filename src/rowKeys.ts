import { useEffect } from "react";

const NEXT = new Set(["j", "ArrowDown"]);
const PREVIOUS = new Set(["k", "ArrowUp"]);

/**
 * Keys for every list of rows on screen, in the open dialog if there is one, else the page:
 * j/k or the arrows move between rows, Home/End jump to the ends, Enter opens the row's title,
 * and Tab from a row reaches its buttons. Arrows only move from a row, so menus, tabs and toggle
 * groups keep their own.
 */
export function useRowKeys() {
  useEffect(() => {
    const listen = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target instanceof HTMLElement ? event.target : document.body;
      if (typing(target)) return;
      const current = target.closest<HTMLElement>("[data-row]");
      const onRow = target === current;
      if (event.key === "Enter" && onRow) {
        event.preventDefault();
        current.querySelector<HTMLElement>('[data-slot="item-title"] :is(button, a)')?.click();
        return;
      }
      const arrow = event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End";
      if (arrow && !onRow && target !== document.body) return;
      const rows = visibleRows(target);
      if (rows.length === 0) return;
      const at = current ? rows.indexOf(current) : -1;
      const next = NEXT.has(event.key)
        ? rows[Math.min(at + 1, rows.length - 1)]
        : PREVIOUS.has(event.key)
          ? rows[Math.max(at - 1, 0)]
          : event.key === "Home"
            ? rows[0]
            : event.key === "End"
              ? rows.at(-1)
              : undefined;
      if (!next) return;
      event.preventDefault();
      next.focus({ preventScroll: true });
      next.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", listen);
    return () => window.removeEventListener("keydown", listen);
  }, []);
}

/** Keys that belong to a field or to a widget with its own keys, like a menu or a select. */
function typing(target: HTMLElement) {
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
    target.closest('[role="menu"], [role="listbox"], [role="combobox"]') !== null
  );
}

/** The rows in the dialog the keys came from, else the topmost open one, else the page. */
function visibleRows(target: HTMLElement) {
  const scope =
    target.closest('[role="dialog"]') ??
    [...document.querySelectorAll('[role="dialog"][data-open]')].at(-1) ??
    document;
  return [...scope.querySelectorAll<HTMLElement>("[data-row]")].filter((row) =>
    row.checkVisibility(),
  );
}

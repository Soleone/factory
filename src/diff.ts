export type DiffRow = { text: string; old?: number; new?: number; file?: string };

/** Splits a unified diff into rows, numbering each hunk line by its old and new file lines. */
export function diffRows(diff: string): DiffRow[] {
  let old = 0;
  let next = 0;
  let inHunk = false;
  return diff.split("\n").map((text) => {
    if (text.startsWith("diff --git")) {
      inHunk = false;
      return { text, file: text.slice(text.indexOf(" b/") + 3) };
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(text);
    if (hunk) {
      inHunk = true;
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      return { text };
    }
    if (!inHunk || !text || text.startsWith("\\")) return { text };
    if (text.startsWith("+")) return { text, new: next++ };
    if (text.startsWith("-")) return { text, old: old++ };
    return { text, old: old++, new: next++ };
  });
}

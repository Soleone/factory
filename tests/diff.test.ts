import { expect, test } from "vite-plus/test";
import { diffRows } from "../src/diff.ts";

test("numbers hunk lines by old and new file line, and names each file", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,3 @@ fn",
    " same",
    "-gone",
    "--- removed dashes",
    "+added",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  expect(diffRows(diff).map(({ text: _text, ...rest }) => rest)).toEqual([
    { file: "src/a.ts" },
    {},
    {},
    {},
    { old: 10, new: 10 },
    { old: 11 },
    { old: 12 },
    { new: 11 },
    {},
    {},
  ]);
});

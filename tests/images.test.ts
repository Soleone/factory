import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  addImageRun,
  imageRunner,
  readImageRuns,
  readReply,
  useImage,
} from "../src/backend/images.ts";
import { readJobs } from "../src/backend/jobs.ts";
import type { ImageRun } from "../src/backend/types.ts";
import { scratch, script } from "./harness.ts";

const PNG = Buffer.from("fake png").toString("base64");

/** A fake codex that saves three images under its thread, like image_gen does, and replies with `reply`. */
function fakeCodex(reply: string, thread = "t1"): { command: string; calls: string } {
  const bin = mkdtempSync(join(scratch, "codex-"));
  const home = mkdtempSync(join(scratch, "codex-home-"));
  process.env.CODEX_HOME = home;
  const made = join(home, "generated_images", thread);
  script(
    bin,
    "codex",
    [
      `echo "$*" > ${bin}/args; cat > ${bin}/prompt`,
      `mkdir -p ${made}; echo a > ${made}/a.png; echo b > ${made}/b.png; echo c > ${made}/c.png`,
      // -o names the reply file: the argument after it.
      `while [ "$1" != "-o" ]; do shift; done; printf '%s\\n' '${reply}' > "$2"`,
      `echo '{"type":"thread.started","thread_id":"${thread}"}'`,
    ].join("\n"),
  );
  return { command: join(bin, "codex"), calls: bin };
}

async function settled(state: string, id: string): Promise<ImageRun> {
  for (let tries = 0; tries < 100; tries++) {
    const run = readImageRuns(state).find((each) => each.id === id)!;
    if (run.state === "done" || run.state === "failed") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the run never settled");
}

describe("image runs", () => {
  test("codex's reply names each image and carries the brief", () => {
    const { brief, names } = readReply(
      "Done.\nBRIEF:\nA red apple,\nflat.\nIMAGE: /x/a.png | apple\nIMAGE: /x/b.png",
    );
    expect(brief).toBe("A red apple,\nflat.");
    expect(names).toEqual(
      new Map([
        ["a.png", "apple"],
        ["b.png", ""],
      ]),
    );
  });

  test("a run in a project reads it without writing, and keeps codex's images in its own folder", async () => {
    const state = mkdtempSync(join(scratch, "state-"));
    const repo = mkdtempSync(join(scratch, "repo-"));
    const codex = fakeCodex("BRIEF: big apple\nIMAGE: /g/a.png | apple\nIMAGE: /g/b.png | apple");
    const run = addImageRun(state, {
      prompt: "an apple",
      repo,
      expand: true,
      variants: 2,
      references: [{ data: PNG, mimeType: "image/png" }],
    });
    const runner = imageRunner(state, codex.command);
    try {
      const done = await settled(state, run.id);
      expect(done).toMatchObject({
        state: "done",
        brief: "big apple",
        images: [
          { file: "1.png", name: "apple" },
          { file: "2.png", name: "apple" },
        ],
      });
      const folder = join(state, "images", run.id);
      expect(readFileSync(join(folder, "1.png"), "utf8")).toBe("a\n");
      const args = readFileSync(join(codex.calls, "args"), "utf8");
      expect(args).toContain(`--sandbox read-only -C ${repo}`);
      expect(args).toContain(`-i ${join(folder, "reference-1.png")}`);
      const prompt = readFileSync(join(codex.calls, "prompt"), "utf8");
      expect(prompt).toContain(`for the project at ${repo}`);
      expect(prompt).toContain("2 variants of each");
      expect(prompt).toContain("an apple");

      const job = useImage(state, run.id, "2.png", "the hero on the landing page");
      expect(readJobs(state).find((each) => each.id === job.id)).toMatchObject({
        item: { repo },
        tier: "grunt",
      });
      expect(job.prompt).toContain(join(folder, "2.png"));
      expect(job.prompt).toContain("the hero on the landing page");
    } finally {
      runner.stop();
    }
  });

  test("a run fails when codex makes no image, with what codex said", async () => {
    const state = mkdtempSync(join(scratch, "state-"));
    const bin = mkdtempSync(join(scratch, "codex-"));
    script(
      bin,
      "codex",
      `cat > /dev/null; while [ "$1" != "-o" ]; do shift; done; echo "image_gen isn't available" > "$2"`,
    );
    const run = addImageRun(state, {
      prompt: "a pear",
      expand: false,
      variants: 1,
      references: [],
    });
    const runner = imageRunner(state, join(bin, "codex"));
    try {
      expect(await settled(state, run.id)).toMatchObject({
        state: "failed",
        error: "codex made no image: image_gen isn't available",
      });
    } finally {
      runner.stop();
    }
  });
});

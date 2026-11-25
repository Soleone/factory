import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { addImageJob, readReply, useImage } from "../src/backend/images.ts";
import { readJobs } from "../src/backend/jobs.ts";
import type { Job } from "../src/backend/types.ts";
import { MINUTE, options, scratch, script, setup, tiered, work } from "./harness.ts";

const PNG = Buffer.from("fake png").toString("base64");

/**
 * A fake codex on PATH that saves three images under its thread, like image_gen does, and replies
 * with `reply`. `before` runs first; exiting there skips the images.
 */
function fakeCodex(reply: string, before = ""): string {
  const bin = mkdtempSync(join(scratch, "codex-"));
  const home = mkdtempSync(join(scratch, "codex-home-"));
  process.env.CODEX_HOME = home;
  const made = join(home, "generated_images", "t1");
  script(
    bin,
    "codex",
    [
      `echo "$*" > ${bin}/args; cat > ${bin}/prompt`,
      before,
      `mkdir -p ${made}; echo a > ${made}/a.png; echo b > ${made}/b.png; echo c > ${made}/c.png`,
      // -o names the reply file: the argument after it.
      `while [ "$1" != "-o" ]; do shift; done; printf '%s\\n' '${reply}' > "$2"`,
      `echo '{"type":"thread.started","thread_id":"t1"}'`,
    ].join("\n"),
  );
  process.env.PATH = `${bin}:${process.env.PATH}`;
  return bin;
}

/** A base whose only worker is codex. */
function codexOnly() {
  const base = setup(["a"]);
  tiered(base.state, { presets: [{ agent: "codex" }] });
  return base;
}

const settled = (id: string) => (jobs: Job[]) =>
  ["done", "failed"].includes(jobs.find((job) => job.id === id)!.state);

describe("image jobs", () => {
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

  test("a codex worker reads the project without writing, keeps codex's images outside it, and takes no other job", async () => {
    const base = codexOnly();
    const calls = fakeCodex("BRIEF: big apple\nIMAGE: /g/a.png | apple\nIMAGE: /g/b.png | apple");
    const coding = base.pick("a");
    const added = addImageJob(base.state, {
      prompt: "an apple",
      repo: base.repo,
      expand: true,
      variants: 2,
      references: [{ data: PNG, mimeType: "image/png" }],
    });
    const jobs = await work(options(base, {}), settled(added.id));
    const job = jobs.find((each) => each.id === added.id)!;
    expect(job).toMatchObject({ state: "done", agent: "codex" });
    expect(job.attempts).toMatchObject([
      {
        outcome: "done",
        brief: "big apple",
        images: [
          { file: "1-1.png", name: "apple" },
          { file: "1-2.png", name: "apple" },
        ],
      },
    ]);
    expect(jobs.find((each) => each.id === coding.id)!.state).toBe("queued");
    const folder = join(base.state, "images", job.id);
    expect(readFileSync(join(folder, "1-1.png"), "utf8")).toBe("a\n");
    const args = readFileSync(join(calls, "args"), "utf8");
    expect(args).toContain(`--sandbox read-only -C ${base.repo}`);
    expect(args).toContain(`-i ${join(folder, "reference-1.png")}`);
    const prompt = readFileSync(join(calls, "prompt"), "utf8");
    expect(prompt).toContain(`for the project at ${base.repo}`);
    expect(prompt).toContain("2 variants of each");
    expect(prompt).toContain("an apple");

    const use = useImage(base.state, job.id, "1-2.png", "the hero on the landing page");
    expect(readJobs(base.state).find((each) => each.id === use.id)).toMatchObject({
      item: { repo: base.repo },
      tier: "grunt",
    });
    expect(use.prompt).toContain(join(folder, "1-2.png"));
    expect(use.prompt).toContain("the hero on the landing page");
  });

  test("a usage limit puts the image job back, and the worker sleeps until the reset", async () => {
    const base = codexOnly();
    const tried = join(scratch, `tried-${Date.now()}`);
    fakeCodex(
      "IMAGE: /g/a.png | apple",
      `if [ ! -e ${tried} ]; then touch ${tried}; echo '{"type":"error","message":"You'"'"'ve hit your usage limit. Try again in 3h."}'; exit 1; fi`,
    );
    const added = addImageJob(base.state, {
      prompt: "an apple",
      expand: false,
      variants: 1,
      references: [],
    });
    const sleeps: number[] = [];
    const jobs = await work(
      { ...options(base, {}), sleep: async (ms) => void sleeps.push(ms) },
      settled(added.id),
    );
    expect(jobs.find((each) => each.id === added.id)!.attempts).toMatchObject([
      { outcome: "limited" },
      { outcome: "done", images: [{ file: "2-1.png", name: "apple" }] },
    ]);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(170 * MINUTE);
  });

  test("an image job fails when codex makes no image, with what codex said", async () => {
    const base = codexOnly();
    fakeCodex(
      "",
      `while [ "$1" != "-o" ]; do shift; done; echo "image_gen isn't available" > "$2"; exit 0`,
    );
    const added = addImageJob(base.state, {
      prompt: "a pear",
      expand: false,
      variants: 1,
      references: [],
    });
    const jobs = await work(options(base, {}), settled(added.id));
    const job = jobs.find((each) => each.id === added.id)!;
    expect(job.state).toBe("failed");
    expect(job.attempts.at(-1)!.error).toBe("codex made no image: image_gen isn't available");
  });
});

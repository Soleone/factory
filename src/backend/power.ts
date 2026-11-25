import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { alive, pidPath, resumePath, runningPid } from "./state.ts";
import type { Status } from "./types.ts";

export const logPath = (state: string) => join(state, "factory.log");

/** `factory run <args>` in the background, outliving this process and whoever started it. */
export function turnOn(state: string, args: string[]): number {
  const pid = runningPid(state);
  if (pid) throw new Error(`already on (pid ${pid})`);
  const log = openSync(logPath(state), "a");
  // argv[1] is this CLI, whether it runs from dist or, under pn dev, from source.
  const child = spawn(process.execPath, [process.argv[1], "run", ...args], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  writeFileSync(pidPath(state), `${child.pid}\n`);
  return child.pid!;
}

/**
 * Stops the run. Its agents keep working and the next run records what they did; with kill they get
 * SIGTERM, then SIGKILL after 10 seconds, and their jobs go back to the queue. Returns the pid it
 * stopped, if one was running.
 */
export async function turnOff(state: string, kill = false): Promise<number | undefined> {
  const pid = runningPid(state);
  if (!pid) return undefined;
  process.kill(pid, kill ? "SIGINT" : "SIGTERM");
  for (let waited = 0; alive(pid); waited++) {
    if (waited === 60) throw new Error(`pid ${pid} is still running after 30 seconds`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  rmSync(pidPath(state), { force: true });
  return pid;
}

/** Lets a worker paused on a fault of its own go on in the same run, which picks the request up. */
export function resumeWorker(state: string, id: string): void {
  const path = join(state, "status.json");
  const status: Status | undefined =
    runningPid(state) && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  if (!status) throw new Error("the factory is off");
  const worker = status.workers.find((each) => each.id === id);
  if (!worker) throw new Error(`run ${status.run} has no worker ${id}`);
  if (worker.state !== "paused") throw new Error(`${id} isn't paused`);
  const asked = resumePath(state, id);
  mkdirSync(dirname(asked), { recursive: true });
  writeFileSync(asked, `${status.run}\n`);
}

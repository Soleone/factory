import { spawn } from "node:child_process";
import { openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alive, pidPath, runningPid } from "./state.ts";

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

/** Stops the run; jobs in progress go back to the queue. Returns the pid it stopped, if one was running. */
export async function turnOff(state: string): Promise<number | undefined> {
  const pid = runningPid(state);
  if (!pid) return undefined;
  process.kill(pid, "SIGTERM");
  // Agents get SIGTERM, then SIGKILL after 10 seconds; the loop exits once they're gone.
  for (let waited = 0; alive(pid); waited++) {
    if (waited === 60) throw new Error(`pid ${pid} is still running after 30 seconds`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  rmSync(pidPath(state), { force: true });
  return pid;
}

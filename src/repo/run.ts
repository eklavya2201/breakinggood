import path from "node:path";
import pc from "picocolors";
import { existsSync } from "node:fs";
import type { Command, RunPlan } from "./detect-stack.js";
import { killTree, openBrowser, run, spawnLongRunning } from "../util/shell.js";
import { log } from "../util/ui.js";

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{2,5})?[^\s'"`)\]]*/i;
const PORT_RE = /(?:port|listening on|running on|started on|available at)\D{0,20}(\d{4,5})/i;

export async function runInstall(dir: string, plan: RunPlan): Promise<void> {
  for (const c of plan.install) {
    log.info(pc.bold(c.label));
    const res = await run(c.cmd, c.args, { cwd: dir });
    if (res.code !== 0) throw new Error(`"${c.label}" exited with code ${res.code}`);
  }
}

/**
 * Starts the dev server, watches its output for a local URL, opens the browser
 * once, and keeps the process in the foreground until Ctrl+C.
 */
export function runServer(dir: string, cmd: Command, opts: { open: boolean; knownPorts: number[] }): Promise<number> {
  return new Promise((resolve) => {
    log.info(pc.bold(cmd.label) + pc.dim(`   (Ctrl+C stops it)`));
    log.blank();

    const child = spawnLongRunning(cmd.cmd, cmd.args, dir);
    let opened = false;
    let buffer = "";

    const maybeOpen = (url: string) => {
      if (opened || !opts.open) return;
      opened = true;
      setTimeout(() => {
        log.blank();
        log.ok(pc.green(pc.bold(`Running → ${url}`)));
        log.blank();
        openBrowser(url);
      }, 800);
    };

    const onData = (b: Buffer) => {
      const s = b.toString();
      process.stdout.write(s);
      buffer = (buffer + s).slice(-4000);
      if (opened) return;
      const u = buffer.match(URL_RE);
      if (u) return maybeOpen(u[0].replace("0.0.0.0", "localhost"));
      const p = buffer.match(PORT_RE);
      if (p) return maybeOpen(`http://localhost:${p[1]}`);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    // Fallback: known ports, poll until one answers.
    if (opts.knownPorts.length && opts.open) {
      const started = Date.now();
      const poll = setInterval(async () => {
        if (opened || Date.now() - started > 90_000) return clearInterval(poll);
        for (const port of opts.knownPorts) {
          try {
            const r = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(800) });
            if (r.status < 500) {
              clearInterval(poll);
              return maybeOpen(`http://localhost:${port}`);
            }
          } catch {
            /* not up yet */
          }
        }
      }, 1500);
    }

    const stop = () => {
      log.blank();
      log.info("Stopping…");
      killTree(child);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    child.on("close", (code) => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve(code ?? 0);
    });
    // The command couldn't start (e.g. `mvn` isn't installed). Without a handler
    // Node throws the unhandled 'error' event and prints a stack trace.
    child.on("error", (err) => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      log.err(err.message);
      resolve(1);
    });
  });
}

export function describePlan(plan: RunPlan): void {
  log.dim(`stack: ${plan.stack}${plan.packageManager ? ` (${plan.packageManager})` : ""}`);
  for (const r of plan.reasons) log.dim(r);
  if (plan.install.length) log.dim("install: " + plan.install.map((c) => c.label).join("  →  "));
  log.dim("run:     " + (plan.run?.label ?? pc.yellow("nothing to run")));
}

export function hasNodeModules(dir: string): boolean {
  return existsSync(path.join(dir, "node_modules"));
}

/**
 * Managed child process spawning with guaranteed process-group cleanup.
 *
 * Both exports use detached:true to get a pgid, then kill(-pgid, SIGTERM) on
 * exit, timeout, or signal — cleaning the full process tree rather than just
 * the direct child. This prevents rg/node grandchildren from becoming orphans.
 */

import { spawn } from "node:child_process";

// All exit codes 0-255 — use when the caller handles any code as a non-error.
const ALL_EXIT_CODES = Array.from({ length: 256 }, (_, i) => i);

/**
 * Spawn a command, buffer stdout/stderr, and resolve with { code, stdout, stderr }.
 * Rejects (with .code/.stdout/.stderr attached) if code is not in allowedExitCodes.
 * Resolves with code 124 on timeout (after killing the process group).
 */
export function spawnManaged(cmd, args, options = {}) {
  const {
    timeoutMs = 30_000,
    allowedExitCodes = [0],
    cwd = process.cwd(),
    env,
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ?? process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pgid = child.pid;
    let done = false;
    let stdout = "";
    let stderr = "";

    function kill() {
      if (done) return;
      done = true;
      try { process.kill(-pgid, "SIGTERM"); } catch { /* already gone */ }
    }

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    const timer = setTimeout(() => {
      kill();
      resolve({ code: 124, stdout, stderr, timedOut: true });
    }, timeoutMs);

    if (timer.unref) timer.unref();

    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { process.kill(-pgid, "SIGTERM"); } catch { /* already gone */ }
      const exitCode = code ?? 1;
      if (allowedExitCodes.includes(exitCode)) {
        resolve({ code: exitCode, stdout, stderr });
      } else {
        const err = Object.assign(
          new Error(`${cmd} exited with code ${exitCode}`),
          { code: exitCode, stdout, stderr }
        );
        reject(err);
      }
    });

    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Spawn a command with inherited stdio (for interactive use, e.g. vitest).
 * Installs SIGTERM/SIGINT handlers and a wall-clock timeout that all kill the
 * process group. Returns a promise resolving to { code } on normal child exit.
 */
export function spawnManagedInherit(cmd, args, options = {}) {
  const {
    timeoutMs = 120_000,
    cwd = process.cwd(),
    env,
  } = options;

  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ?? process.env,
      stdio: "inherit",
      detached: true,
    });

    const pgid = child.pid;
    let done = false;

    function kill(signal) {
      if (done) return;
      done = true;
      try { process.kill(-pgid, "SIGTERM"); } catch { /* already gone */ }
      if (signal !== "exit") process.exit(1);
    }

    process.once("SIGTERM", () => kill("SIGTERM"));
    process.once("SIGINT", () => kill("SIGINT"));

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { process.kill(-pgid, "SIGTERM"); } catch { /* already gone */ }
      process.exit(124);
    }, timeoutMs);

    if (timer.unref) timer.unref();

    child.on("exit", (code, sig) => {
      done = true;
      clearTimeout(timer);
      try { process.kill(-pgid, "SIGTERM"); } catch { /* already gone */ }
      resolve({ code: code ?? (sig ? 1 : 0) });
    });

    child.on("error", (err) => {
      done = true;
      clearTimeout(timer);
      console.error("spawn error:", err.message);
      resolve({ code: 1 });
    });
  });
}

export { ALL_EXIT_CODES };

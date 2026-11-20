#!/usr/bin/env node
/**
 * Spike probe for backlog.design.rag-embed-lock-kernel-binding-spike.
 *
 * For each candidate kernel-held lock binding, runs four checks in child processes:
 *   cross-process-refused, same-process-refused, sigkill-recovery, synchronous.
 * Prints one JSON object per binding, one per stdout line:
 *   { binding, platform, arch, node, available, error, results }.
 *
 * Reporting rule: every pass value, and the available flag, is derived from an
 * event that a child process printed after it performed the operation. A child
 * that exits non-zero, times out, prints an error event or prints no parseable
 * event yields pass: false, with the failure recorded in observed.
 *
 * Every child process goes through runChild, which kills it with SIGKILL once
 * timeoutMs elapses (default CHILD_TIMEOUT_MS).
 *
 * Run: node scripts/spike/embed-lock-binding-probe.mjs [--binding=<name>]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BINDINGS = Object.freeze(["flock-addon", "better-sqlite3", "node-sqlite", "loopback-port"]);
export const CHECKS = Object.freeze(["cross-process-refused", "same-process-refused", "sigkill-recovery", "synchronous"]);
export const CHILD_TIMEOUT_MS = 15_000;

const SELF = fileURLToPath(import.meta.url);
const STDERR_TAIL_CHARS = 2_000;

export function makeProbeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "embed-lock-binding-probe-"));
}

/**
 * Run process.execPath with nodeArgs and resolve { code, signal, stdout, stderr, timedOut, spawnError }.
 * timedOut is true only when the deadline fired while the child was still running; the child is
 * then killed with SIGKILL. onLine(line, kill) is called for each complete stdout line while the
 * child runs. Never rejects: a launch failure resolves with code null and spawnError set.
 */
export function runChild(nodeArgs, { timeoutMs = CHILD_TIMEOUT_MS, onLine } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;
    let settled = false;
    let timer = null;
    let child = null;
    const finish = (code, signal, spawnError = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, spawnError });
    };
    const kill = (signal = "SIGKILL") => {
      try {
        child?.kill(signal);
      } catch {
        // The child has already exited; the close event reports its real status.
      }
    };
    try {
      child = spawn(process.execPath, nodeArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        // Backstop only. The timer below is the deadline, and it is what sets timedOut.
        timeout: timeoutMs + 5_000,
        killSignal: "SIGKILL",
      });
    } catch (error) {
      finish(null, null, String(error?.message ?? error));
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (typeof onLine !== "function") return;
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          onLine(line, kill);
        } catch (error) {
          stderr += `onLine threw: ${String(error?.message ?? error)}\n`;
        }
        newline = pending.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (child.pid === undefined) finish(null, null, String(error?.message ?? error));
      else stderr += `child error: ${String(error?.message ?? error)}\n`;
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

function workerArgs(mode, binding, resource) {
  return [SELF, `--worker=${mode}`, `--binding=${binding}`, `--resource=${resource}`];
}

// Port 0 asks the kernel for a free port; the child that binds it reports the port it was given.
function freshResource(binding, dir, label) {
  if (binding === "loopback-port") return "0";
  return path.join(dir, `${binding}.${label}.lock`);
}

function lastEvent(stdout) {
  const lines = String(stdout)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const value = JSON.parse(lines[i]);
      if (value && typeof value.event === "string") return value;
    } catch {
      // Not an event line; keep looking.
    }
  }
  return null;
}

function summarize(run) {
  return {
    code: run.code,
    signal: run.signal,
    timedOut: run.timedOut,
    spawnError: run.spawnError,
    stderrTail: run.stderr.slice(-STDERR_TAIL_CHARS),
  };
}

// { event, error }: error is null only for a clean exit whose last event is the expected one.
function readEvent(run, expected) {
  const event = lastEvent(run.stdout);
  if (run.spawnError) return { event, error: `child launch failed: ${run.spawnError}` };
  if (run.timedOut) return { event, error: "child timed out" };
  if (event === null) return { event, error: `child printed no parseable event (code ${run.code}, signal ${run.signal})` };
  if (event.event === "error") return { event, error: `child reported: ${event.message}` };
  if (event.event !== expected) return { event, error: `expected event ${expected}, got ${event.event}` };
  if (run.code !== 0) return { event, error: `child exited with code ${run.code}` };
  return { event, error: null };
}

function startHolder(binding, resource) {
  let resolveHeld;
  const held = new Promise((resolve) => {
    resolveHeld = resolve;
  });
  let killHolder = () => {};
  const state = { exited: false };
  const done = runChild(workerArgs("hold", binding, resource), {
    onLine: (line, kill) => {
      killHolder = kill;
      let value = null;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      if (value && (value.event === "held" || value.event === "error")) resolveHeld(value);
    },
  }).then((run) => {
    state.exited = true;
    resolveHeld(null);
    return run;
  });
  return { held, done, state, kill: (signal) => killHolder(signal) };
}

async function holderNotHeld(holder, held) {
  holder.kill("SIGKILL");
  const run = await holder.done;
  return { pass: false, observed: { stage: "hold", holderEvent: held, holder: summarize(run) } };
}

async function checkCrossProcess(binding, dir) {
  const holder = startHolder(binding, freshResource(binding, dir, "cross"));
  const held = await holder.held;
  if (held?.event !== "held") return holderNotHeld(holder, held);
  const contendRun = await runChild(workerArgs("contend", binding, held.resource));
  const holderAliveAfterContend = !holder.state.exited;
  holder.kill("SIGKILL");
  const holderRun = await holder.done;
  const contend = readEvent(contendRun, "contend");
  return {
    pass: contend.error === null && contend.event.refused === true && holderAliveAfterContend,
    observed: {
      resource: held.resource,
      contender: contend.event,
      contenderError: contend.error,
      contenderRun: summarize(contendRun),
      holderAliveAfterContend,
      holder: summarize(holderRun),
    },
  };
}

async function checkSameProcess(binding, dir) {
  const run = await runChild(workerArgs("same", binding, freshResource(binding, dir, "same")));
  const same = readEvent(run, "same");
  return {
    pass: same.error === null && same.event.firstAcquired === true && same.event.secondRefused === true,
    observed: { child: same.event, error: same.error, run: summarize(run) },
  };
}

async function checkSigkillRecovery(binding, dir) {
  const holder = startHolder(binding, freshResource(binding, dir, "sigkill"));
  const held = await holder.held;
  if (held?.event !== "held") return holderNotHeld(holder, held);
  const beforeRun = await runChild(workerArgs("contend", binding, held.resource));
  holder.kill("SIGKILL");
  const holderRun = await holder.done;
  const afterRun = await runChild(workerArgs("contend", binding, held.resource));
  const before = readEvent(beforeRun, "contend");
  const after = readEvent(afterRun, "contend");
  const holderKilled = holderRun.signal === "SIGKILL" && holderRun.timedOut === false;
  return {
    pass:
      before.error === null &&
      before.event.refused === true &&
      holderKilled &&
      after.error === null &&
      after.event.acquired === true,
    observed: {
      resource: held.resource,
      before: before.event,
      beforeError: before.error,
      holderKilled,
      holder: summarize(holderRun),
      after: after.event,
      afterError: after.error,
      afterRun: summarize(afterRun),
    },
  };
}

async function checkSynchronous(binding, dir) {
  const run = await runChild(workerArgs("sync", binding, freshResource(binding, dir, "sync")));
  const sync = readEvent(run, "sync");
  const measured = sync.error === null ? sync.event : null;
  return {
    pass:
      measured !== null &&
      measured.acquired === true &&
      measured.acquireReturnedPromise === false &&
      measured.releaseReturnedPromise === false,
    observed: {
      acquired: measured?.acquired ?? null,
      acquireReturnedPromise: measured?.acquireReturnedPromise ?? null,
      releaseReturnedPromise: measured?.releaseReturnedPromise ?? null,
      error: sync.error,
      run: summarize(run),
    },
  };
}

const CHECK_RUNNERS = Object.freeze({
  "cross-process-refused": checkCrossProcess,
  "same-process-refused": checkSameProcess,
  "sigkill-recovery": checkSigkillRecovery,
  synchronous: checkSynchronous,
});

export async function probeBinding(binding, { dir } = {}) {
  const result = {
    binding,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    available: false,
    error: null,
    results: {},
  };
  if (!BINDINGS.includes(binding)) {
    result.error = `unknown binding ${JSON.stringify(binding)}; expected one of ${BINDINGS.join(", ")}`;
    return result;
  }
  let workDir = dir;
  const ownsDir = !workDir;
  try {
    if (ownsDir) workDir = makeProbeDir();
    // available is set only after a child has loaded the binding and acquired a fresh resource.
    const probeRun = await runChild(workerArgs("probe", binding, freshResource(binding, workDir, "probe")));
    const probe = readEvent(probeRun, "probe");
    if (probe.error !== null) {
      result.error = `${probe.error}; stderr: ${probeRun.stderr.slice(-STDERR_TAIL_CHARS).trim() || "(empty)"}`;
      return result;
    }
    if (probe.event.acquired !== true) {
      result.error = "binding loaded but its acquire on a fresh resource was refused";
      return result;
    }
    result.available = true;
    for (const check of CHECKS) {
      try {
        result.results[check] = await CHECK_RUNNERS[check](binding, workDir);
      } catch (error) {
        result.results[check] = { pass: false, observed: { error: String(error?.message ?? error) } };
      }
    }
  } catch (error) {
    result.available = false;
    result.results = {};
    result.error = String(error?.message ?? error) || "probe failed";
  } finally {
    if (ownsDir && workDir) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup of the scratch directory; it does not affect any reported value.
      }
    }
  }
  return result;
}

// ---- worker side: runs inside a child process started by runChild ----

const heldHandles = [];

function isThenable(value) {
  return value !== null && value !== undefined && typeof value.then === "function";
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function loadAdapter(binding) {
  const require = createRequire(import.meta.url);
  if (binding === "flock-addon") {
    const fsExt = require("fs-ext");
    return {
      acquire(resource) {
        const fd = fs.openSync(resource, "a");
        try {
          fsExt.flockSync(fd, "exnb");
          return { fd, resource };
        } catch (error) {
          fs.closeSync(fd);
          if (error?.code === "EAGAIN" || error?.code === "EWOULDBLOCK") return null;
          throw error;
        }
      },
      release(handle) {
        fsExt.flockSync(handle.fd, "un");
        fs.closeSync(handle.fd);
      },
    };
  }
  if (binding === "better-sqlite3") {
    const Database = require("better-sqlite3");
    return {
      acquire(resource) {
        const db = new Database(resource, { timeout: 0 });
        try {
          db.pragma("busy_timeout = 0");
          db.exec("BEGIN EXCLUSIVE");
          return { db, resource };
        } catch (error) {
          db.close();
          if (error?.code === "SQLITE_BUSY" || error?.code === "SQLITE_LOCKED") return null;
          throw error;
        }
      },
      release(handle) {
        handle.db.exec("COMMIT");
        handle.db.close();
      },
    };
  }
  if (binding === "node-sqlite") {
    const { DatabaseSync } = await import("node:sqlite");
    return {
      acquire(resource) {
        const db = new DatabaseSync(resource);
        try {
          db.exec("PRAGMA busy_timeout = 0");
          db.exec("BEGIN EXCLUSIVE");
          return { db, resource };
        } catch (error) {
          db.close();
          // SQLITE_BUSY is 5 and SQLITE_LOCKED is 6.
          if (error?.errcode === 5 || error?.errcode === 6) return null;
          throw error;
        }
      },
      release(handle) {
        handle.db.exec("COMMIT");
        handle.db.close();
      },
    };
  }
  if (binding === "loopback-port") {
    const net = await import("node:net");
    return {
      acquire(resource) {
        return new Promise((resolve, reject) => {
          const server = net.createServer();
          server.once("error", (error) => (error?.code === "EADDRINUSE" ? resolve(null) : reject(error)));
          server.listen({ host: "127.0.0.1", port: Number(resource), exclusive: true }, () => {
            resolve({ server, resource: String(server.address().port) });
          });
        });
      },
      release(handle) {
        return new Promise((resolve) => handle.server.close(() => resolve()));
      },
    };
  }
  throw new Error(`unknown binding ${JSON.stringify(binding)}`);
}

async function runWorker(mode, binding, resource) {
  try {
    const adapter = await loadAdapter(binding);
    if (mode === "probe") {
      const handle = await adapter.acquire(resource);
      if (handle) await adapter.release(handle);
      emit({ event: "probe", loaded: true, acquired: handle !== null });
    } else if (mode === "hold") {
      const handle = await adapter.acquire(resource);
      if (!handle) throw new Error("holder acquire was refused");
      heldHandles.push(handle);
      emit({ event: "held", resource: handle.resource });
      setInterval(() => {}, 1_000);
    } else if (mode === "contend") {
      const handle = await adapter.acquire(resource);
      if (handle) await adapter.release(handle);
      emit({ event: "contend", acquired: handle !== null, refused: handle === null });
    } else if (mode === "same") {
      const first = await adapter.acquire(resource);
      const second = first ? await adapter.acquire(first.resource) : null;
      if (second) await adapter.release(second);
      if (first) await adapter.release(first);
      emit({ event: "same", firstAcquired: first !== null, secondRefused: first !== null && second === null });
    } else if (mode === "sync") {
      const pendingAcquire = adapter.acquire(resource);
      const acquireReturnedPromise = isThenable(pendingAcquire);
      const handle = await pendingAcquire;
      const pendingRelease = handle ? adapter.release(handle) : undefined;
      const releaseReturnedPromise = handle ? isThenable(pendingRelease) : null;
      await pendingRelease;
      emit({ event: "sync", acquired: handle !== null, acquireReturnedPromise, releaseReturnedPromise });
    } else {
      throw new Error(`unknown worker mode ${JSON.stringify(mode)}`);
    }
  } catch (error) {
    emit({ event: "error", message: String(error?.message ?? error), code: error?.code ?? null });
    process.exitCode = 1;
  }
}

function argValue(argv, name) {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

async function main(argv) {
  const mode = argValue(argv, "worker");
  if (mode !== undefined) {
    await runWorker(mode, argValue(argv, "binding"), argValue(argv, "resource"));
    return;
  }
  const only = argValue(argv, "binding");
  const selected = only === undefined ? BINDINGS : [only];
  for (const binding of selected) {
    const result = await probeBinding(binding);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF);
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}

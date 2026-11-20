// backlog.fix.http-entry-reservation-race-test
// Drives the exported session-start seam (createSessionRegistry) of the HTTP entry directly: no
// subprocess, no socket. The injected connectServer is held pending on a manually released promise,
// so a second initialize reaches the cap check while the first connect has not resolved. Under a
// cap of 1 that second initialize must get 503; it would be admitted if the reservation were taken
// only after `await connectServer(...)`.
//
// backlog.fix.http-entry-idle-eviction-inflight: the second describe block drives the same registry's
// routeSessionRequest and sweepIdle with an injected clock and an EventEmitter res stub, so in-flight
// requests, open SSE streams, aborted connections and rejected requests are checked against the idle
// rule without real timers.
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = path.join(ROOT, "packages/mcp-rks/bin/mcp-rks-http.mjs");
const bin = await import(BIN);

const INIT_BODY = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };

function deferred() {
  let release;
  const promise = new Promise((r) => { release = r; });
  return { promise, release };
}

function stubRes() {
  const res = {
    headersSent: false,
    statusCode: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers ?? null;
      res.headersSent = true;
      return res;
    },
    end(chunk) {
      if (chunk !== undefined) res.body += String(chunk);
      return res;
    },
  };
  return res;
}

/** Fake transport: `initialize` true -> initializes a session and writes 200; false -> writes 400 only. */
function makeFakeTransport({ initialize }) {
  const built = [];
  let n = 0;
  class FakeTransport {
    constructor(opts) {
      this.opts = opts;
      this.closed = false;
      built.push(this);
    }
    async handleRequest(_req, res) {
      if (initialize) {
        n += 1;
        this.opts.onsessioninitialized(`session-${n}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      } else {
        res.writeHead(400, { "content-type": "application/json" });
        res.end("{}");
      }
    }
    async close() { this.closed = true; }
  }
  return { FakeTransport, built };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("mcp-rks-http session-start reservation", () => {
  it("admits exactly one of two initializes under maxSessions 1 while the first connect is pending", async () => {
    const gate = deferred();
    let entered = 0;
    let resolved = false;
    const connectArgs = [];
    const connectServer = async (transport) => {
      entered += 1;
      connectArgs.push(transport);
      await gate.promise;
      resolved = true;
      return { close: async () => {} };
    };
    const { FakeTransport, built } = makeFakeTransport({ initialize: true });
    const registry = bin.createSessionRegistry({
      maxSessions: 1,
      deps: { Transport: FakeTransport, connectServer, allowedHosts: ["127.0.0.1:1"] },
    });

    const res1 = stubRes();
    const p1 = registry.startSession({}, res1, INIT_BODY);

    // The first connect has been entered and has not resolved when the second initialize is issued.
    expect(entered).toBe(1);
    expect(resolved).toBe(false);
    expect(connectArgs[0]).toBeInstanceOf(FakeTransport);
    expect(connectArgs[0]).toBe(built[0]);
    expect(built[0].opts.allowedHosts).toEqual(["127.0.0.1:1"]);

    // The cap check runs before startSession's first await, so its outcome is observable as soon as
    // the call returns. The gate is released in `finally` so a failing assertion cannot hang the test.
    const res2 = stubRes();
    let p2;
    try {
      p2 = registry.startSession({}, res2, INIT_BODY);
      expect(resolved).toBe(false);
      expect(entered, "second initialize must not reach connectServer while the first connect is pending").toBe(1);
      expect(res2.statusCode).toBe(503);
      const err = JSON.parse(res2.body);
      expect(err.error.code).toBe(-32000);
      expect(err.error.message).toBe("Service unavailable: session limit reached");
    } finally {
      gate.release();
    }
    await p2;
    await p1;
    expect(resolved).toBe(true);
    expect(res1.statusCode).toBe(200);
    expect(registry.sessions.size).toBe(1);
    expect([...registry.sessions.keys()]).toEqual(["session-1"]);
    expect(registry.pending.size).toBe(0);
    // No late admission after the 503.
    expect(entered).toBe(1);
    expect(built.length).toBe(1);
    expect(res2.statusCode).toBe(503);
  });

  it("releases the reserved slot of an initialize the transport did not initialize, and logs it", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let entered = 0;
    const connectServer = async () => {
      entered += 1;
      await new Promise((r) => setImmediate(r));
      return { close: async () => {} };
    };
    const rejecting = makeFakeTransport({ initialize: false });
    const deps = { Transport: rejecting.FakeTransport, connectServer, allowedHosts: [] };
    const registry = bin.createSessionRegistry({ maxSessions: 1, deps });

    const res1 = stubRes();
    await registry.startSession({}, res1, INIT_BODY);
    expect(res1.statusCode).toBe(400);
    expect(registry.pending.size).toBe(0);
    expect(registry.sessions.size).toBe(0);
    expect(rejecting.built[0].closed).toBe(true);
    expect(errSpy).toHaveBeenCalledWith("[mcp-rks-http] released uninitialized session (closed: true)");

    // The slot is free: a following initialize under maxSessions 1 is admitted (deps read per call).
    const admitting = makeFakeTransport({ initialize: true });
    deps.Transport = admitting.FakeTransport;
    const res2 = stubRes();
    await registry.startSession({}, res2, INIT_BODY);
    expect(res2.statusCode).toBe(200);
    expect(registry.sessions.size).toBe(1);
    expect(registry.pending.size).toBe(0);
    expect(entered).toBe(2);
  });
});

const IDLE_MS = 1_000;
const EVICTED_LINE = "[mcp-rks-http] evicted idle session (closed: true)";

/**
 * A routed-response stub: an EventEmitter with writeHead/end. With `emitOnEnd` (default) end() emits
 * finish then close, as a node ServerResponse does; without it the test emits events itself.
 */
function eventRes({ emitOnEnd = true } = {}) {
  const res = new EventEmitter();
  res.headersSent = false;
  res.statusCode = null;
  res.headers = null;
  res.body = "";
  res.ended = false;
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers ?? null;
    res.headersSent = true;
    return res;
  };
  res.flushHeaders = () => {};
  res.end = (chunk) => {
    if (chunk !== undefined) res.body += String(chunk);
    res.ended = true;
    if (emitOnEnd) { res.emit("finish"); res.emit("close"); }
    return res;
  };
  return res;
}

/**
 * A registry with one initialized session, an injected clock and a FakeTransport whose routed
 * requests (handleRequest without a body) run `transport.onRoute(req, res)`.
 */
async function openSession(bounds = {}) {
  let t = 0;
  const clock = { now: () => t, set: (v) => { t = v; } };
  const built = [];
  class FakeTransport {
    constructor(opts) {
      this.opts = opts;
      this.closed = false;
      this.onRoute = async () => {};
      built.push(this);
    }
    async handleRequest(req, res, body) {
      if (body !== undefined) {
        this.opts.onsessioninitialized("session-1");
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      await this.onRoute(req, res);
    }
    async close() { this.closed = true; }
  }
  const deps = { Transport: FakeTransport, connectServer: async () => ({ close: async () => {} }), allowedHosts: [] };
  const registry = bin.createSessionRegistry({ maxSessions: 1, idleMs: IDLE_MS, deps, now: clock.now, ...bounds });
  await registry.startSession({}, stubRes(), INIT_BODY);
  expect([...registry.sessions.keys()]).toEqual(["session-1"]);
  return { registry, id: "session-1", entry: registry.sessions.get("session-1"), transport: built[0], clock };
}

const flush = () => new Promise((r) => setImmediate(r));
const evictedCalls = (spy) => spy.mock.calls.filter((c) => String(c[0]).includes("evicted idle session"));

/** eventRes plus writableEnded (set by end()) and a destroy() spy that emits close once; end() after end throws. */
function failRes({ emitOnEnd = false } = {}) {
  const res = eventRes({ emitOnEnd });
  res.writableEnded = false;
  res.destroyed = false;
  res.endCalls = 0;
  res.closeCount = 0;
  res.on("close", () => { res.closeCount += 1; });
  const baseEnd = res.end;
  res.end = (chunk) => {
    res.endCalls += 1;
    if (res.writableEnded) throw new Error("end() after end");
    res.writableEnded = true;
    return baseEnd(chunk);
  };
  res.destroy = vi.fn(() => {
    if (res.destroyed) return res;
    res.destroyed = true;
    res.emit("close");
    return res;
  });
  return res;
}

const writeSseHeaders = (res) => res.writeHead(200, { "content-type": "text/event-stream" }).flushHeaders();

describe("mcp-rks-http handleFailure when a request fails", () => {
  it("a routed request rejecting before headers are sent gets a 500 and is not destroyed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { registry, id, transport } = await openSession();
    transport.onRoute = async () => { throw new Error("boom"); };
    const res = failRes();
    registry.routeSessionRequest({}, res, id);
    await flush();
    expect(res.statusCode).toBe(500);
    expect(res.writableEnded).toBe(true);
    expect(res.destroy).not.toHaveBeenCalled();
  });

  it("a routed request rejecting after headers were sent is destroyed once and emits close, with no 500 written", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { registry, id, transport } = await openSession();
    transport.onRoute = async (_req, res) => { writeSseHeaders(res); throw new Error("boom"); };
    const res = failRes();
    registry.routeSessionRequest({ method: "GET" }, res, id);
    await flush();
    expect(res.statusCode).toBe(200);
    expect(res.destroy).toHaveBeenCalledTimes(1);
    expect(res.closeCount).toBe(1);
  });

  it("a routed request rejecting after its response already ended is not ended again or destroyed, and does not throw", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { registry, id, entry, transport } = await openSession();
    transport.onRoute = async (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      throw new Error("late");
    };
    // emitOnEnd false: only the rejection catch's end() can decrement active, so active 0 proves handleFailure returned.
    const res = failRes();
    registry.routeSessionRequest({}, res, id);
    await flush();
    expect(res.endCalls).toBe(1);
    expect(res.destroy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith("[mcp-rks-http] request failed: late");
    expect(entry.active).toBe(0);
  });

  it("the request-failed log line is written for a pre-headers, a post-headers and an already-ended failure", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { registry, id, transport } = await openSession();
    const modes = {
      pre: async () => { throw new Error("pre"); },
      post: async (_req, res) => { writeSseHeaders(res); throw new Error("post"); },
      ended: async (_req, res) => { res.writeHead(200); res.end("{}"); throw new Error("ended"); },
    };
    // Collect per-mode outcomes in the loop; assert once, after it, so no assertion depends on the loop running.
    const outcomes = {};
    for (const [name, onRoute] of Object.entries(modes)) {
      transport.onRoute = onRoute;
      const res = failRes();
      registry.routeSessionRequest({}, res, id);
      await flush();
      outcomes[name] = { statusCode: res.statusCode, destroyCalls: res.destroy.mock.calls.length };
    }
    const failedLines = errSpy.mock.calls
      .map((args) => args[0])
      .filter((line) => typeof line === "string" && line.startsWith("[mcp-rks-http] request failed: "));
    expect(failedLines).toEqual([
      "[mcp-rks-http] request failed: pre",
      "[mcp-rks-http] request failed: post",
      "[mcp-rks-http] request failed: ended",
    ]);
    expect(outcomes).toEqual({
      pre: { statusCode: 500, destroyCalls: 0 },
      post: { statusCode: 200, destroyCalls: 1 },
      ended: { statusCode: 200, destroyCalls: 0 },
    });
  });

  it("a post-headers rejection returns the session's active count to 0 exactly once and leaves it evictable", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { registry, id, entry, transport, clock } = await openSession();
    transport.onRoute = async (_req, res) => { writeSseHeaders(res); throw new Error("boom"); };
    expect(entry.active).toBe(0);
    const T = 10;
    clock.set(T);
    const res = failRes();
    registry.routeSessionRequest({ method: "GET" }, res, id);
    await flush();
    expect(res.closeCount).toBe(1);
    expect(entry.active).toBe(0);
    res.emit("close");
    expect(entry.active).toBe(0);
    clock.set(T + IDLE_MS + 1);
    expect(await registry.sweepIdle()).toEqual([{ id, closed: true, error: null }]);
    expect(evictedCalls(errSpy)).toEqual([[EVICTED_LINE]]);
  });

  it("an initialize rejecting after headers were sent is destroyed and its reserved slot is released", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    class HeadersThenThrow {
      constructor(opts) { this.opts = opts; }
      async handleRequest(_req, res) { writeSseHeaders(res); throw new Error("boom"); }
      async close() {}
    }
    const registry = bin.createSessionRegistry({
      maxSessions: 1,
      deps: { Transport: HeadersThenThrow, connectServer: async () => ({ close: async () => {} }), allowedHosts: [] },
    });
    const res = failRes();
    await registry.startSession({}, res, INIT_BODY);
    expect(res.statusCode).toBe(200);
    expect(res.destroy).toHaveBeenCalledTimes(1);
    expect(registry.pending.size).toBe(0);
    expect(registry.sessions.size).toBe(0);
  });
});

const STREAM_MAX_MS = 10_000;
const HEARTBEAT_MS = 1_000;
const KEEPALIVE = ": keepalive\n\n";
const SSE_HEADERS = { "content-type": "text/event-stream" };
// setImmediate stays real so flush() still settles the fake transport's promises.
const FAKE_TIMERS = { toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] };

/** failRes plus a res.write spy; with emitOnEnd (the default here) end() emits finish then close. */
function streamRes({ emitOnEnd = true } = {}) {
  const res = failRes({ emitOnEnd });
  res.write = vi.fn(() => true);
  return res;
}

const writtenFrames = (res) => res.write.mock.calls.map((c) => c[0]);

/** openSession with stream bounds; routed requests write 200 with `headers` and return without ending. */
async function openHeldSession(headers, bounds = { streamMaxMs: STREAM_MAX_MS, sseHeartbeatMs: HEARTBEAT_MS }) {
  const s = await openSession(bounds);
  s.transport.onRoute = async (_req, res) => { res.writeHead(200, headers).flushHeaders(); };
  return s;
}

describe("mcp-rks-http held stream bound", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("ends a held SSE stream at streamMaxMs, returns active to 0 once, and the session is then evicted after idleMs", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers(FAKE_TIMERS);
    const { registry, id, entry, clock } = await openHeldSession(SSE_HEADERS);
    const res = streamRes();
    clock.set(10);
    registry.routeSessionRequest({ method: "GET" }, res, id);
    await flush();
    expect(entry.active).toBe(1);
    vi.advanceTimersByTime(STREAM_MAX_MS - 1);
    expect(res.endCalls).toBe(0);
    expect(entry.active).toBe(1);
    const T = 20_000;
    clock.set(T);
    vi.advanceTimersByTime(1);
    expect(res.endCalls).toBe(1);
    expect(res.ended).toBe(true);
    expect(res.destroy).not.toHaveBeenCalled();
    expect(entry.active).toBe(0);
    res.emit("close");
    expect(entry.active).toBe(0);
    clock.set(T + IDLE_MS + 1);
    expect(await registry.sweepIdle()).toEqual([{ id, closed: true, error: null }]);
    expect(evictedCalls(errSpy)).toEqual([[EVICTED_LINE]]);
  });

  it("destroys a response still open at streamMaxMs whose end() and destroy() emit nothing, and returns active to 0 once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers(FAKE_TIMERS);
    const { registry, id, entry } = await openHeldSession(SSE_HEADERS);
    const res = streamRes({ emitOnEnd: false });
    res.destroy = vi.fn(() => { res.destroyed = true; return res; });
    registry.routeSessionRequest({ method: "GET" }, res, id);
    await flush();
    expect(entry.active).toBe(1);
    vi.advanceTimersByTime(STREAM_MAX_MS);
    expect(res.endCalls).toBe(1);
    expect(res.destroy).toHaveBeenCalledTimes(1);
    expect(res.closeCount).toBe(0);
    expect(entry.active).toBe(0);
    vi.advanceTimersByTime(5 * HEARTBEAT_MS);
    expect(entry.active).toBe(0);
  });

  it("a response that finishes before streamMaxMs gets no later end or destroy and its timers are cleared", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers(FAKE_TIMERS);
    const { registry, id, entry } = await openHeldSession(SSE_HEADERS);
    const baseline = vi.getTimerCount();
    const res = streamRes();
    registry.routeSessionRequest({ method: "GET" }, res, id);
    await flush();
    expect(vi.getTimerCount()).toBe(baseline + 2);
    res.end(); // emits finish, then close
    expect(entry.active).toBe(0);
    expect(vi.getTimerCount()).toBe(baseline);
    vi.advanceTimersByTime(3 * STREAM_MAX_MS);
    expect(res.endCalls).toBe(1);
    expect(res.destroy).not.toHaveBeenCalled();
    expect(res.write).not.toHaveBeenCalled();
    expect(entry.active).toBe(0);
  });

  it("writes one keepalive comment per heartbeat interval on an open text/event-stream response, for content-type and Content-Type", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers(FAKE_TIMERS);
    const lower = await openHeldSession({ "content-type": "text/event-stream" });
    const upper = await openHeldSession({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const resLower = streamRes();
    const resUpper = streamRes();
    lower.registry.routeSessionRequest({ method: "GET" }, resLower, lower.id);
    upper.registry.routeSessionRequest({ method: "GET" }, resUpper, upper.id);
    await flush();
    const k = 3;
    vi.advanceTimersByTime(k * HEARTBEAT_MS);
    expect(writtenFrames(resLower)).toEqual([KEEPALIVE, KEEPALIVE, KEEPALIVE]);
    expect(writtenFrames(resUpper)).toEqual([KEEPALIVE, KEEPALIVE, KEEPALIVE]);
    expect(lower.entry.active).toBe(1);
    expect(upper.entry.active).toBe(1);
  });

  it("writes no heartbeat to a held response whose content type is application/json", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers(FAKE_TIMERS);
    const { registry, id, entry } = await openHeldSession({ "content-type": "application/json" });
    const res = streamRes();
    registry.routeSessionRequest({}, res, id);
    await flush();
    vi.advanceTimersByTime(5 * HEARTBEAT_MS);
    expect(res.statusCode).toBe(200);
    expect(res.write).not.toHaveBeenCalled();
    expect(entry.active).toBe(1);
  });

  it("a heartbeat whose write throws destroys the response without the error escaping, and active returns to 0 once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers(FAKE_TIMERS);
    const { registry, id, entry } = await openHeldSession(SSE_HEADERS);
    const res = streamRes();
    res.write = vi.fn(() => { throw new Error("EPIPE"); });
    registry.routeSessionRequest({ method: "GET" }, res, id);
    await flush();
    expect(() => vi.advanceTimersByTime(HEARTBEAT_MS)).not.toThrow();
    expect(res.write).toHaveBeenCalledTimes(1);
    expect(res.destroy).toHaveBeenCalledTimes(1);
    expect(res.closeCount).toBe(1);
    expect(entry.active).toBe(0);
    vi.advanceTimersByTime(3 * HEARTBEAT_MS);
    expect(res.write).toHaveBeenCalledTimes(1);
    expect(entry.active).toBe(0);
  });

  it("a heartbeat on an already-destroyed response destroys it and writes nothing, and active returns to 0 once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers(FAKE_TIMERS);
    const { registry, id, entry } = await openHeldSession(SSE_HEADERS);
    const res = streamRes();
    registry.routeSessionRequest({ method: "GET" }, res, id);
    await flush();
    res.destroyed = true; // the socket went away without a close reaching the entry
    expect(() => vi.advanceTimersByTime(HEARTBEAT_MS)).not.toThrow();
    expect(res.destroy).toHaveBeenCalledTimes(1);
    expect(res.write).not.toHaveBeenCalled();
    expect(entry.active).toBe(0);
    vi.advanceTimersByTime(3 * HEARTBEAT_MS);
    expect(res.write).not.toHaveBeenCalled();
    expect(entry.active).toBe(0);
  });

  it("within streamMaxMs an open SSE stream still blocks idle eviction past 2x idleMs", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers(FAKE_TIMERS);
    const { registry, id, entry, transport, clock } = await openHeldSession(SSE_HEADERS);
    expect(STREAM_MAX_MS).toBeGreaterThan(2 * IDLE_MS);
    const res = streamRes();
    clock.set(100);
    registry.routeSessionRequest({ method: "GET" }, res, id);
    await flush();
    vi.advanceTimersByTime(2 * IDLE_MS + 1);
    clock.set(100 + 2 * IDLE_MS + 1);
    expect(await registry.sweepIdle()).toEqual([]);
    expect(registry.sessions.has(id)).toBe(true);
    expect(entry.active).toBe(1);
    expect(res.endCalls).toBe(0);
    expect(transport.closed).toBe(false);
    expect(evictedCalls(errSpy)).toEqual([]);
  });

  it("every lifetime and heartbeat timer created for a routed response is unref'd", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { registry, id } = await openHeldSession(SSE_HEADERS);
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const res = streamRes();
    // The fake transport writes its SSE headers synchronously, so both timers exist when this call returns.
    registry.routeSessionRequest({ method: "GET" }, res, id);
    const handles = [...timeoutSpy.mock.results, ...intervalSpy.mock.results].map((r) => r.value);
    const refs = handles.map((h) => h.hasRef());
    registry.clearStreamTimers();
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(intervalSpy).toHaveBeenCalledTimes(1);
    expect(refs).toEqual([false, false]);
  });

  it("clearStreamTimers() stops every lifetime and heartbeat timer of an open routed SSE response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers(FAKE_TIMERS);
    const { registry, id, entry } = await openHeldSession(SSE_HEADERS);
    expect(typeof registry.clearStreamTimers).toBe("function");
    const res = streamRes();
    registry.routeSessionRequest({ method: "GET" }, res, id);
    await flush();
    registry.clearStreamTimers();
    vi.advanceTimersByTime(STREAM_MAX_MS + 5 * HEARTBEAT_MS);
    expect(res.write).not.toHaveBeenCalled();
    expect(res.endCalls).toBe(0);
    expect(res.destroy).not.toHaveBeenCalled();
    expect(entry.active).toBe(1);
  });

  it("source: main() passes streamMaxMs and sseHeartbeatMs into createSessionRegistry and shutdown calls registry.clearStreamTimers()", () => {
    const src = fs.readFileSync(BIN, "utf8");
    const mainStart = src.indexOf("export async function main()");
    expect(mainStart).toBeGreaterThan(-1);
    const mainSrc = src.slice(mainStart);
    expect(mainSrc).toMatch(/const\s*\{\s*maxSessions\s*,\s*idleMs\s*,\s*streamMaxMs\s*,\s*sseHeartbeatMs\s*\}\s*=\s*readSessionBounds\(\s*process\.env\s*\)/);
    expect(mainSrc).toMatch(/createSessionRegistry\(\s*\{[^}]*\bstreamMaxMs\b[^}]*\bsseHeartbeatMs\b[^}]*\}\s*\)/);
    const shutdownStart = mainSrc.indexOf("const shutdown = () => {");
    const shutdownEnd = mainSrc.indexOf('process.once("SIGTERM", shutdown)');
    expect(shutdownStart).toBeGreaterThan(-1);
    expect(shutdownEnd).toBeGreaterThan(shutdownStart);
    expect(mainSrc.slice(shutdownStart, shutdownEnd)).toMatch(/registry\.clearStreamTimers\(\s*\)/);
  });
});

describe("mcp-rks-http idle eviction with work in flight", () => {
  it("does not evict a session whose routed request is still being served; the response completes", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { registry, id, transport, clock } = await openSession();
    const gate = deferred();
    transport.onRoute = async (_req, res) => {
      await gate.promise;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    };
    clock.set(10);
    const res = eventRes();
    registry.routeSessionRequest({}, res, id);
    try {
      clock.set(10 + IDLE_MS + 500);
      expect(await registry.sweepIdle()).toEqual([]);
      expect(registry.sessions.has(id)).toBe(true);
      expect(transport.closed).toBe(false);
    } finally {
      gate.release();
    }
    await flush();
    expect(res.statusCode).toBe(200);
    expect(res.ended).toBe(true);
    expect(registry.sessions.has(id)).toBe(true);
    expect(evictedCalls(errSpy)).toEqual([]);
  });

  it("does not evict a session holding an open SSE GET stream past idleMs and 2x idleMs", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { registry, id, entry, transport, clock } = await openSession();
    // Like the SDK GET handler: write the SSE headers, keep the response, return without ending it.
    transport.onRoute = async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" }).flushHeaders();
    };
    clock.set(100);
    const res = eventRes();
    registry.routeSessionRequest({ method: "GET" }, res, id);
    await flush();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    for (const t of [100 + IDLE_MS + 1, 100 + 2 * IDLE_MS + 1]) {
      clock.set(t);
      expect(await registry.sweepIdle()).toEqual([]);
      expect(registry.sessions.has(id), `sweep at ${t}`).toBe(true);
    }
    expect(entry.active).toBe(1);
    expect(transport.closed).toBe(false);
    expect(evictedCalls(errSpy)).toEqual([]);
  });

  it("measures idle time from when the last in-flight response ends, then evicts with the observed close", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { registry, id, transport, clock } = await openSession();
    const gate = deferred();
    transport.onRoute = async (_req, res) => {
      await gate.promise;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    };
    clock.set(50);
    registry.routeSessionRequest({}, eventRes(), id);
    const T = 5_000;
    clock.set(T);
    gate.release();
    await flush();
    clock.set(T + IDLE_MS);
    expect(await registry.sweepIdle()).toEqual([]);
    expect(registry.sessions.has(id)).toBe(true);
    clock.set(T + IDLE_MS + 1);
    expect(await registry.sweepIdle()).toEqual([{ id, closed: true, error: null }]);
    expect(registry.sessions.has(id)).toBe(false);
    expect(transport.closed).toBe(true);
    expect(evictedCalls(errSpy)).toEqual([[EVICTED_LINE]]);
  });

  it("counts requests in flight, and a response emitting both finish and close as one end", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { registry, id, entry, transport, clock } = await openSession();
    const gates = [deferred(), deferred()];
    let n = 0;
    transport.onRoute = async (_req, res) => {
      const gate = gates[n++];
      await gate.promise;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}"); // emits finish, then close
    };
    clock.set(10);
    const res1 = eventRes();
    const res2 = eventRes();
    registry.routeSessionRequest({}, res1, id);
    registry.routeSessionRequest({}, res2, id);
    expect(entry.active).toBe(2);
    clock.set(100);
    gates[0].release();
    await flush();
    expect(res1.ended).toBe(true);
    expect(entry.active, "finish + close on one response is one end").toBe(1);
    clock.set(100 + 3 * IDLE_MS);
    expect(await registry.sweepIdle()).toEqual([]);
    expect(registry.sessions.has(id), "second request still in flight").toBe(true);
    const T2 = 200 + 3 * IDLE_MS;
    clock.set(T2);
    gates[1].release();
    await flush();
    expect(entry.active).toBe(0);
    clock.set(T2 + IDLE_MS);
    expect(await registry.sweepIdle()).toEqual([]);
    clock.set(T2 + IDLE_MS + 1);
    expect(await registry.sweepIdle()).toEqual([{ id, closed: true, error: null }]);
    expect(registry.sessions.has(id)).toBe(false);
  });

  it("an aborted connection (close without finish, handleRequest never settles) becomes evictable", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { registry, id, transport, clock } = await openSession();
    transport.onRoute = () => new Promise(() => {}); // never settles
    clock.set(10);
    const res = eventRes({ emitOnEnd: false });
    registry.routeSessionRequest({}, res, id);
    clock.set(10 + 2 * IDLE_MS);
    expect(await registry.sweepIdle()).toEqual([]);
    const T = 20 + 2 * IDLE_MS;
    clock.set(T);
    res.emit("close");
    clock.set(T + IDLE_MS);
    expect(await registry.sweepIdle()).toEqual([]);
    clock.set(T + IDLE_MS + 1);
    expect(await registry.sweepIdle()).toEqual([{ id, closed: true, error: null }]);
    expect(registry.sessions.has(id)).toBe(false);
    expect(transport.closed).toBe(true);
    expect(evictedCalls(errSpy)).toEqual([[EVICTED_LINE]]);
  });

  it("a rejected handleRequest does not leave the session permanently un-evictable", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { registry, id, entry, transport, clock } = await openSession();
    const gate = deferred();
    transport.onRoute = async () => {
      await gate.promise;
      throw new Error("boom");
    };
    clock.set(10);
    // The stub's end() emits nothing, so only the rejection path can end the activity.
    const res = eventRes({ emitOnEnd: false });
    registry.routeSessionRequest({}, res, id);
    const T = 2_000;
    clock.set(T);
    gate.release();
    await flush();
    expect(errSpy).toHaveBeenCalledWith("[mcp-rks-http] request failed: boom");
    expect(res.statusCode).toBe(500);
    expect(entry.active).toBe(0);
    clock.set(T + IDLE_MS + 1);
    expect(await registry.sweepIdle()).toEqual([{ id, closed: true, error: null }]);
    expect(registry.sessions.has(id)).toBe(false);
  });

  it("a session with nothing in flight is evicted more than idleMs after its last request started", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { registry, id, transport, clock } = await openSession();
    // Initialized at clock 0 with nothing routed since.
    clock.set(IDLE_MS);
    expect(await registry.sweepIdle()).toEqual([]);
    expect(registry.sessions.has(id)).toBe(true);
    clock.set(IDLE_MS + 1);
    expect(await registry.sweepIdle()).toEqual([{ id, closed: true, error: null }]);
    expect(registry.sessions.has(id)).toBe(false);
    expect(transport.closed).toBe(true);
    expect(evictedCalls(errSpy)).toEqual([[EVICTED_LINE]]);
  });

  it("source: the request-start-only rule is gone and main()'s sweeper interval calls registry.sweepIdle()", () => {
    const src = fs.readFileSync(BIN, "utf8");
    expect(src).not.toContain("whose last request started more than idleMs ago");
    const mainSrc = src.slice(src.indexOf("export async function main()"));
    expect(mainSrc).toMatch(/setInterval\(\s*\(\s*\)\s*=>\s*\{\s*registry\.sweepIdle\(\s*\)\s*;?\s*\}\s*,\s*sweepMs\s*\)/);
    // One copy of the eviction rule: the registry's.
    expect(src.split('reportClose("evicted idle session"').length - 1).toBe(1);
  });
});

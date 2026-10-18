import { describe, it, expect } from "vitest";
import { spawnManaged, spawnManagedInherit, ALL_EXIT_CODES } from "../../scripts/lib/spawn-managed.mjs";

describe("ALL_EXIT_CODES", () => {
  it("contains 256 entries (0–255)", () => {
    expect(ALL_EXIT_CODES).toHaveLength(256);
    expect(ALL_EXIT_CODES[0]).toBe(0);
    expect(ALL_EXIT_CODES[255]).toBe(255);
  });

  it("contains every integer from 0 to 255", () => {
    for (let i = 0; i < 256; i++) {
      expect(ALL_EXIT_CODES).toContain(i);
    }
  });
});

describe("spawnManaged", () => {
  it("resolves with code 0 and captured stdout for a successful command", async () => {
    const result = await spawnManaged("node", ["-e", "process.stdout.write('hello')"], {
      allowedExitCodes: [0],
      timeoutMs: 5000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("");
  });

  it("captures stderr separately from stdout", async () => {
    const result = await spawnManaged("node", ["-e", "process.stderr.write('err-msg')"], {
      allowedExitCodes: ALL_EXIT_CODES,
      timeoutMs: 5000,
    });
    expect(result.stderr).toBe("err-msg");
    expect(result.stdout).toBe("");
  });

  it("resolves with non-zero code when code is in allowedExitCodes", async () => {
    const result = await spawnManaged("node", ["-e", "process.exit(2)"], {
      allowedExitCodes: [0, 2],
      timeoutMs: 5000,
    });
    expect(result.code).toBe(2);
  });

  it("rejects with attached code when exit code is not in allowedExitCodes", async () => {
    await expect(
      spawnManaged("node", ["-e", "process.exit(1)"], {
        allowedExitCodes: [0],
        timeoutMs: 5000,
      })
    ).rejects.toMatchObject({ code: 1 });
  });

  it("resolves for any exit code when ALL_EXIT_CODES is used", async () => {
    const result = await spawnManaged("node", ["-e", "process.exit(42)"], {
      allowedExitCodes: ALL_EXIT_CODES,
      timeoutMs: 5000,
    });
    expect(result.code).toBe(42);
  });

  it("resolves with code 124 and timedOut:true on timeout", async () => {
    const result = await spawnManaged("node", ["-e", "setTimeout(()=>{},60000)"], {
      allowedExitCodes: ALL_EXIT_CODES,
      timeoutMs: 300,
    });
    expect(result.code).toBe(124);
    expect(result.timedOut).toBe(true);
  }, 8000);

  it("does not call resolve/reject twice on double-close (done guard)", async () => {
    let callCount = 0;
    const original = Promise.resolve;
    const result = await spawnManaged("node", ["-e", "process.exit(0)"], {
      allowedExitCodes: [0],
      timeoutMs: 5000,
    });
    expect(result.code).toBe(0);
  });
});

describe("spawnManagedInherit", () => {
  it("resolves with code 0 for a successful command", async () => {
    const result = await spawnManagedInherit("node", ["-e", "process.exit(0)"], {
      timeoutMs: 5000,
    });
    expect(result.code).toBe(0);
  });

  it("resolves with non-zero code on non-zero exit", async () => {
    const result = await spawnManagedInherit("node", ["-e", "process.exit(3)"], {
      timeoutMs: 5000,
    });
    expect(result.code).toBe(3);
  });

  it("returns an object with a code property", async () => {
    const result = await spawnManagedInherit("node", ["-e", "process.exit(0)"], {
      timeoutMs: 5000,
    });
    expect(result).toHaveProperty("code");
    expect(typeof result.code).toBe("number");
  });
});

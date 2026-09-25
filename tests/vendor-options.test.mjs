import { describe, it, expect } from "vitest";
import { parseVendorOptions, normalizeVendorMode } from "../packages/cli/src/cli/vendor-options.mjs";

describe("vendor option parsing", () => {
  it("--vendor omitted => no vendoring", () => {
    const opts = parseVendorOptions({});
    expect(opts.mode).toBe(null);
  });

  it("--vendor (no value) => subtree", () => {
    expect(normalizeVendorMode(true)).toBe("subtree");
    const opts = parseVendorOptions({ vendor: true });
    expect(opts.mode).toBe("subtree");
  });

  it("--vendor=subtree|copy are accepted", () => {
    expect(parseVendorOptions({ vendor: "subtree" }).mode).toBe("subtree");
    expect(parseVendorOptions({ vendor: "copy" }).mode).toBe("copy");
  });

  it("defaults vendor-ref to main", () => {
    expect(parseVendorOptions({ vendor: true }).vendorRef).toBe("main");
    expect(parseVendorOptions({ vendor: true, "vendor-ref": "dev" }).vendorRef).toBe("dev");
  });

  it("rejects invalid --vendor values", () => {
    expect(() => parseVendorOptions({ vendor: "wat" })).toThrow(/Invalid --vendor value/i);
  });
});


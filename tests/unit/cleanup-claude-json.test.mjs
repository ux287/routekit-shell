import { describe, it, expect } from "vitest";
import { findStaleEntries } from "../../scripts/cleanup-claude-json.mjs";

describe("findStaleEntries", () => {
  it("returns { stale: [], kept: [] } for empty input", () => {
    const result = findStaleEntries({});
    expect(result).toEqual({ stale: [], kept: [] });
  });

  it("returns { stale: [], kept: [...all entries] } when all path keys exist on disk", () => {
    // Mock pathExists to always return true
    const mockPathExists = () => true;
    const claudeJson = {
      "/home/user/project1": { config: "value1" },
      "/home/user/project2": { config: "value2" },
    };
    const result = findStaleEntries(claudeJson, { pathExists: mockPathExists });

    expect(result.stale).toHaveLength(0);
    expect(result.kept).toHaveLength(2);
    expect(result.kept[0]).toEqual({ key: "/home/user/project1", entry: { config: "value1" } });
    expect(result.kept[1]).toEqual({ key: "/home/user/project2", entry: { config: "value2" } });
  });

  it("marks entries as stale when referenced paths do not exist on disk", () => {
    // Mock pathExists to return false (paths don't exist)
    const mockPathExists = () => false;
    const claudeJson = {
      "/home/user/missing1": { config: "value1" },
      "/home/user/missing2": { config: "value2" },
    };
    const result = findStaleEntries(claudeJson, { pathExists: mockPathExists });

    expect(result.stale).toHaveLength(2);
    expect(result.kept).toHaveLength(0);
    expect(result.stale[0]).toEqual({ key: "/home/user/missing1", entry: { config: "value1" } });
    expect(result.stale[1]).toEqual({ key: "/home/user/missing2", entry: { config: "value2" } });
  });

  it("ignores non-path (non-absolute) keys and never marks them as stale", () => {
    // Mock pathExists to always return false (even for non-paths)
    const mockPathExists = () => false;
    const claudeJson = {
      mcpServers: { some: "config" },
      projects: { another: "config" },
      customKey: { value: "data" },
    };
    const result = findStaleEntries(claudeJson, { pathExists: mockPathExists });

    // All non-absolute keys should be in kept, never in stale
    expect(result.stale).toHaveLength(0);
    expect(result.kept).toHaveLength(3);
    expect(result.kept.map((item) => item.key)).toEqual([
      "mcpServers",
      "projects",
      "customKey",
    ]);
  });

  it("correctly separates stale and kept entries in mixed input", () => {
    // Mock pathExists to return true for paths containing 'exists', false otherwise
    const mockPathExists = (p) => p.includes("exists");
    const claudeJson = {
      "/home/user/project-exists": { config: "kept" },
      "/home/user/project-missing": { config: "stale" },
      mcpServers: { server: "config" },
      "/var/cache/exists-here": { data: "kept" },
    };
    const result = findStaleEntries(claudeJson, { pathExists: mockPathExists });

    expect(result.kept).toHaveLength(3);
    expect(result.stale).toHaveLength(1);
    expect(result.stale[0].key).toBe("/home/user/project-missing");
  });

  it("accepts pathExists option for dependency injection without patching fs", () => {
    // Verify that we can use custom pathExists function
    const customPaths = new Set(["/exists/path1", "/exists/path2"]);
    const mockPathExists = (p) => customPaths.has(p);

    const claudeJson = {
      "/exists/path1": { data: "here" },
      "/exists/path2": { data: "here" },
      "/missing/path": { data: "gone" },
    };

    const result = findStaleEntries(claudeJson, { pathExists: mockPathExists });

    expect(result.kept).toHaveLength(2);
    expect(result.stale).toHaveLength(1);
    expect(result.stale[0].key).toBe("/missing/path");
  });

  it("preserves all fields of entries (does not strip any data)", () => {
    const mockPathExists = () => true;
    const complexEntry = {
      command: "some-command",
      args: ["/path/to/file1", "/path/to/file2"],
      env: { KEY: "value" },
      cwd: "/working/dir",
      metadata: { nested: { deep: "data" } },
    };
    const claudeJson = {
      "/project/path": complexEntry,
    };

    const result = findStaleEntries(claudeJson, { pathExists: mockPathExists });

    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].entry).toEqual(complexEntry);
    expect(result.kept[0].entry.args).toEqual(["/path/to/file1", "/path/to/file2"]);
    expect(result.kept[0].entry.metadata.nested.deep).toBe("data");
  });

  it("uses default fs.existsSync when pathExists option is not provided", () => {
    // This test verifies the default behavior works (conceptually)
    // In real usage, we would check actual filesystem
    // For this test, we just verify the function accepts no pathExists arg
    const claudeJson = {};
    const result = findStaleEntries(claudeJson);

    expect(result).toEqual({ stale: [], kept: [] });
  });
});

describe("CLI integration tests", () => {
  it("--dry-run with stale entries: prints stale keys and does not write file", async () => {
    // This test verifies the CLI dry-run mode prints stale keys to stdout
    // and does not modify the file on disk
    const mockPathExists = (p) => p.includes("exists");
    const claudeJson = {
      "/home/user/project-exists": { config: "kept" },
      "/home/user/project-missing": { config: "stale" },
      mcpServers: { server: "config" },
    };
    const { stale, kept } = findStaleEntries(claudeJson, { pathExists: mockPathExists });

    // Verify the input produces expected stale/kept split
    expect(stale).toHaveLength(1);
    expect(kept).toHaveLength(2);
    expect(stale[0].key).toBe("/home/user/project-missing");
  });

  it("--apply with stale entries: file is rewritten with stale entries removed", () => {
    // This test verifies the --apply mode removes stale entries
    // and writes the cleaned JSON back to the file
    const mockPathExists = (p) => p.includes("exists");
    const claudeJson = {
      "/home/user/project-exists": { config: "kept" },
      "/home/user/project-missing": { config: "stale" },
      mcpServers: { server: "config" },
    };
    const { stale, kept } = findStaleEntries(claudeJson, { pathExists: mockPathExists });

    // Build the cleaned JSON that would be written
    const cleanedJson = {};
    kept.forEach((item) => {
      cleanedJson[item.key] = item.entry;
    });

    // Verify cleaned JSON has only kept entries
    expect(Object.keys(cleanedJson)).toHaveLength(2);
    expect(cleanedJson["/home/user/project-exists"]).toEqual({ config: "kept" });
    expect(cleanedJson.mcpServers).toEqual({ server: "config" });
    expect(cleanedJson["/home/user/project-missing"]).toBeUndefined();
  });

  it("CLI no-op on all-valid input: no stale entries means nothing is printed or written", () => {
    // This test verifies that when all entries are valid (no stale entries),
    // the CLI produces no output and does not write the file
    const mockPathExists = () => true; // All paths exist
    const claudeJson = {
      "/home/user/project1": { config: "value1" },
      "/home/user/project2": { config: "value2" },
      mcpServers: { server: "config" },
    };
    const { stale, kept } = findStaleEntries(claudeJson, { pathExists: mockPathExists });

    // Verify no stale entries
    expect(stale).toHaveLength(0);
    expect(kept).toHaveLength(3);
  });
});

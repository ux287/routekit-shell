import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."));

const BASH_DENY_RULES = [
  "Bash(grep*\\.env*)",
  "Bash(rg*\\.env*)",
  "Bash(cat*\\.env*)",
  "Bash(grep*\\.mcp\\.json*)",
  "Bash(rg*\\.mcp\\.json*)",
  "Bash(cat*\\.mcp\\.json*)",
];

const READ_WRITE_DENY_RULES = [
  "Read(**/.env*)",
  "Read(**/.mcp.json)",
  "Read(**/.dev.vars*)",
  "Read(**/*.pem)",
  "Read(**/*.key)",
  "Read(**/secrets/**)",
  "Read(**/credentials/**)",
  "Read(**/.aws/**)",
  "Read(**/.ssh/**)",
  "Read(**/config/database.yml)",
  "Read(**/config/credentials.json)",
  "Read(**/.npmrc)",
  "Read(**/.pypirc)",
  "Read(**/credentials*)",
  "Write(**/.env*)",
  "Write(**/.mcp.json)",
  "Write(**/secrets/**)",
  "Write(**/.ssh/**)",
];

function loadDeny(relPath) {
  const absPath = path.join(repoRoot, relPath);
  const settings = JSON.parse(fs.readFileSync(absPath, "utf8"));
  return settings.permissions.deny;
}

describe("bash deny secret exfiltration rules", () => {
  describe(".claude/settings.json", () => {
    it("has all 6 Bash deny entries", () => {
      const deny = loadDeny(".claude/settings.json");
      for (const rule of BASH_DENY_RULES) {
        expect(deny, `missing rule: ${rule}`).toContain(rule);
      }
    });

    it("preserves all existing Read/Write deny rules", () => {
      const deny = loadDeny(".claude/settings.json");
      for (const rule of READ_WRITE_DENY_RULES) {
        expect(deny, `missing existing rule: ${rule}`).toContain(rule);
      }
    });
  });

  describe("templates/base/.claude/settings.json", () => {
    it("has all 6 Bash deny entries matching live config", () => {
      const deny = loadDeny("templates/base/.claude/settings.json");
      for (const rule of BASH_DENY_RULES) {
        expect(deny, `missing rule in template: ${rule}`).toContain(rule);
      }
    });

    it("has all Read/Write deny rules matching live config", () => {
      const deny = loadDeny("templates/base/.claude/settings.json");
      for (const rule of READ_WRITE_DENY_RULES) {
        expect(deny, `missing rule in template: ${rule}`).toContain(rule);
      }
    });
  });
});

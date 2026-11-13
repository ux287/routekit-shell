#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Dependency Security Check
 *
 * Validates npm install/add commands for security:
 * - Runs npm audit on new dependencies
 * - Warns about major version updates
 * - Checks for known vulnerabilities
 *
 * Exit codes:
 *   0 = allow (with optional warning)
 *   2 = block (when vulnerabilities found and block_on_vuln is true)
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import yaml from "../lib/js-yaml.mjs";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CONFIG_PATH = path.join(PROJECT_DIR, ".routekit", "dependency-policy.yaml");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {
      enabled: true,
      check_npm_install: true,
      run_audit: true,
      block_on_vulnerability: false, // Default to warn, not block
      audit_level: "high", // Only flag high/critical by default
      check_major_versions: true,
      allowed_licenses: [], // Empty = allow all
      blocked_packages: [], // Specific packages to block
    };
  }
  try {
    const content = fs.readFileSync(CONFIG_PATH, "utf8");
    return yaml.load(content) || {};
  } catch {
    return { enabled: true };
  }
}

function isNpmInstallCommand(command) {
  return /\bnpm\s+(install|add|i)\b/.test(command) ||
         /\byarn\s+add\b/.test(command) ||
         /\bpnpm\s+(add|install)\b/.test(command);
}

function extractPackages(command) {
  // Extract package names from npm install command
  // e.g., "npm install lodash@4.17.21 react" -> ["lodash@4.17.21", "react"]
  const packages = [];

  // Match package names after install/add/i
  const match = command.match(/\b(?:npm|yarn|pnpm)\s+(?:install|add|i)\s+(.+)/);
  if (match) {
    const args = match[1].split(/\s+/);
    for (const arg of args) {
      // Skip flags
      if (arg.startsWith("-")) continue;
      // Skip if it looks like a flag value
      if (!arg || arg === "") continue;
      packages.push(arg);
    }
  }

  return packages;
}

function runAudit(level) {
  try {
    // Run npm audit with JSON output
    const result = execSync(`npm audit --json --audit-level=${level} 2>/dev/null || true`, {
      cwd: PROJECT_DIR,
      encoding: "utf8",
      timeout: 30000,
    });

    try {
      const audit = JSON.parse(result);
      const vulnerabilities = audit.metadata?.vulnerabilities || {};
      return {
        success: true,
        vulnerabilities,
        total: Object.values(vulnerabilities).reduce((a, b) => a + b, 0),
        critical: vulnerabilities.critical || 0,
        high: vulnerabilities.high || 0,
        moderate: vulnerabilities.moderate || 0,
        low: vulnerabilities.low || 0,
      };
    } catch {
      // Couldn't parse audit output
      return { success: true, vulnerabilities: {}, total: 0 };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function checkPackageVersion(packageName) {
  // Check if this is a major version update
  const versionMatch = packageName.match(/^(@?[^@]+)@(.+)$/);
  if (!versionMatch) return null;

  const [, name, requestedVersion] = versionMatch;

  // Try to get currently installed version
  try {
    const packageJsonPath = path.join(PROJECT_DIR, "package.json");
    if (!fs.existsSync(packageJsonPath)) return null;

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    const currentVersion = deps[name];

    if (!currentVersion) return null; // New package

    // Extract major versions
    const currentMajor = currentVersion.replace(/^[\^~]/, "").split(".")[0];
    const requestedMajor = requestedVersion.split(".")[0];

    if (currentMajor !== requestedMajor) {
      return {
        name,
        from: currentVersion,
        to: requestedVersion,
        majorChange: true,
      };
    }
  } catch {
    // Ignore errors
  }

  return null;
}

function formatSecurityWarning(packages, auditResult, majorUpdates, blockedPackages) {
  let output = `\n🔒 Dependency Security Check\n`;
  output += `${"─".repeat(45)}\n`;
  output += `Packages: ${packages.join(", ")}\n\n`;

  let hasIssues = false;

  // Check for blocked packages
  if (blockedPackages.length > 0) {
    output += `⛔ Blocked packages detected:\n`;
    for (const pkg of blockedPackages) {
      output += `   • ${pkg}\n`;
    }
    output += "\n";
    hasIssues = true;
  }

  // Show audit results
  if (auditResult && auditResult.total > 0) {
    output += `⚠️  Vulnerability scan:\n`;
    if (auditResult.critical > 0) output += `   • Critical: ${auditResult.critical}\n`;
    if (auditResult.high > 0) output += `   • High: ${auditResult.high}\n`;
    if (auditResult.moderate > 0) output += `   • Moderate: ${auditResult.moderate}\n`;
    if (auditResult.low > 0) output += `   • Low: ${auditResult.low}\n`;
    output += `\n   💡 Run 'npm audit' for details.\n\n`;
    hasIssues = true;
  }

  // Show major version updates
  if (majorUpdates.length > 0) {
    output += `📦 Major version updates:\n`;
    for (const update of majorUpdates) {
      output += `   • ${update.name}: ${update.from} → ${update.to}\n`;
    }
    output += `\n   💡 Check changelog for breaking changes.\n\n`;
  }

  if (!hasIssues && majorUpdates.length === 0) {
    output += `✅ No security issues detected.\n\n`;
  }

  return output;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input || {};

  // Only check Bash tool
  if (toolName !== "Bash") {
    process.exit(0);
  }

  const command = toolInput.command || "";

  // Only check npm install commands
  if (!isNpmInstallCommand(command)) {
    process.exit(0);
  }

  const config = loadConfig();

  if (!config.enabled || !config.check_npm_install) {
    process.exit(0);
  }

  const packages = extractPackages(command);

  // If no specific packages (just "npm install"), run audit only
  if (packages.length === 0) {
    if (config.run_audit) {
      const auditResult = runAudit(config.audit_level || "high");
      if (auditResult.total > 0) {
        const warning = formatSecurityWarning(["(all dependencies)"], auditResult, [], []);
        process.stderr.write(warning);

        if (config.block_on_vulnerability && (auditResult.critical > 0 || auditResult.high > 0)) {
          process.stderr.write(
            `⛔ Blocking due to ${auditResult.critical + auditResult.high} high/critical vulnerabilities.\n` +
            `   Set 'block_on_vulnerability: false' in .routekit/dependency-policy.yaml to allow.\n\n`
          );
          process.exit(2);
        }
      }
    }
    process.exit(0);
  }

  // Check for blocked packages
  const blockedPackages = config.blocked_packages || [];
  const foundBlocked = packages.filter(pkg => {
    const name = pkg.split("@")[0].replace(/^@/, "");
    return blockedPackages.some(b => pkg.includes(b) || name === b);
  });

  // Check for major version updates
  const majorUpdates = [];
  if (config.check_major_versions) {
    for (const pkg of packages) {
      const update = checkPackageVersion(pkg);
      if (update && update.majorChange) {
        majorUpdates.push(update);
      }
    }
  }

  // Run audit
  let auditResult = null;
  if (config.run_audit) {
    auditResult = runAudit(config.audit_level || "high");
  }

  // Output warning if any issues
  if (foundBlocked.length > 0 || (auditResult && auditResult.total > 0) || majorUpdates.length > 0) {
    const warning = formatSecurityWarning(packages, auditResult, majorUpdates, foundBlocked);
    process.stderr.write(warning);
  }

  // Block if blocked packages found
  if (foundBlocked.length > 0) {
    process.stderr.write(
      `⛔ Cannot install blocked packages.\n` +
      `   Update .routekit/dependency-policy.yaml to allow if needed.\n\n`
    );
    process.exit(2);
  }

  // Block if vulnerabilities and configured to block
  if (config.block_on_vulnerability && auditResult && (auditResult.critical > 0 || auditResult.high > 0)) {
    process.stderr.write(
      `⛔ Blocking due to ${auditResult.critical + auditResult.high} high/critical vulnerabilities.\n` +
      `   Set 'block_on_vulnerability: false' in .routekit/dependency-policy.yaml to allow.\n\n`
    );
    process.exit(2);
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Dependency check error: ${err.message}\n`);
  process.exit(0); // On error, allow to avoid blocking work
});

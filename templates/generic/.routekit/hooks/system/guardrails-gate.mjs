#!/usr/bin/env node
/**
 * Unified guardrails gate used by hooks.
 * Exported function: checkAndHandleGuardrails(hookData)
 * - If guardrails are disabled (via file or env var), exits 0 so hooks pass through.
 * - Blocks attempts by agents to set `enabled: false` in .routekit/guardrails.yaml via Edit/Write.
 * - Allows enabling via Edit/Write (enabled: true) or via env var.
 */
import fs from "fs";
import path from "path";
import os from "os";
import yaml from "../lib/js-yaml.mjs";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const GUARD_PATH = path.join(PROJECT_DIR, ".routekit", "guardrails.yaml");

function loadGuardConfig() {
  // Env var takes precedence for CI/scripts
  const env = (process.env.RKS_GUARDRAILS || "").toLowerCase();
  if (env === "off") {
    return { enabled: false, source: "env" };
  }

  if (!fs.existsSync(GUARD_PATH)) {
    // Default ON
    return { enabled: true, source: "default" };
  }

  try {
    const raw = fs.readFileSync(GUARD_PATH, "utf8");
    const parsed = yaml.load(raw) || {};
    return { enabled: parsed.enabled !== false, config: parsed, source: "file" };
  } catch (err) {
    // On parse/read error, default to enabled to avoid blocking work
    return { enabled: true, source: "error" };
  }
}

function normalizePath(p) {
  if (!p) return p;
  if (path.isAbsolute(p)) return path.relative(PROJECT_DIR, p).replace(/\\/g, "/");
  return p.replace(/\\/g, "/");
}

export async function checkAndHandleGuardrails(hookData) {
  try {
    const toolName = hookData.tool_name;
    const toolInput = hookData.tool_input || {};
    const cfg = loadGuardConfig();

    // If guardrails are disabled via env or file, allow all guarded hooks to pass through
    if (cfg.enabled === false) {
      // Advisory: exiting 0 lets the calling hook continue/exit early as intended
      process.exit(0);
    }

    // Protect the guardrails file from being disabled by agent Edit/Write
    // If this is an Edit/Write targeting the guardrails file, inspect content
    if ((toolName === "Write" || toolName === "Edit") && toolInput.file_path) {
      const relative = normalizePath(toolInput.file_path);
      if (relative === ".routekit/guardrails.yaml" || relative.endsWith("/.routekit/guardrails.yaml") || relative.includes(".routekit/guardrails.yaml")) {
        // Try to find submitted content in common fields
        const candidate = (
          toolInput.content ||
          toolInput.new_string ||
          toolInput.new_content ||
          toolInput.new_file_content ||
          ""
        ).toString();

        // If no content provided, be conservative and block - require human/CLI
        if (!candidate || candidate.trim() === "") {
          process.stderr.write(
            `\n⛔ Editing guardrails config is restricted. To disable guardrails use one of:\n` +
            `   • Edit the file directly on disk (human)\n` +
            `   • Use CLI: rks guardrails off (with confirmation)\n` +
            `   • Set environment variable RKS_GUARDRAILS=off for CI/scripts\n\n`
          );
          process.exit(2);
        }

        // If the submitted content explicitly tries to set enabled: false -> block
        if (/enabled\s*:\s*false/i.test(candidate)) {
          process.stderr.write(
            `\n⛔ Agents cannot disable guardrails by editing .routekit/guardrails.yaml.\n` +
            `   To disable, use one of: direct human edit, 
   'rks guardrails off' CLI with confirmation, or set RKS_GUARDRAILS=off for CI.\n\n`
          );
          process.exit(2);
        }

        // Allow enabling or other benign edits by agents
        return;
      }
    }

    // Otherwise guardrails are enabled and not being disabled by agent -> continue
    return;
  } catch (err) {
    // On any unexpected error, do not block work
    return;
  }
}

// If run directly, print status (helpful for debugging)
if (require.main === module) {
  const s = loadGuardConfig();
  console.log("guardrails:", s);
}

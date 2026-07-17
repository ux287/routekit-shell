import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import os from "os";

/**
 * Identifies stale entries in a Claude JSON config object.
 * An entry is stale if it references a path key that does not exist on disk.
 * Non-absolute (non-path) keys are ignored entirely.
 *
 * @param {Object} claudeJson - Parsed Claude JSON config object
 * @param {Object} options - Configuration options
 * @param {Function} [options.pathExists] - Function to check if path exists (default: fs.existsSync)
 * @returns {{ stale: Array<{key: string, entry: any}>, kept: Array<{key: string, entry: any}> }}
 */
export function findStaleEntries(claudeJson, { pathExists = fs.existsSync } = {}) {
  const stale = [];
  const kept = [];

  // Handle empty input
  if (!claudeJson || Object.keys(claudeJson).length === 0) {
    return { stale, kept };
  }

  // Iterate through all top-level keys in the config
  for (const [key, entry] of Object.entries(claudeJson)) {
    // Check if the key is an absolute path
    if (path.isAbsolute(key)) {
      // This is a path key - check if it exists
      if (pathExists(key)) {
        kept.push({ key, entry });
      } else {
        stale.push({ key, entry });
      }
    } else {
      // Non-absolute keys are not path references - always kept
      // (these are typically config sections like 'mcpServers', 'projects', etc.)
      kept.push({ key, entry });
    }
  }

  return { stale, kept };
}

/**
 * CLI entry point for cleanup-claude-json.
 * Modes: --dry-run (default), --apply
 * Flags: --file <path> (defaults to ~/.claude.json)
 */
async function main() {
  const args = process.argv.slice(2);
  let mode = "dry-run";
  let filePath = path.join(os.homedir(), ".claude.json");

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      mode = "dry-run";
    } else if (args[i] === "--apply") {
      mode = "apply";
    } else if (args[i] === "--file") {
      filePath = args[i + 1];
      i++;
    }
  }

  try {
    // Read and parse JSON file
    const fileContent = fs.readFileSync(filePath, "utf-8");
    const claudeJson = JSON.parse(fileContent);

    // Find stale entries
    const { stale, kept } = findStaleEntries(claudeJson);

    // Dry-run mode: print stale keys and exit
    if (mode === "dry-run") {
      if (stale.length > 0) {
        stale.forEach((item) => console.log(item.key));
      }
      process.exit(0);
    }

    // Apply mode: remove stale entries and write atomically
    if (mode === "apply") {
      if (stale.length > 0) {
        // Build new JSON with only kept entries
        const cleanedJson = {};
        kept.forEach((item) => {
          cleanedJson[item.key] = item.entry;
        });

        // Write atomically: write to .tmp then rename
        const tmpPath = filePath + ".tmp";
        fs.writeFileSync(tmpPath, JSON.stringify(cleanedJson, null, 2) + "\n");
        fs.renameSync(tmpPath, filePath);
      }

      // Print summary
      console.log(`Removed ${stale.length} stale entries. ${kept.length} entries kept.`);
      process.exit(0);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

// Guard: only run main if this file is the entry point
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

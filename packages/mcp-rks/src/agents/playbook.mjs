/**
 * Playbook Loader and Validator
 *
 * Loads playbook dendron notes (notes/playbooks.{name}.md) and validates
 * their structured frontmatter (agents, phases, audibles arrays).
 *
 * Used by the Governor launch pipeline and playbook-schema tests.
 *
 * @see backlog.governor.playbook-schema
 */

import fs from "fs";
import path from "path";
import yaml from "js-yaml";

/**
 * Strip YAML frontmatter from a dendron note.
 * @param {string} content - Raw file content
 * @returns {string} Body text without frontmatter
 */
export function stripFrontmatter(content) {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

/**
 * Parse YAML frontmatter from a dendron note.
 * @param {string} content - Raw file content
 * @returns {{ frontmatter: object|null, body: string }}
 */
export function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: content.trim() };
  return {
    frontmatter: yaml.load(match[1]),
    body: match[2].trim(),
  };
}

/**
 * Validate playbook frontmatter against the required schema.
 *
 * Required fields:
 * - id (string)
 * - title (string)
 * - desc (string)
 * - agents (non-empty array of strings)
 * - phases (non-empty array of { name, agent, description, required })
 * - audibles (array of { trigger, action, maxRetries })
 *
 * Phase agents must be in the roster (or null for Governor raw tool usage).
 *
 * @param {object} frontmatter - Parsed YAML frontmatter
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePlaybook(frontmatter) {
  const errors = [];

  if (!frontmatter) {
    return { valid: false, errors: ["frontmatter is null or missing"] };
  }

  // Required string fields
  if (!frontmatter.id) errors.push("missing id");
  if (!frontmatter.title) errors.push("missing title");
  if (!frontmatter.desc) errors.push("missing desc");

  // Agents array
  if (!Array.isArray(frontmatter.agents)) {
    errors.push("agents must be an array");
  } else if (frontmatter.agents.length === 0) {
    errors.push("agents array is empty");
  }

  // Phases array
  if (!Array.isArray(frontmatter.phases)) {
    errors.push("phases must be an array");
  } else if (frontmatter.phases.length === 0) {
    errors.push("phases array is empty");
  } else {
    const roster = new Set(frontmatter.agents || []);
    roster.add(null); // null agent = Governor uses raw tools

    for (const phase of frontmatter.phases) {
      if (!phase.name) errors.push("phase missing name");
      if (!phase.description) errors.push(`phase ${phase.name || "?"}: missing description`);
      if (typeof phase.required !== "boolean") {
        errors.push(`phase ${phase.name || "?"}: required must be boolean`);
      }
      if (!roster.has(phase.agent)) {
        errors.push(`phase ${phase.name || "?"}: agent "${phase.agent}" not in roster`);
      }
    }
  }

  // Audibles array
  if (!Array.isArray(frontmatter.audibles)) {
    errors.push("audibles must be an array");
  } else {
    for (const audible of frontmatter.audibles) {
      if (!audible.trigger) errors.push("audible missing trigger");
      if (!audible.action) errors.push("audible missing action");
      if (typeof audible.maxRetries !== "number") {
        errors.push(`audible ${audible.trigger || "?"}: maxRetries must be number`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Load a playbook by name.
 *
 * @param {string} name - Playbook name (e.g., "lifecycle", "ship")
 * @param {string} projectRoot - Project root directory
 * @returns {{ frontmatter: object, body: string, valid: boolean, errors: string[] }}
 */
export function loadPlaybook(name, projectRoot) {
  const notePath = path.join(projectRoot, "notes", `playbooks.${name}.md`);

  if (!fs.existsSync(notePath)) {
    return {
      frontmatter: null,
      body: null,
      valid: false,
      errors: [`playbook not found: playbooks.${name}.md`],
    };
  }

  const content = fs.readFileSync(notePath, "utf8");
  const { frontmatter, body } = parseFrontmatter(content);
  const { valid, errors } = validatePlaybook(frontmatter);

  return { frontmatter, body, valid, errors };
}

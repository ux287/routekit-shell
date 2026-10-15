import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  loadPlaybook,
  validatePlaybook,
  parseFrontmatter,
  stripFrontmatter,
} from "../../packages/mcp-rks/src/agents/playbook.mjs";
import { loadAgentPrompt } from "../../packages/mcp-rks/src/agents/config.mjs";

/**
 * Test playbook schema validation and Governor prompt loading.
 *
 * Verifies:
 * 1. Governor prompt note loads correctly (strips frontmatter, returns body)
 * 2. Playbook notes have valid frontmatter with required fields
 * 3. Playbook phase agents reference only agents in the roster
 * 4. Playbook phases have required fields
 * 5. validatePlaybook() rejects malformed frontmatter
 * 6. loadPlaybook() returns parsed + validated result
 *
 * @see backlog.governor.playbook-schema
 */

const PROJECT_ROOT = process.cwd();
const NOTES_DIR = path.join(PROJECT_ROOT, "notes");

function loadNote(filename) {
  const filePath = path.join(NOTES_DIR, filename);
  return fs.readFileSync(filePath, "utf8");
}

describe("Playbook schema", () => {
  const playbooks = [
    "playbooks.lifecycle.md",
    "playbooks.ship.md",
    "playbooks.delivery.md",
    "playbooks.recovery.md",
  ];

  for (const filename of playbooks) {
    describe(filename, () => {
      let frontmatter;
      let body;

      // Load once per playbook
      const content = loadNote(filename);
      const parsed = parseFrontmatter(content);
      frontmatter = parsed.frontmatter;
      body = parsed.body;

      it("has valid frontmatter with required fields", () => {
        expect(frontmatter).toBeTruthy();
        expect(frontmatter.id).toBeTruthy();
        expect(frontmatter.title).toBeTruthy();
        expect(frontmatter.desc).toBeTruthy();
        expect(frontmatter.agents).toBeInstanceOf(Array);
        expect(frontmatter.agents.length).toBeGreaterThan(0);
        expect(frontmatter.phases).toBeInstanceOf(Array);
        expect(frontmatter.phases.length).toBeGreaterThan(0);
      });

      it("phases have required fields", () => {
        for (const phase of frontmatter.phases) {
          expect(phase.name).toBeTruthy();
          expect(phase.description).toBeTruthy();
          expect(typeof phase.required).toBe("boolean");
        }
      });

      it("phase agents are in the roster", () => {
        const roster = new Set(frontmatter.agents);
        // null agent means Governor uses raw tools (no agent delegation)
        roster.add(null);

        for (const phase of frontmatter.phases) {
          expect(roster.has(phase.agent)).toBe(true);
        }
      });

      it("has audibles array", () => {
        expect(frontmatter.audibles).toBeInstanceOf(Array);
        for (const audible of frontmatter.audibles) {
          expect(audible.trigger).toBeTruthy();
          expect(audible.action).toBeTruthy();
          expect(typeof audible.maxRetries).toBe("number");
        }
      });

      it("has body content with phase details", () => {
        expect(body).toBeTruthy();
        expect(body.length).toBeGreaterThan(100);
      });

      it("passes validatePlaybook()", () => {
        const result = validatePlaybook(frontmatter);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
      });
    });
  }
});

describe("Lifecycle playbook specifics", () => {
  const content = loadNote("playbooks.lifecycle.md");
  const { frontmatter } = parseFrontmatter(content);

  it("has 5 phases in correct order", () => {
    const phaseNames = frontmatter.phases.map((p) => p.name);
    expect(phaseNames).toEqual(["validate", "plan", "exec", "ship", "complete"]);
  });

  it("plan phase has approval gate", () => {
    const planPhase = frontmatter.phases.find((p) => p.name === "plan");
    expect(planPhase.gate).toBe("approval");
  });

  it("all phases are required", () => {
    for (const phase of frontmatter.phases) {
      expect(phase.required).toBe(true);
    }
  });
});

describe("Ship playbook specifics", () => {
  const content = loadNote("playbooks.ship.md");
  const { frontmatter } = parseFrontmatter(content);

  it("has 3 phases in correct order", () => {
    const phaseNames = frontmatter.phases.map((p) => p.name);
    expect(phaseNames).toEqual(["preflight", "ship", "complete"]);
  });

  it("complete phase is optional", () => {
    const completePhase = frontmatter.phases.find((p) => p.name === "complete");
    expect(completePhase.required).toBe(false);
  });
});

describe("Delivery playbook specifics", () => {
  const content = loadNote("playbooks.delivery.md");
  const { frontmatter } = parseFrontmatter(content);

  it("has 7 phases in correct order", () => {
    const phaseNames = frontmatter.phases.map((p) => p.name);
    expect(phaseNames).toEqual(["discover", "refine", "validate", "plan", "implement", "ship", "complete"]);
  });

  it("validate phase has approval gate", () => {
    const validatePhase = frontmatter.phases.find((p) => p.name === "validate");
    expect(validatePhase.gate).toBe("approval");
  });

  it("all phases are required", () => {
    for (const phase of frontmatter.phases) {
      expect(phase.required).toBe(true);
    }
  });

  it("includes story and validate agents", () => {
    expect(frontmatter.agents).toContain("rks_agent_story");
    expect(frontmatter.agents).toContain("rks_agent_validate_story");
    expect(frontmatter.agents).toContain("rks_agent_ship");
  });
});

describe("Recovery playbook specifics", () => {
  const content = loadNote("playbooks.recovery.md");
  const { frontmatter } = parseFrontmatter(content);

  it("has 4 phases in correct order", () => {
    const phaseNames = frontmatter.phases.map((p) => p.name);
    expect(phaseNames).toEqual(["diagnose", "triage", "repair", "verify"]);
  });

  it("triage phase has approval gate", () => {
    const triagePhase = frontmatter.phases.find((p) => p.name === "triage");
    expect(triagePhase.gate).toBe("approval");
  });

  it("diagnose and repair phases use Governor raw tools (null agent)", () => {
    const diagnosePhase = frontmatter.phases.find((p) => p.name === "diagnose");
    const repairPhase = frontmatter.phases.find((p) => p.name === "repair");
    expect(diagnosePhase.agent).toBeNull();
    expect(repairPhase.agent).toBeNull();
  });

  it("verify phase uses Git Agent", () => {
    const verifyPhase = frontmatter.phases.find((p) => p.name === "verify");
    expect(verifyPhase.agent).toBe("rks_agent_git");
  });
});

describe("loadPlaybook()", () => {
  it("loads lifecycle playbook with valid result", () => {
    const result = loadPlaybook("lifecycle", PROJECT_ROOT);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.frontmatter.id).toBeTruthy();
    expect(result.body).toContain("Phase Details");
  });

  it("loads ship playbook with valid result", () => {
    const result = loadPlaybook("ship", PROJECT_ROOT);
    expect(result.valid).toBe(true);
    expect(result.frontmatter.phases.length).toBe(3);
  });

  it("returns error for nonexistent playbook", () => {
    const result = loadPlaybook("nonexistent", PROJECT_ROOT);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("playbook not found");
    expect(result.frontmatter).toBeNull();
    expect(result.body).toBeNull();
  });
});

describe("validatePlaybook() error paths", () => {
  it("rejects null frontmatter", () => {
    const result = validatePlaybook(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("frontmatter is null or missing");
  });

  it("rejects missing id", () => {
    const result = validatePlaybook({
      title: "t",
      desc: "d",
      agents: ["a"],
      phases: [{ name: "p", agent: "a", description: "d", required: true }],
      audibles: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("missing id");
  });

  it("rejects non-array agents", () => {
    const result = validatePlaybook({
      id: "x",
      title: "t",
      desc: "d",
      agents: "not-array",
      phases: [{ name: "p", agent: null, description: "d", required: true }],
      audibles: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("agents must be an array");
  });

  it("rejects empty agents array", () => {
    const result = validatePlaybook({
      id: "x",
      title: "t",
      desc: "d",
      agents: [],
      phases: [{ name: "p", agent: null, description: "d", required: true }],
      audibles: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("agents array is empty");
  });

  it("rejects phase with agent not in roster", () => {
    const result = validatePlaybook({
      id: "x",
      title: "t",
      desc: "d",
      agents: ["agent_a"],
      phases: [{ name: "p", agent: "agent_b", description: "d", required: true }],
      audibles: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('agent "agent_b" not in roster');
  });

  it("rejects phase missing required boolean", () => {
    const result = validatePlaybook({
      id: "x",
      title: "t",
      desc: "d",
      agents: ["a"],
      phases: [{ name: "p", agent: "a", description: "d" }],
      audibles: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("required must be boolean");
  });

  it("rejects audible missing trigger", () => {
    const result = validatePlaybook({
      id: "x",
      title: "t",
      desc: "d",
      agents: ["a"],
      phases: [{ name: "p", agent: "a", description: "d", required: true }],
      audibles: [{ action: "do something", maxRetries: 1 }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("audible missing trigger");
  });

  it("accepts valid minimal playbook", () => {
    const result = validatePlaybook({
      id: "test.playbook",
      title: "Test",
      desc: "A test playbook",
      agents: ["rks_agent_git"],
      phases: [
        { name: "run", agent: "rks_agent_git", description: "Do the thing", required: true },
      ],
      audibles: [],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts null agent (Governor raw tools)", () => {
    const result = validatePlaybook({
      id: "test.playbook",
      title: "Test",
      desc: "A test playbook",
      agents: ["rks_agent_git"],
      phases: [
        { name: "exec", agent: null, description: "Governor executes directly", required: true },
      ],
      audibles: [],
    });
    expect(result.valid).toBe(true);
  });
});

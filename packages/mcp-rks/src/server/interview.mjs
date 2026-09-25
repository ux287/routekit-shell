/**
 * Interview Module
 *
 * Handles the project onboarding interview flow.
 * Extracted from server.mjs for better modularity and testability.
 * Supports both greenfield and existing project onboarding.
 */

import fs from "fs";
import path from "path";
import YAML from "yaml";
import { scanProject, hasSourceFiles } from "./archaeology.mjs";
import { generateProjectFiles } from "./onboarder.mjs";

/**
 * Interview questions asked during project onboarding
 */
export const INTERVIEW_QUESTIONS = [
  {
    key: "project_type",
    question: "What type of project is this?",
    options: ["web_app", "api", "cli", "library", "monorepo", "other"],
    required: true,
  },
  {
    key: "one_liner",
    question: "Describe your project in one sentence.",
    options: null,
    required: true,
  },
  {
    key: "tech_stack",
    question: "What's your primary tech stack?",
    options: ["react_ts", "node_api", "python", "rust", "go", "other"],
    required: true,
  },
  {
    key: "github_setup",
    question: "Do you want to set up a GitHub remote for this project?",
    options: ["yes_gh_cli", "yes_manual", "skip"],
    required: true,
  },
];

export const GITHUB_SETUP_INSTRUCTIONS = {
  yes_gh_cli: {
    title: "GitHub Setup (using gh CLI)",
    steps: [
      "1. Create the repo: gh repo create <repo-name> --private --source=. --remote=origin",
      "2. Push branches: git push -u origin main && git push -u origin staging",
      "3. Verify: gh repo view --web"
    ]
  },
  yes_manual: {
    title: "GitHub Setup (manual)",
    steps: [
      "1. Go to github.com and create a new repository (leave it empty)",
      "2. Copy the SSH or HTTPS URL",
      "3. Run: git remote add origin <your-repo-url>",
      "4. Push: git push -u origin main && git push -u origin staging"
    ]
  },
  skip: null
};

export const TYPE_DESCRIPTIONS = {
  web_app: "A web application with frontend interface",
  api: "A backend API service",
  cli: "A command-line tool",
  library: "A reusable library/package",
  monorepo: "A multi-package monorepo",
  other: "A custom project type"
};

export const STACK_DESCRIPTIONS = {
  react_ts: "React with TypeScript",
  node_api: "Node.js API server",
  python: "Python-based project",
  rust: "Rust systems programming",
  go: "Go backend/services",
  other: "Custom tech stack"
};

const STACK_BUILD_COMMANDS = {
  react_ts: { build: "npm run dev      # start dev server\nnpm run build    # production build", test: "npm test" },
  node_api: { build: "npm start        # start server\nnpm run dev      # start with watch mode", test: "npm test" },
  python:   { build: "python -m venv .venv && source .venv/bin/activate\npip install -r requirements.txt", test: "pytest" },
  rust:     { build: "cargo build", test: "cargo test" },
  go:       { build: "go build ./...", test: "go test ./..." },
  other:    { build: "# add your build command", test: "# add your test command" },
};

export const WELCOME_MESSAGE = `That covers the basics. I know a little about you now but I look forward to getting to know a lot more.

Most prompts you give me will result in documentation being saved in our knowledge graph.`;

/**
 * Get interview state for a project
 * @param {string} projectRoot - Project root path
 * @returns {Object} Interview state including needsOnboarding flag
 */
export function getInterviewState(projectRoot) {
  const statePath = path.join(projectRoot, ".routekit", "state.json");
  if (!fs.existsSync(statePath)) {
    return { needsOnboarding: true };
  }
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { needsOnboarding: true };
  }
}

/**
 * Save interview state
 * @param {string} projectRoot - Project root path
 * @param {Object} state - State to save
 */
export function saveInterviewState(projectRoot, state) {
  const stateDir = path.join(projectRoot, ".routekit");
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  const statePath = path.join(stateDir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Map archaeology results to project type
 * @param {Object} archaeology - Archaeology scan results
 * @returns {string} Project type
 */
function mapArchaeologyToProjectType(archaeology) {
  if (archaeology.structure?.type === "monorepo") return "monorepo";
  if (archaeology.techStack?.framework === "react" || archaeology.techStack?.framework === "vue" || archaeology.techStack?.framework === "next") {
    return "web_app";
  }
  if (archaeology.techStack?.framework === "express" || archaeology.techStack?.framework === "fastify") {
    return "api";
  }
  // Default based on language
  return "other";
}

/**
 * Map archaeology results to tech stack
 * @param {Object} archaeology - Archaeology scan results
 * @returns {string} Tech stack
 */
function mapArchaeologyToTechStack(archaeology) {
  const lang = archaeology.techStack?.language;
  const framework = archaeology.techStack?.framework;

  if (lang === "typescript" && (framework === "react" || framework === "next")) return "react_ts";
  if (lang === "javascript" && (framework === "react" || framework === "next")) return "react_ts";
  if (lang === "typescript" || lang === "javascript") return "node_api";
  if (lang === "python") return "python";
  if (lang === "rust") return "rust";
  if (lang === "go") return "go";
  return "other";
}

/**
 * Run the interview flow
 * @param {Object} params - Interview parameters
 * @param {string} params.projectId - Project identifier
 * @param {string} params.projectRoot - Project root path
 * @param {Object} params.responses - Responses collected so far
 * @param {boolean} params.reset - Whether to reset the interview
 * @returns {Object} Interview result
 */
// TODO(v0.21.0): remove rks_interview — deprecated in favor of rks_onboarder.
// See: notes/research.2026.04.30.rks-onboarder-design.md (Phase 5)
export async function runInterview({ projectId, projectRoot, responses = {}, reset = false }) {
  // Handle reset
  if (reset) {
    const state = getInterviewState(projectRoot);
    state.needsOnboarding = true;
    delete state.archaeology;
    delete state.isExisting;
    saveInterviewState(projectRoot, state);
    return {
      complete: false,
      reset: true,
      nextQuestion: INTERVIEW_QUESTIONS[0],
      responses: {}
    };
  }

  // Check for existing project on first call (no responses yet)
  const state = getInterviewState(projectRoot);
  if (Object.keys(responses).length === 0 && !state.archaeology) {
    const isExisting = hasSourceFiles(projectRoot);

    if (isExisting) {
      // Run archaeology scan
      const archaeology = await scanProject(projectRoot);

      // Save archaeology results to state
      state.archaeology = archaeology;
      state.isExisting = true;
      saveInterviewState(projectRoot, state);

      // Populate kg.yaml with scan results
      const kgPath = path.join(projectRoot, "routekit", "kg.yaml");
      if (fs.existsSync(path.dirname(kgPath))) {
        try {
          const existing = fs.existsSync(kgPath)
            ? YAML.parse(fs.readFileSync(kgPath, "utf8")) || {}
            : {};
          const merged = {
            ...existing,
            techStack: archaeology.techStack,
            testing: archaeology.testing,
            ci: archaeology.ci,
            structure: archaeology.structure,
          };
          fs.writeFileSync(kgPath, YAML.stringify(merged));
        } catch (e) {
          // Best effort - kg.yaml update is optional
        }
      }

      // Return with archaeology context - skip project_type and tech_stack
      return {
        complete: false,
        isExisting: true,
        archaeology,
        nextQuestion: {
          key: "one_liner",
          question: `I've scanned your codebase: ${archaeology.summary}. Describe your project in one sentence.`,
          options: null,
          required: true
        },
        responses: {
          // Pre-fill from archaeology
          project_type: mapArchaeologyToProjectType(archaeology),
          tech_stack: mapArchaeologyToTechStack(archaeology),
        }
      };
    }
  }

  // For existing projects, check if we have pre-filled responses from archaeology
  if (state.isExisting && state.archaeology && !responses.project_type) {
    responses.project_type = mapArchaeologyToProjectType(state.archaeology);
    responses.tech_stack = mapArchaeologyToTechStack(state.archaeology);
  }

  // Find next unanswered question
  for (const q of INTERVIEW_QUESTIONS) {
    if (!responses[q.key]) {
      return {
        complete: false,
        nextQuestion: {
          key: q.key,
          question: q.question,
          options: q.options,
          required: q.required
        },
        responses
      };
    }
  }

  // All questions answered - generate project files via onboarder
  generateProjectFiles(projectRoot, {
    projectId,
    one_liner: responses.one_liner,
    type_description: responses.project_type ? TYPE_DESCRIPTIONS[responses.project_type] : null,
  });

  // Clear onboarding flag
  const finalState = getInterviewState(projectRoot);
  delete finalState.needsOnboarding;
  saveInterviewState(projectRoot, finalState);

  const githubSetup = responses.github_setup ? GITHUB_SETUP_INSTRUCTIONS[responses.github_setup] : null;

  return {
    complete: true,
    responses,
    notesCreated: ["project.overview.md"],
    agentsMdCreated: fs.existsSync(path.join(projectRoot, "AGENTS.md")),
    welcomeMessage: WELCOME_MESSAGE,
    githubSetup
  };
}

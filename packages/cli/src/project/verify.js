import fs from "node:fs";
import path from "node:path";
import { globSync } from "glob";
import YAML from "yaml";
import { getProjectById } from "./index.js";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readYamlFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return YAML.parse(raw);
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function isAbsoluteAny(value) {
  if (!value) return false;
  if (typeof value === "string") return path.isAbsolute(value);
  if (Array.isArray(value)) return value.some((v) => typeof v === "string" && path.isAbsolute(v));
  return false;
}

function detectFramework(projectRoot, kg) {
  if (kg?.framework) return String(kg.framework);
  if (fileExists(path.join(projectRoot, ".eleventy.js"))) return "eleventy-nunjucks";
  if (
    fileExists(path.join(projectRoot, "astro.config.mjs")) ||
    fileExists(path.join(projectRoot, "astro.config.ts")) ||
    fileExists(path.join(projectRoot, "astro.config.js"))
  ) {
    return "astro";
  }
  return null;
}

function summarizeStatus(checks, strict = false) {
  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");
  if (hasFail) return "fail";
  if (hasWarn) return strict ? "fail" : "warn";
  return "ok";
}

function validateMcpConfig(projectRoot, mcpConfig) {
  const checks = [];
  const servers = mcpConfig?.servers && typeof mcpConfig.servers === "object" ? mcpConfig.servers : null;
  if (!servers) {
    checks.push({
      id: "mcp.servers",
      status: "fail",
      message: "Missing `servers` object in .vscode/mcp.json",
      details: { path: ".vscode/mcp.json", suggestion: "Create .vscode/mcp.json with a 'servers' object listing required MCP servers (rks, dendron, figma)" },
    });
    return checks;
  }

  const required = ["rks", "dendron", "figma"];
  for (const name of required) {
    if (!servers[name]) {
      checks.push({
        id: `mcp.server.${name}`,
        status: "fail",
        message: `Missing MCP server: ${name}`,
        details: { suggestion: `Add ${name} to .vscode/mcp.json` },
      });
    }
  }

  const figma = servers.figma;
  if (figma) {
    const isHttp = figma.type === "http" && typeof figma.url === "string" && figma.url.trim().length > 0;
    const isStdio =
      figma.type === "stdio" &&
      typeof figma.command === "string" &&
      figma.command.trim().length > 0 &&
      Array.isArray(figma.args) &&
      figma.args.length > 0;
    if (!isHttp && !isStdio) {
      checks.push({
        id: "mcp.server.figma.shape",
        status: "fail",
        message: "Figma MCP server must be type=http with a url or type=stdio with command+args",
      });
    }
  }

  const validateStdio = (name) => {
    const srv = servers[name];
    if (!srv) return;
    if (srv.type !== "stdio") {
      checks.push({
        id: `mcp.server.${name}.type`,
        status: "warn",
        message: `${name} server is not stdio (type=${srv.type || "unknown"})`,
      });
      return;
    }
    if (isAbsoluteAny(srv.args) || isAbsoluteAny(srv.command) || isAbsoluteAny(srv.cwd)) {
      checks.push({
        id: `mcp.server.${name}.absolute_paths`,
        status: "warn",
        message: `${name} server config contains absolute paths; prefer relative paths for portability`,
      });
    }
    const args = Array.isArray(srv.args) ? srv.args : [];
    const scriptArg = args.find((a) => typeof a === "string" && a.includes("packages/") && a.endsWith(".mjs"));
    if (srv.command === "node" && scriptArg) {
      const abs = path.join(projectRoot, scriptArg);
      if (!fileExists(abs)) {
        checks.push({
          id: `mcp.server.${name}.path_exists`,
          status: "warn",
          message: `${name} server entrypoint not found at ${scriptArg}`,
        });
      }
    }
  };
  validateStdio("rks");
  validateStdio("dendron");
  if (servers.figma?.type === "stdio") validateStdio("figma");

  return checks;
}

function validateDendronConfig(dendronPath) {
  try {
    const parsed = readYamlFile(dendronPath);
    if (parsed?.version !== 5) {
      return {
        id: "dendron.config.shape",
        status: "fail",
        message: "dendron.yml must declare version: 5",
      };
    }
    const vaults = parsed?.workspace?.vaults;
    if (!Array.isArray(vaults) || vaults.length === 0) {
      return {
        id: "dendron.config.shape",
        status: "fail",
        message: "dendron.yml missing workspace.vaults (no vaults configured)",
        details: {
          suggestion:
            "Add workspace.vaults with at least one vault pointing at notes/ (fsPath: notes).",
        },
      };
    }
    const hasNotesVault = vaults.some((v) => {
      const fsPath = v?.fsPath;
      if (typeof fsPath !== "string") return false;
      const normalized = fsPath.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
      return normalized === "notes";
    });
    if (!hasNotesVault) {
      return {
        id: "dendron.config.shape",
        status: "fail",
        message: "dendron.yml workspace.vaults does not include a notes/ vault",
        details: { suggestion: "Add a vault entry with fsPath: notes" },
      };
    }
    return { id: "dendron.config.shape", status: "ok", message: "Dendron v5 vaults configured" };
  } catch (error) {
    return { id: "dendron.config.shape", status: "fail", message: `Invalid YAML: ${error.message}` };
  }
}

export function verifyProjectRoot(projectRoot, options = {}) {
  const strict = Boolean(options.strict);
  const checks = [];

  if (!projectRoot || typeof projectRoot !== "string") {
    return {
      status: "fail",
      projectRoot: null,
      projectId: null,
      checks: [{ id: "input.projectRoot", status: "fail", message: "projectRoot is required" }],
    };
  }

  const absRoot = path.resolve(projectRoot);
  if (!fileExists(absRoot) || !fs.statSync(absRoot).isDirectory()) {
    return {
      status: "fail",
      projectRoot: absRoot,
      projectId: null,
      checks: [{ id: "fs.projectRoot", status: "fail", message: `Project root not found: ${absRoot}` }],
    };
  }

  // Project metadata
  const projectJsonPath = path.join(absRoot, "routekit", "project.json");
  let projectId = options.projectId || null;
  if (!fileExists(projectJsonPath)) {
    checks.push({
      id: "routekit.project_json",
      status: "fail",
      message: "Missing routekit/project.json",
      details: { path: "routekit/project.json", suggestion: "Add a routekit/project.json file with an 'id' property (e.g. { \"id\": \"my-project\" })" },
    });
  } else {
    try {
      const data = readJson(projectJsonPath);
      projectId = projectId || data.id || null;
      if (!data.id) {
        checks.push({ id: "routekit.project_id", status: "fail", message: "routekit/project.json missing id", details: { suggestion: "Add an 'id' field to routekit/project.json" } });
      }
      checks.push({ id: "routekit.project_json", status: "ok", message: "Found routekit/project.json" });
    } catch (error) {
      checks.push({ id: "routekit.project_json", status: "fail", message: `Invalid JSON: ${error.message}`, details: { suggestion: "Ensure routekit/project.json is valid JSON (no trailing commas, proper quotes)" } });
    }
  }

  // KG
  const kgPath = path.join(absRoot, "routekit", "kg.yaml");
  let kg = null;
  if (!fileExists(kgPath)) {
    checks.push({ id: "routekit.kg", status: "fail", message: "Missing routekit/kg.yaml", details: { path: "routekit/kg.yaml", suggestion: "Add routekit/kg.yaml describing knowledge-graph configuration" } });
  } else {
    try {
      kg = readYamlFile(kgPath);
      checks.push({ id: "routekit.kg", status: "ok", message: "Found routekit/kg.yaml" });
    } catch (error) {
      checks.push({ id: "routekit.kg", status: "fail", message: `Invalid YAML: ${error.message}`, details: { suggestion: "Fix YAML syntax in routekit/kg.yaml" } });
    }
  }

  const framework = detectFramework(absRoot, kg);
  if (!framework) {
    checks.push({
      id: "framework.detect",
      status: "warn",
      message: "Framework not declared/inferable (ok for generic projects, but reduces planning quality)",
    });
  } else {
    checks.push({ id: "framework.detect", status: "ok", message: `Framework: ${framework}` });
  }

  // Notes / Dendron
  const notesDir = path.join(absRoot, "notes");
  if (!fileExists(notesDir) || !fs.statSync(notesDir).isDirectory()) {
    checks.push({ id: "notes.dir", status: "fail", message: "Missing notes/ directory" });
  } else {
    checks.push({ id: "notes.dir", status: "ok", message: "Found notes/ directory" });
  }
  const dendronYml = path.join(absRoot, "dendron.yml");
  if (!fileExists(dendronYml)) {
    checks.push({
      id: "dendron.config",
      status: "warn",
      message: "Missing dendron.yml (Dendron tools may not work as expected)",
    });
  } else {
    checks.push({ id: "dendron.config", status: "ok", message: "Found dendron.yml" });
    checks.push(validateDendronConfig(dendronYml));
  }

  // MCP config
  const mcpPath = path.join(absRoot, ".vscode", "mcp.json");
  if (!fileExists(mcpPath)) {
    checks.push({
      id: "mcp.config",
      status: "fail",
      message: "Missing .vscode/mcp.json",
      details: { suggestion: "Run routekit project attach/init again or add MCP config manually." },
    });
  } else {
    try {
      const mcp = readJson(mcpPath);
      checks.push({ id: "mcp.config", status: "ok", message: "Found .vscode/mcp.json" });
      checks.push(...validateMcpConfig(absRoot, mcp));
    } catch (error) {
      checks.push({ id: "mcp.config", status: "fail", message: `Invalid JSON: ${error.message}` });
    }
  }

  // RAG config (project-local)
  const ragConfigPath = path.join(absRoot, ".rks", "rag", "config.json");
  if (!fileExists(ragConfigPath)) {
    checks.push({
      id: "rag.config",
      status: "warn",
      message: "Missing .rks/rag/config.json (RAG may not be initialized yet)",
      details: { suggestion: projectId ? `routekit rag init ${projectId}` : "routekit rag init <projectId>" },
    });
  } else {
    checks.push({ id: "rag.config", status: "ok", message: "Found .rks/rag/config.json" });
  }

  // Analyze readiness (lightweight): ensure at least one framework root has files.
  const rootCandidates =
    framework === "eleventy-nunjucks"
      ? ["src", "notes"]
      : framework === "astro"
        ? ["src", "public", "notes"]
        : Array.isArray(kg?.code_roots) && kg.code_roots.length
          ? kg.code_roots
          : ["src"];
  const rootWithFiles = rootCandidates.find((rel) => {
    const abs = path.join(absRoot, rel);
    if (!fileExists(abs)) return false;
    const matches = globSync("**/*", { cwd: abs, nodir: true, dot: false });
    return matches.length > 0;
  });
  if (!rootWithFiles) {
    checks.push({
      id: "analyze.readiness",
      status: "warn",
      message: `No files found under expected roots: ${rootCandidates.join(", ")}`,
    });
  } else {
    checks.push({ id: "analyze.readiness", status: "ok", message: `Found files under ${rootWithFiles}` });
  }

  const status = summarizeStatus(checks, strict);
  return {
    status,
    projectRoot: absRoot,
    projectId: projectId || null,
    checks,
  };
}

export function verifyById({ projectId, shellRoot, strict = false } = {}) {
  if (!projectId) {
    return {
      status: "fail",
      projectRoot: null,
      projectId: null,
      checks: [{ id: "input.projectId", status: "fail", message: "projectId is required" }],
    };
  }
  const record = getProjectById(projectId, shellRoot);
  const root = record?.root || record?.path || null;
  if (!root) {
    return {
      status: "fail",
      projectRoot: null,
      projectId,
      checks: [{ id: "registry.lookup", status: "fail", message: `Project not found in registry: ${projectId}` }],
    };
  }
  return verifyProjectRoot(root, { strict, projectId });
}

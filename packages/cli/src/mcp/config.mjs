const DEFAULT_FIGMA_MCP_URL = "http://127.0.0.1:3845/mcp";

import path from "node:path";
import { resolveProjectRoot } from "../project/resolve-project-root.mjs";

function applyMcpBinding(server, { projectRoot = "." } = {}) {
  const base = server && typeof server === "object" ? { ...server } : {};
  if (!base.cwd) base.cwd = projectRoot;
  const existingEnv = base.env && typeof base.env === "object" ? base.env : {};
  base.env = {
    ROUTEKIT_PROJECT_ROOT: existingEnv.ROUTEKIT_PROJECT_ROOT ?? projectRoot,
    RKS_PROJECT_ROOT: existingEnv.RKS_PROJECT_ROOT ?? projectRoot,
    ...existingEnv,
  };
  return base;
}

function getDefaultFigmaUrl(env = process.env) {
  return (
    (env.RKS_FIGMA_MCP_URL && String(env.RKS_FIGMA_MCP_URL).trim()) ||
    (env.ROUTEKIT_FIGMA_MCP_URL && String(env.ROUTEKIT_FIGMA_MCP_URL).trim()) ||
    DEFAULT_FIGMA_MCP_URL
  );
}

function toPosixPath(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function joinPrefix(prefix, rel) {
  const cleanPrefix = toPosixPath(prefix);
  const cleanRel = toPosixPath(rel);
  if (!cleanPrefix) return cleanRel;
  if (!cleanRel) return cleanPrefix;
  return `${cleanPrefix}/${cleanRel}`;
}

function buildDefaultMcpConfig({ shellPrefix, figmaUrl }) {
  return {
    servers: {
      rks: applyMcpBinding({
        type: "stdio",
        command: "node",
        args: [joinPrefix(shellPrefix, "packages/mcp-rks/src/server.mjs")],
      }),
      dendron: applyMcpBinding({
        type: "stdio",
        command: "node",
        args: [joinPrefix(shellPrefix, "packages/mcp-dendron/src/server.mjs")],
      }),
      figma: applyMcpBinding({
        type: "stdio",
        command: "node",
        args: [joinPrefix(shellPrefix, "packages/mcp-figma-bridge/src/server.mjs")],
        env: { FIGMA_MCP_URL: figmaUrl },
      }),
    },
    inputs: [],
  };
}

export function getDefaultVendoredMcpConfig() {
  const figmaUrl = getDefaultFigmaUrl();
  return buildDefaultMcpConfig({ shellPrefix: "tools/routekit-shell", figmaUrl });
}

export function getDefaultWorkspaceMcpConfig() {
  const figmaUrl = getDefaultFigmaUrl();
  return buildDefaultMcpConfig({ shellPrefix: "", figmaUrl });
}

export function getDefaultMcpConfig({ cwd = process.cwd(), shellRoot, env = process.env } = {}) {
  const figmaUrl = getDefaultFigmaUrl(env);

  if (!shellRoot) return buildDefaultMcpConfig({ shellPrefix: "", figmaUrl });

  const { projectRoot } = resolveProjectRoot({ cwd, env });
  const absProjectRoot = path.resolve(projectRoot);
  const absShellRoot = path.resolve(shellRoot);

  const rel = path.relative(absProjectRoot, absShellRoot);
  const isInside =
    rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  const shellPrefix = isInside ? toPosixPath(rel) : "";

  return buildDefaultMcpConfig({ shellPrefix, figmaUrl });
}

export function mergeMcpConfig(existing, incoming) {
  const base = existing && typeof existing === "object" ? existing : {};
  const next = { ...base };

  const baseServers = base.servers && typeof base.servers === "object" ? base.servers : {};
  const incomingServers = incoming?.servers && typeof incoming.servers === "object" ? incoming.servers : {};
  next.servers = { ...incomingServers, ...baseServers };

  if (!Array.isArray(next.inputs)) {
    next.inputs = Array.isArray(incoming?.inputs) ? incoming.inputs : [];
  }

  return next;
}

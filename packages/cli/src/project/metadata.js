// packages/cli/src/project/metadata.js
import fs from "fs";
import path from "path";

const PROJECT_DIRNAME = "routekit";
const PROJECT_FILE = "project.json";
const SCHEMA_VERSION = 1;

function getProjectMetadataPath(projectRoot) {
    return path.join(projectRoot, PROJECT_DIRNAME, PROJECT_FILE);
}

/**
 * Validate metadata object shape according to the canonical schema.
 * Throws if required fields are missing or malformed.
 */
export function validateProjectMetadata(metadata) {
    if (!metadata || typeof metadata !== "object") {
        throw new Error("project metadata must be an object");
    }

    const { id, root, schemaVersion, notes, rag, kg, llm } = metadata;

    if (!id || typeof id !== "string") {
        throw new Error("project metadata missing required 'id' string");
    }
    if (!root || typeof root !== "string") {
        throw new Error("project metadata missing required 'root' string");
    }
    if (schemaVersion == null) {
        throw new Error("project metadata missing required 'schemaVersion'");
    }

    // notes
    if (!notes || typeof notes !== "object") {
        throw new Error("project metadata missing 'notes' section");
    }
    if (!notes.vaultPath || typeof notes.vaultPath !== "string") {
        throw new Error("project metadata 'notes.vaultPath' missing or not a string");
    }
    if (!notes.dendronConfig || typeof notes.dendronConfig !== "string") {
        throw new Error("project metadata 'notes.dendronConfig' missing or not a string");
    }

    // rag
    if (!rag || typeof rag !== "object") {
        throw new Error("project metadata missing 'rag' section");
    }
    if (!rag.indexPath || typeof rag.indexPath !== "string") {
        throw new Error("project metadata 'rag.indexPath' missing or not a string");
    }
    if (typeof rag.enabled !== "boolean") {
        throw new Error("project metadata 'rag.enabled' must be a boolean");
    }

    // kg
    if (!kg || typeof kg !== "object") {
        throw new Error("project metadata missing 'kg' section");
    }
    if (!kg.configPath || typeof kg.configPath !== "string") {
        throw new Error("project metadata 'kg.configPath' missing or not a string");
    }

    // llm
    if (!llm || typeof llm !== "object") {
        throw new Error("project metadata missing 'llm' section");
    }
    if (!llm.providerEnvVar || typeof llm.providerEnvVar !== "string") {
        throw new Error("project metadata 'llm.providerEnvVar' missing or not a string");
    }

    // If we ever add more required fields, enforce them here.
}

/**
 * Load project metadata from routekit/project.json.
 * Returns null if metadata does not exist.
 */
export function loadProjectMetadata(projectRoot) {
    const projectPath = getProjectMetadataPath(projectRoot);
    if (!fs.existsSync(projectPath)) {
        return null;
    }

    const text = fs.readFileSync(projectPath, "utf8");
    let metadata;
    try {
        metadata = JSON.parse(text);
    } catch (err) {
        throw new Error(`Failed to parse project metadata at ${projectPath}: ${err.message}`);
    }

    return metadata;
}

/**
 * Save metadata to routekit/project.json, normalizing timestamps and schemaVersion.
 */
export function saveProjectMetadata(projectRoot, metadata) {
    const projectDir = path.join(projectRoot, PROJECT_DIRNAME);
    if (!fs.existsSync(projectDir)) {
        fs.mkdirSync(projectDir, { recursive: true });
    }

    const projectPath = getProjectMetadataPath(projectRoot);
    const now = Date.now();

    const existing = fs.existsSync(projectPath)
        ? JSON.parse(fs.readFileSync(projectPath, "utf8"))
        : null;

    const merged = {
        // existing fields first, then incoming
        ...(existing || {}),
        ...metadata,
        schemaVersion: metadata.schemaVersion ?? existing?.schemaVersion ?? SCHEMA_VERSION,
        createdAt: existing?.createdAt ?? metadata.createdAt ?? now,
        updatedAt: now,
    };

    validateProjectMetadata(merged);

    fs.writeFileSync(projectPath, JSON.stringify(merged, null, 2), "utf8");
    return merged;
}

/**
 * Ensure that project metadata exists and has all required fields.
 * Merges any defaults on first creation.
 *
 * Returns the ensured metadata object.
 */
export function ensureProjectMetadata(projectRoot, defaults = {}) {
    const projectPath = getProjectMetadataPath(projectRoot);
    const exists = fs.existsSync(projectPath);
    const loaded = exists ? loadProjectMetadata(projectRoot) : null;

    const base = loaded || {};
    const now = Date.now();

    const metadata = {
        // Identity
        id: base.id ?? defaults.id ?? path.basename(projectRoot),
        root: base.root ?? defaults.root ?? projectRoot,
        stack: base.stack ?? defaults.stack ?? null,
        schemaVersion: base.schemaVersion ?? defaults.schemaVersion ?? SCHEMA_VERSION,

        // Notes / Dendron
        notes: {
            vaultPath: base.notes?.vaultPath ?? defaults.notes?.vaultPath ?? "notes",
            dendronConfig:
                base.notes?.dendronConfig ?? defaults.notes?.dendronConfig ?? "dendron.yml",
        },

        // RAG
        rag: {
            indexPath:
                base.rag?.indexPath ?? defaults.rag?.indexPath ?? "routekit/rag/index.lance",
            enabled: base.rag?.enabled ?? defaults.rag?.enabled ?? true,
        },

        // KG
        kg: {
            configPath:
                base.kg?.configPath ?? defaults.kg?.configPath ?? "routekit/kg.yaml",
        },

        // LLM
        llm: {
            providerEnvVar:
                base.llm?.providerEnvVar ??
                defaults.llm?.providerEnvVar ??
                "ROUTEKIT_LLM_PROVIDER",
            supportedProviders:
                base.llm?.supportedProviders ??
                defaults.llm?.supportedProviders ??
                ["openai", "anthropic", "google"],
        },

        createdAt: base.createdAt ?? defaults.createdAt ?? now,
        updatedAt: now,
    };

    const saved = saveProjectMetadata(projectRoot, metadata);
    return saved;
}
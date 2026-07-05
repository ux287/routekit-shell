import fs from "fs";
import path from "path";
import yaml from "js-yaml";

/**
 * Load configuration from YAML file
 */
export function loadConfig(filePath) {
    const fullPath = path.resolve(filePath);
    const content = fs.readFileSync(fullPath, 'utf8');
    return yaml.load(content);
}

/**
 * Load and parse kg.yaml configuration from projectRoot.
 * Searches for kg.yaml in priority order: .rks/kg.yaml then routekit/kg.yaml
 * @param {string} projectRoot - Project root directory path
 * @returns {Object} Configuration object with devServer and viewports properties
 * @throws {Error} If kg.yaml cannot be found or parsed
 */
export function loadKgConfig(projectRoot) {
    const searchPaths = [
        path.join(projectRoot, '.rks', 'kg.yaml'),
        path.join(projectRoot, 'routekit', 'kg.yaml'),
    ];

    let configPath = null;
    for (const p of searchPaths) {
        if (fs.existsSync(p)) {
            configPath = p;
            break;
        }
    }

    if (!configPath) {
        throw new Error(`kg.yaml not found in ${projectRoot}`);
    }

    const config = loadConfig(configPath);
    return {
        devServer: config.devServer || { startupTimeout: 30000 },
        viewports: config.viewports || [],
    };
}

/**
 * Get devServer configuration from kg.yaml
 * @param {string} projectRoot - Project root directory path
 * @returns {Object} devServer configuration with defaults applied
 */
export function getDevServerConfig(projectRoot) {
    try {
        const config = loadKgConfig(projectRoot);
        return config.devServer;
    } catch (err) {
        return { startupTimeout: 30000 };
    }
}

/**
 * Get viewports configuration from kg.yaml
 * @param {string} projectRoot - Project root directory path
 * @returns {Array} viewports array (empty if not defined)
 */
export function getViewportsConfig(projectRoot) {
    try {
        const config = loadKgConfig(projectRoot);
        return config.viewports;
    } catch (err) {
        return [];
    }
}

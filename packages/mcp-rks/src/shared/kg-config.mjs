import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

// Default viewport definitions
const DEFAULT_VIEWPORTS = {
  mobile: {
    width: 375,
    height: 812,
  },
  tablet: {
    width: 768,
    height: 1024,
  },
  desktop: {
    width: 1440,
    height: 900,
  },
  'desktop-lg': {
    width: 1920,
    height: 1080,
  },
};

// Default startup timeout in milliseconds
const DEFAULT_STARTUP_TIMEOUT = 30000;

/**
 * Load and parse kg.yaml configuration from projectRoot.
 * Searches for kg.yaml in priority order: .rks/kg.yaml then routekit/kg.yaml
 * Applies defaults for devServer.startupTimeout and viewports.
 * Merges user-defined viewports with defaults.
 *
 * @param {string} projectRoot - Project root directory path
 * @returns {Object} Configuration object with devServer and viewports properties
 * @throws {Error} If kg.yaml cannot be found or parsed
 */
export function loadKgConfig(projectRoot) {
  // Priority order for kg.yaml location
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
    throw new Error(
      `kg.yaml not found in ${projectRoot}. Searched: ${searchPaths.join(', ')}`
    );
  }

  // Read and parse YAML file
  const fileContent = fs.readFileSync(configPath, 'utf8');
  const rawConfig = yaml.load(fileContent) || {};

  // Extract and normalize devServer configuration
  const devServer = rawConfig.devServer || {};
  if (devServer.startupTimeout === undefined) {
    devServer.startupTimeout = DEFAULT_STARTUP_TIMEOUT;
  }

  // Extract user-defined viewports and merge with defaults
  const userViewports = rawConfig.viewports || {};
  const viewports = {
    ...DEFAULT_VIEWPORTS,
    ...userViewports,
  };

  return {
    devServer,
    viewports,
  };
}

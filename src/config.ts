import fs from "fs";
import path from "path";
import yaml from "js-yaml";

/**
 * Load configuration from YAML file
 */
export function loadConfig(filePath: string): any {
  const fullPath = path.resolve(filePath);
  const content = fs.readFileSync(fullPath, 'utf8');
  return yaml.load(content);
}
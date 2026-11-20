/**
 * Extract a field value from YAML frontmatter
 * Handles both quoted and unquoted values
 */
export function extractFrontmatterField(content, field) {
  const regex = new RegExp(`^${field}:\\s*["']?([\\w-]+)["']?`, 'm');
  const match = content.match(regex);
  return match ? match[1] : null;
}

// Re-export from shared module
export { hasFrontmatter } from "./frontmatter.mjs";

/**
 * Extract frontmatter block as string
 */
export function extractFrontmatterBlock(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : null;
}

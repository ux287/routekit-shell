import matter from "gray-matter";

/**
 * Check if content has YAML frontmatter
 */
export function hasFrontmatter(content) {
  return /^---\n[\s\S]*?\n---/.test(content);
}

export function parseFrontmatter(content) {
  return matter(String(content || ""));
}

// Characters that require quoting to prevent YAML misinterpretation
const YAML_UNSAFE = /[{}\[\]:#&*!|>@`]|: /;

function yamlQuoteString(s) {
  if (YAML_UNSAFE.test(s) || s.trim() !== s) return JSON.stringify(s);
  return s;
}

export function formatWithFrontmatter(data, body) {
  const cleanBody = String(body || "").replace(/^\s+/, "");
  const fm = `---\n${Object.entries(data)
    .map(([k, v]) => {
      if (v === undefined || v === null) return null;
      if (Array.isArray(v)) {
        if (v.length === 0) return `${k}: []`;
        return `${k}:\n${v.map((x) => {
          if (typeof x === 'object' && x !== null) {
            // Serialize structured objects as nested YAML (e.g. targetFiles: [{ path, op, desc }])
            const entries = Object.entries(x).filter(([, val]) => val !== undefined && val !== null);
            return entries.map(([ek, ev], i) => {
              const prefix = i === 0 ? '  - ' : '    ';
              const val = typeof ev === 'string' ? JSON.stringify(ev) : ev;
              return `${prefix}${ek}: ${val}`;
            }).join('\n');
          }
          return `  - ${yamlQuoteString(String(x))}`;
        }).join("\n")}`;
      }
      return `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`;
    })
    .filter(Boolean)
    .join("\n")}\n---\n`;
  return `${fm}\n${cleanBody}`;
}

/**
 * Extract a field value from YAML frontmatter
 * Handles both quoted and unquoted values
 */
export function extractFrontmatterField(content, field) {
  const regex = new RegExp(`^${field}:\\s*["']?([\\w-]+)["']?`, 'm');
  const match = content.match(regex);
  return match ? match[1] : null;
}

/**
 * Extract frontmatter block as string
 */
export function extractFrontmatterBlock(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : null;
}

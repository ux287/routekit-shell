import { parseFrontmatter, splitNoteFrontmatter, joinNoteFrontmatter, spliceFrontmatterText } from "./frontmatter.mjs";

/**
 * The per-note `channel:` link block for the Jira/Confluence publish channel.
 * Shape agreed by the user (research.2026.10.13.jira-confluence-publish-channel):
 *   channel:
 *     system: jira | confluence
 *     publish: true | false
 *     key: PROJ-123   # written after the first publish
 * Unknown keys fail closed; later stories extend CHANNEL_KEYS explicitly.
 */
export const CHANNEL_SYSTEMS = Object.freeze(["jira", "confluence"]);
export const CHANNEL_KEYS = Object.freeze(["system", "publish", "key"]);

function normalizeKey(key) {
  if (typeof key === "number" && Number.isInteger(key) && key >= 0) return String(key);
  return key;
}

/**
 * @param {object|null|undefined} data parsed frontmatter
 * @returns {{ present: boolean, ok: boolean, channel: object|null, issues: Array<{code: string, field?: string, message: string}> }}
 */
export function readChannel(data) {
  const raw = data ? data.channel : undefined;
  if (raw === undefined || raw === null) return { present: false, ok: true, channel: null, issues: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { present: true, ok: false, channel: null, issues: [{ code: "channel_not_a_map", field: "channel", message: "channel must be a YAML map" }] };
  }
  const issues = [];
  for (const k of Object.keys(raw)) {
    if (!CHANNEL_KEYS.includes(k)) issues.push({ code: "channel_unknown_key", field: `channel.${k}`, message: `Unknown channel key '${k}'. Allowed: ${CHANNEL_KEYS.join(", ")}` });
  }
  if (!CHANNEL_SYSTEMS.includes(raw.system)) {
    issues.push({ code: "channel_invalid_system", field: "channel.system", message: `channel.system must be one of: ${CHANNEL_SYSTEMS.join(", ")}` });
  }
  if (typeof raw.publish !== "boolean") {
    issues.push({ code: "channel_invalid_publish", field: "channel.publish", message: "channel.publish must be a boolean" });
  }
  const key = normalizeKey(raw.key);
  if (key !== undefined && (typeof key !== "string" || key === "" || /\s/.test(key))) {
    issues.push({ code: "channel_invalid_key", field: "channel.key", message: "channel.key must be a non-empty string without whitespace" });
  }
  if (issues.length) return { present: true, ok: false, channel: null, issues };
  const channel = { system: raw.system, publish: raw.publish };
  if (key !== undefined) channel.key = key;
  return { present: true, ok: true, channel, issues: [] };
}

/**
 * Record the remote key after the first publish. Pure: raw note text in, raw note text out.
 * Only the `channel` block and `updated` change; every other byte is preserved.
 * @returns {{ ok: true, changed: boolean, content: string } | { ok: false, reason: string, issues?: Array }}
 */
export function setChannelKey(raw, key) {
  const split = splitNoteFrontmatter(raw);
  if (split.frontmatter === null) return { ok: false, reason: "channel_missing" };
  const read = readChannel(parseFrontmatter(raw).data);
  if (!read.present) return { ok: false, reason: "channel_missing" };
  if (!read.ok) return { ok: false, reason: "channel_invalid", issues: read.issues };
  const nextKey = normalizeKey(key);
  if (nextKey === undefined || nextKey === null) {
    return { ok: false, reason: "channel_invalid", issues: [{ code: "channel_invalid_key", field: "channel.key", message: "a key is required" }] };
  }
  const check = readChannel({ channel: { ...read.channel, key: nextKey } });
  if (!check.ok) return { ok: false, reason: "channel_invalid", issues: check.issues };
  if (read.channel.key !== undefined && read.channel.key !== check.channel.key) return { ok: false, reason: "channel_key_already_set" };
  if (read.channel.key === check.channel.key) return { ok: true, changed: false, content: String(raw) };
  const fm = spliceFrontmatterText(split.frontmatter, { channel: check.channel, updated: Date.now() });
  return { ok: true, changed: true, content: joinNoteFrontmatter(fm, split.body) };
}

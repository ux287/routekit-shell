import fs from "fs";
import path from "path";
import crypto from "crypto";
import matter from "gray-matter";
import { readChannel } from "../shared/channel-frontmatter.mjs";

/**
 * Read-only preview of an on-request channel publish
 * (research.2026.10.13.jira-confluence-publish-channel). Writes nothing and contacts no
 * remote, so remoteChecked is always false: this tool cannot know whether Jira or
 * Confluence has drifted, and must never say it has not.
 *
 * @param {string} notesDir
 * @param {{ system?: "jira" | "confluence" }} [opts]
 */
export function previewChannelPublish(notesDir, opts = {}) {
  const files = fs.readdirSync(notesDir).filter((f) => f.endsWith(".md")).sort();
  const items = [];
  const invalid = [];
  for (const file of files) {
    const note = file.replace(/\.md$/, "");
    const raw = fs.readFileSync(path.join(notesDir, file), "utf8");
    let parsed;
    try {
      // Pass options ({}) so gray-matter skips its content cache (node_modules/gray-matter/index.js:37).
      // Without options it caches the file object (:47) BEFORE parsing (:50), so a second parse of
      // bytes that already failed would return data {} instead of throwing, and the note would be
      // silently dropped instead of listed in invalid (CP-TR5).
      parsed = matter(raw, {});
    } catch (err) {
      invalid.push({ note, issues: [{ code: "frontmatter_parse_error", message: err?.message || String(err) }] });
      continue;
    }
    const read = readChannel(parsed.data);
    if (!read.present) continue;
    if (!read.ok) {
      invalid.push({ note, issues: read.issues });
      continue;
    }
    const { channel } = read;
    if (channel.publish !== true) continue;
    if (opts.system && channel.system !== opts.system) continue;
    const body = parsed.content || "";
    items.push({
      note,
      system: channel.system,
      action: channel.key ? "update" : "create",
      key: channel.key ?? null,
      title: parsed.data.title || note,
      bodyBytes: Buffer.byteLength(body, "utf8"),
      localDigest: crypto.createHash("sha256").update(body, "utf8").digest("hex"),
    });
  }
  return { ok: true, dryRun: true, wrote: false, remoteChecked: false, scanned: files.length, items, invalid };
}

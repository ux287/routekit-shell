/**
 * Intervention receipts — backlog.feat.intervention-receipts-at-forced-exit-paths.
 *
 * WHY THIS EXISTS. Three classes of forced exit have recurred across UAT runs
 * with no recorded cause: an analyzer gate that names a file but no location, a
 * project-resolution failure reported as an authorization refusal, and a
 * rollback that restores the tree. Each time, the operator intervened by hand
 * and the system recorded nothing about WHY. The interventions were countable
 * and unattributable, so every run re-observed the symptom.
 *
 * WHY NOT TELEMETRY. The collector at packages/telemetry/src/collector.mjs
 * buffers until storage binds — `return; // Keep events buffered until storage
 * is connected` — and flushes on an `.unref()`'d timer, which does not hold the
 * process open. So a pending flush dies at exit, and TERMINAL events are the
 * ones most likely to be lost. That is exactly backwards for recording a forced
 * exit. This module writes synchronously and imports no collector.
 *
 * WHY IT RETURNS THE RECORD. A receipt only a Governor can read does not help
 * the operator. Callers put the returned record in the response the operator is
 * already looking at; the file is the durable second copy, not the delivery
 * mechanism.
 *
 * PATH. `<projectRoot>/.rks/state/interventions.jsonl`. `.rks/state/` is already
 * ignored by templates/base/.gitignore and wholesale by templates/generic, so a
 * receipt written into a scaffolded child leaves `git status` unchanged with no
 * child-side change. Do NOT move this to the `.rks` root: base's gitignore
 * enumerates `.rks` paths individually with no catch-all, and receipts written
 * there would dirty a child's tree on precisely the forced-exit paths where a
 * clean tree is next asserted — instrumentation manufacturing the interventions
 * it exists to measure.
 */

import fs from "node:fs";
import path from "node:path";

export const RECEIPT_RELATIVE_PATH = path.join(".rks", "state", "interventions.jsonl");

/**
 * Record one intervention. Never throws.
 *
 * Returns the record. `recorded` is sourced from a READ-BACK of the bytes at the
 * offset the append targeted — not from `fs.existsSync`, which observes a
 * directory entry rather than the line, and not from reaching the end of the try
 * block. When `recorded` is true the returned object and the durable line are
 * the same bytes by construction: the record is serialized ONCE, after
 * `recorded` and `recordPath` are assigned, and that string is what is appended.
 */
export function recordIntervention(projectRoot, fields = {}) {
  const dir = path.join(projectRoot, ".rks", "state");
  const file = path.join(dir, "interventions.jsonl");

  // Assigned BEFORE serialization. Serializing first and assigning after would
  // make every durable line read `"recorded":false` while the returned object
  // read true — the divergence the caller-visible receipt exists to rule out.
  const record = { ...fields, at: new Date().toISOString(), recorded: true, recordPath: file };
  const line = `${JSON.stringify(record)}\n`;
  const bytes = Buffer.from(line, "utf8");

  const failed = (message) => ({
    ...record,
    recorded: false,
    recordPath: null,
    writeError: message || "receipt write failed",
  });

  let fd = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Offset of the append, captured before it happens. existsSync is used ONLY
    // to size an absent file at zero — it never sources `recorded`.
    const offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
    fs.appendFileSync(file, bytes);

    fd = fs.openSync(file, "r");
    const observed = Buffer.alloc(bytes.length);
    fs.readSync(fd, observed, 0, bytes.length, offset);
    if (!observed.equals(bytes)) {
      return failed(`receipt read-back mismatch at offset ${offset} of ${file}`);
    }
    return record;
  } catch (err) {
    // A receipt failure must never convert a rollback, a gate or a refusal into
    // a crash. The caller still returns its own value, carrying a failed receipt.
    return failed(err?.message || String(err));
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

export default { recordIntervention, RECEIPT_RELATIVE_PATH };

/**
 * Bounded reads of a Dendron note.
 *
 * backlog.fix.dendron-read-note-bounded-slice.
 *
 * `dendron_read_note` returned the whole note and nothing else. On a large story
 * that overflowed the caller's token budget, and the harness replaced the content
 * with a file path — so a Governor dispatched to work on a story could not read
 * the story. Observed at 52.9KB in this repo and at 80,010 characters in a child
 * project, where a Build Governor spent four of its five manual interventions
 * getting to the point where anchor verification could begin.
 *
 * NO ARGUMENT COERCION EXISTS UPSTREAM. `dendron_read_note` is in
 * TOOLS_WITHOUT_ZOD_SCHEMA and `TOOL_ARG_SCHEMAS` has no production consumer, so
 * selectors arrive as raw `req.params.arguments`: numbers may be strings, and a
 * `sections`/`fields` array may be a bare string. Coercion is this module's job.
 */

/** Default bound for an unselected read. Caller-overridable via `maxBytes`. */
export const DEFAULT_MAX_BYTES = 49152;

/** Coerce a possibly-string integer, returning null when it is not usable. */
function toInt(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Coerce a bare string to a one-element array; drop anything unusable. */
function toList(value) {
  if (value === undefined || value === null) return null;
  const arr = Array.isArray(value) ? value : [value];
  const out = arr.map((v) => String(v).trim()).filter(Boolean);
  return out.length ? out : null;
}

/** Split frontmatter from body without parsing YAML. */
function splitNote(raw) {
  if (!raw.startsWith("---\n")) return { frontmatter: "", body: raw };
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: "", body: raw };
  return { frontmatter: raw.slice(4, end + 1), body: raw.slice(end + 5) };
}

/** Top-level `key:` names, in document order. Never parses values. */
function frontmatterKeys(frontmatter) {
  const keys = [];
  for (const line of frontmatter.split("\n")) {
    const m = /^([A-Za-z_][\w-]*):/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

/** Extract named top-level frontmatter entries, each with its indented block. */
function selectFields(frontmatter, names) {
  const lines = frontmatter.split("\n");
  const wanted = new Set(names);
  const out = [];
  let capturing = false;
  for (const line of lines) {
    const m = /^([A-Za-z_][\w-]*):/.exec(line);
    if (m) capturing = wanted.has(m[1]);
    else if (capturing && line.trim() !== "" && !/^\s/.test(line)) capturing = false;
    if (capturing) out.push(line);
  }
  return out.join("\n");
}

/** Every line-initial markdown heading, in document order. */
export function headings(body) {
  const out = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (m) out.push({ heading: m[2].trim(), level: m[1].length, line: i + 1 });
  }
  return out;
}

/** Body text under the named headings, each running to the next heading of any level. */
function selectSections(body, names) {
  const all = headings(body);
  const lines = body.split("\n");
  const wanted = new Set(names.map((n) => n.replace(/^#+\s*/, "").trim()));
  const chunks = [];
  for (let i = 0; i < all.length; i++) {
    if (!wanted.has(all[i].heading)) continue;
    const start = all[i].line - 1;
    const end = i + 1 < all.length ? all[i + 1].line - 1 : lines.length;
    chunks.push(lines.slice(start, end).join("\n"));
  }
  return chunks.join("\n");
}

/**
 * Slice a note.
 *
 * RETURN SHAPE IS NOT THE RESPONSE SHAPE. The handler must not spread this
 * wholesale: an under-cap read with no selector has to stay byte-identical to
 * `{ ok, filename, content }`, so the size fields below are the handler's to
 * attach only on bounded paths. `hasSelector` answers "manifest or content?" and
 * MUST NOT be reused to decide whether to attach the size report — an explicit
 * `maxBytes` is a bounded-mode request even when the note fits under it.
 *
 * @returns {{truncated: boolean, content?: string, manifest?: object, totalBytes: number, returnedBytes: number, bounded: boolean}}
 */
/**
 * The largest index at or before `cap` that is a UTF-8 character boundary.
 *
 * A UTF-8 continuation byte matches `0b10xxxxxx`; a lead byte or an ASCII byte
 * does not. `cap` is the first EXCLUDED index, so while the byte sitting at it is
 * a continuation byte the cut would land inside a character, and we walk back.
 *
 * Exported so the HTTP body cap in agents/fetch-raw.mjs shares this definition
 * rather than growing a second copy that can drift.
 */
export function lastCharBoundaryAtOrBefore(buf, cap) {
  let end = Math.min(cap, buf.length);
  // `end < buf.length` STATES the bound rather than leaning on coercion. When the
  // cap is at or beyond the end there is no excluded byte to inspect and the
  // answer is already buf.length. The previous form read buf[buf.length], relied
  // on `undefined & 0xc0` collapsing to 0 to fall out of the loop, and so was
  // correct only by accident of that coercion. Return values are unchanged for
  // every input; what changes is that the function no longer reads past the end.
  while (end > 0 && end < buf.length && (buf[end] & 0xc0) === 0x80) end--;
  return end;
}

export function sliceNote(raw, options = {}) {
  const sections = toList(options.sections);
  const fields = toList(options.fields);
  const offset = toInt(options.offset);
  const limit = toInt(options.limit);
  const maxBytesRaw = toInt(options.maxBytes);
  const maxBytes = maxBytesRaw === null ? DEFAULT_MAX_BYTES : maxBytesRaw;

  // BYTES, not String.length — a multi-byte note otherwise reports a size the
  // transport does not agree with, which is the whole class of defect here.
  const totalBytes = Buffer.byteLength(raw, "utf8");

  const hasSelector = Boolean(sections || fields || offset !== null || limit !== null);
  // `maxBytes` alone does not select, but it DOES request bounded mode.
  const bounded = hasSelector || maxBytesRaw !== null;

  if (!hasSelector && totalBytes <= maxBytes) {
    return { truncated: false, content: raw, totalBytes, returnedBytes: totalBytes, bounded };
  }

  if (!hasSelector) {
    // Over cap with nothing named: return a NAVIGABLE manifest, never a bare
    // failure. The first call must always succeed and must tell the caller what
    // it can ask for next.
    const { frontmatter, body } = splitNote(raw);
    return {
      truncated: true,
      manifest: {
        totalBytes,
        totalLines: raw.split("\n").length,
        maxBytes,
        frontmatterKeys: frontmatterKeys(frontmatter),
        headings: headings(body).map((h) => h.heading),
      },
      totalBytes,
      returnedBytes: 0,
      bounded,
    };
  }

  const { frontmatter, body } = splitNote(raw);
  const parts = [];
  if (fields) parts.push(selectFields(frontmatter, fields));
  if (sections) parts.push(selectSections(body, sections));
  if (!fields && !sections) {
    const lines = raw.split("\n");
    const from = offset === null ? 0 : offset;
    const to = limit === null ? lines.length : from + limit;
    parts.push(lines.slice(from, to).join("\n"));
  }

  let content = parts.filter((p) => p !== "").join("\n");
  let truncated = false;
  let measuredBytes = Buffer.byteLength(content, "utf8");
  if (measuredBytes > maxBytes) {
    // CUT ON A CHARACTER BOUNDARY, then MEASURE THE CUT.
    //
    // `subarray(0, maxBytes).toString("utf8")` splits multi-byte sequences: the
    // decoder replaces the orphaned bytes with U+FFFD, which is 3 bytes wide. So
    // the old code corrupted the text AND made it LONGER — a cap of 19 landing
    // inside an em dash returned a replacement character and reported 21 bytes,
    // over the cap the caller set. These notes are full of em dashes.
    const buf = Buffer.from(content, "utf8");
    const end = lastCharBoundaryAtOrBefore(buf, maxBytes);
    const slice = buf.subarray(0, end);
    content = slice.toString("utf8");
    // MEASURED on the bytes that were actually returned, not recomputed from the
    // decoded string and NOT clamped to maxBytes. A clamp would answer the cap
    // (19) where the truth is the true length (18) — a number sourced from what
    // the code was permitted to return rather than from what it returned.
    measuredBytes = slice.length;
    truncated = true;
  }
  const returnedBytes = measuredBytes;
  // OBSERVED, not assumed: a selected read that returned fewer bytes than the
  // note holds IS truncated, whatever the byte cap did. Reporting `false` here
  // because no cap fired would be a value sourced from intent.
  if (returnedBytes < totalBytes) truncated = true;

  return { truncated, content, totalBytes, returnedBytes, bounded };
}

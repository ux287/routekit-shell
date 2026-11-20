/**
 * Dendron family handlers — moved verbatim from server.mjs (S4 of
 * research.2026.10.05.server-mjs-safe-decomposition).
 * Bare specifiers are byte-identical to server.mjs; relative imports resolve to the same
 * module files (invariant I3). Schema consts stay in server.mjs (TOOL_ARG_SCHEMAS and the
 * schema-drift guard reference them) and are passed in at registration. The four dendron
 * helpers (getDendronContext, assertNotesDir, notePathFromFilename, commitDendronWriteResult)
 * have callers that stay in server.mjs, so they are passed in too — a registration-time
 * dependency, not a ctx extension. Handler contract: see ./registry.mjs. No handler reads ctx.
 * dendron_read_note reads cleanArgs where the chain branch read raw args: the two differ only by
 * _governorToken, which neither the body nor sliceNote reads.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  readNoteRaw,
  writeNoteRaw,
  hasFrontmatter,
  frontmatterDefaults,
  formatWithFrontmatter,
  parseFrontmatter,
  validateNoteFrontmatter,
  canonicalIdFromFilename,
  findMatchingSchema,
  loadSchemaTemplate,
  mergeTemplateWithGenerated,
  updateField,
  updateFieldDirect,
  updateFields,
} from "../../dendron.mjs";
import { spliceNoteFrontmatter, spliceNoteFrontmatterWithBody } from "../../shared/frontmatter.mjs";
import { sliceNote } from "../../shared/note-slice.mjs";
import { rewriteWikilinks, isValidNoteName } from "../../shared/wikilinks.mjs";

export function registerDendronHandlers({ registerHandler }, {
  createNoteSchema,
  fixFrontmatterSchema,
  validateSchemaSchema,
  editNoteSchema,
  updateFieldSchema,
  updateFieldsSchema,
  markImplementedSchema,
  renameNoteSchema,
}, {
  getDendronContext,
  assertNotesDir,
  notePathFromFilename,
  commitDendronWriteResult,
}) {
  registerHandler("dendron_create_note", async (cleanArgs, ctx) => {
    const input = createNoteSchema.parse(cleanArgs);
    const { notesDir } = getDendronContext();
    assertNotesDir(notesDir);
    const notePath = notePathFromFilename(notesDir, input.filename);
    if (fs.existsSync(notePath)) {
      throw new McpError(ErrorCode.InvalidRequest, `Note already exists: ${path.relative(notesDir, notePath)}`);
    }
    const id = canonicalIdFromFilename(input.filename);
    const generated = frontmatterDefaults({ id, title: input.title || null, desc: input.desc || null });
    // Add phase: draft for backlog stories
    if (input.filename.startsWith("backlog.") && !input.filename.includes("z_implemented") && !input.filename.includes("z_archive")) {
      generated.phase = "draft";
    }
    // Pass through testFile if provided
    if (input.testFile) {
      generated.testFile = input.testFile;
    }
    // Strip frontmatter from content if caller already included it — prevents duplicate blocks
    let bodyContent = input.content || "";
    if (hasFrontmatter(bodyContent)) {
      const contentParsed = parseFrontmatter(bodyContent);
      bodyContent = contentParsed.content || "";
      // Merge caller's frontmatter fields into generated (caller wins on conflicts)
      Object.assign(generated, contentParsed.data || {});
    }
    // Post-write verification: confirm the file landed on disk with non-zero
    // size before reporting success. Prevents the "phantom story" failure
    // mode where downstream Governors run via RAG queries against a note
    // that was reported created but never actually written.
    const verifyNoteOnDisk = () => {
      if (!fs.existsSync(notePath)) {
        return { ok: false, error: `post-write verification failed — file not present on disk: ${path.relative(notesDir, notePath)}` };
      }
      let size;
      try {
        size = fs.statSync(notePath).size;
      } catch (err) {
        return { ok: false, error: `post-write verification failed — stat error: ${err?.message || String(err)}` };
      }
      if (size === 0) {
        return { ok: false, error: `post-write verification failed — file is empty: ${path.relative(notesDir, notePath)}` };
      }
      return { ok: true };
    };
    // backlog.fix.dendron-writes-no-auto-commit AC1: auto-commit dendron writes.
    const skipCommit = cleanArgs.skipCommit === true;
    const schema = findMatchingSchema(notesDir, input.filename);
    if (schema && schema.template) {
      const tpl = loadSchemaTemplate(notesDir, schema.template);
      if (tpl) {
        const { merged, body } = mergeTemplateWithGenerated({ generated, templateParsed: tpl.parsed, content: bodyContent, id });
        if (skipCommit) {
          writeNoteRaw(notePath, formatWithFrontmatter(merged, body));
        } else {
          writeNoteRaw(notePath, formatWithFrontmatter(merged, body), { skipEmbed: true });
        }
        const verify = verifyNoteOnDisk();
        if (!verify.ok) {
          return { content: [{ type: "text", text: JSON.stringify(verify, null, 2) }] };
        }
        // backlog.fix.dendron-agent-rewrites-content AC5: expose wrote_verbatim on MCP envelope.
        const innerSchemaResult = { ok: true, path: path.relative(notesDir, notePath), id, schema: schema.id, wrote_verbatim: true };
        const wrappedSchema = await commitDendronWriteResult({ tool: "dendron_create_note", innerResult: innerSchemaResult, skipCommit });
        return { content: [{ type: "text", text: JSON.stringify(wrappedSchema, null, 2) }] };
      }
    }
    if (skipCommit) {
      writeNoteRaw(notePath, formatWithFrontmatter(generated, bodyContent));
    } else {
      writeNoteRaw(notePath, formatWithFrontmatter(generated, bodyContent), { skipEmbed: true });
    }
    const verify = verifyNoteOnDisk();
    if (!verify.ok) {
      return { content: [{ type: "text", text: JSON.stringify(verify, null, 2) }] };
    }
    // backlog.fix.dendron-agent-rewrites-content AC5: expose wrote_verbatim on MCP envelope.
    const innerCreateResult = { ok: true, path: path.relative(notesDir, notePath), id, wrote_verbatim: true };
    const wrappedCreate = await commitDendronWriteResult({ tool: "dendron_create_note", innerResult: innerCreateResult, skipCommit });
    return { content: [{ type: "text", text: JSON.stringify(wrappedCreate, null, 2) }] };
  });

  registerHandler("dendron_fix_frontmatter", async (cleanArgs, ctx) => {
    const input = fixFrontmatterSchema.parse(cleanArgs);
    const { notesDir } = getDendronContext();
    assertNotesDir(notesDir);
    const notePath = notePathFromFilename(notesDir, input.filename);
    if (!fs.existsSync(notePath)) throw new McpError(ErrorCode.InvalidParams, `Note not found`);
    const raw = readNoteRaw(notePath);
    const parsed = parseFrontmatter(raw);
    const id = canonicalIdFromFilename(input.filename);
    const next = { ...frontmatterDefaults({ id }), ...(parsed.data || {}), id, updated: Date.now() };
    const skipCommit = cleanArgs.skipCommit === true;
    writeNoteRaw(notePath, formatWithFrontmatter(next, parsed.content || ""), skipCommit ? {} : { skipEmbed: true });
    const inner = { ok: true, path: path.relative(notesDir, notePath), id };
    const wrapped = await commitDendronWriteResult({ tool: "dendron_fix_frontmatter", innerResult: inner, skipCommit });
    return { content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }] };
  });

  registerHandler("dendron_validate_schema", async (cleanArgs, ctx) => {
    const input = validateSchemaSchema.parse(cleanArgs);
    const { notesDir } = getDendronContext();
    assertNotesDir(notesDir);
    const pattern = input.pattern || "**/*.md";
    const { globSync } = await import("glob");
    const matches = globSync(pattern, { cwd: notesDir, nodir: true }).sort();
    const results = matches.map((rel) => {
      const raw = readNoteRaw(path.join(notesDir, rel));
      return { path: rel, ...validateNoteFrontmatter(raw) };
    });
    return { content: [{ type: "text", text: JSON.stringify({ ok: results.every(r => r.ok), count: results.length, results }, null, 2) }] };
  });

  registerHandler("dendron_edit_note", async (cleanArgs, ctx) => {
    const input = editNoteSchema.parse(cleanArgs);
    const { notesDir } = getDendronContext();
    assertNotesDir(notesDir);
    const notePath = notePathFromFilename(notesDir, input.filename);
    if (!fs.existsSync(notePath)) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Note not found", filename: input.filename }, null, 2) }] };
    }
    const raw = readNoteRaw(notePath);
    const parsed = parseFrontmatter(raw);
    const id = parsed.data?.id || canonicalIdFromFilename(input.filename);

    // Apply patches sequentially — rollback (write nothing) if any patch's search string is not found
    let body = parsed.content || "";
    for (let i = 0; i < input.patches.length; i++) {
      const { search, replace } = input.patches[i];
      const idx = body.indexOf(search);
      if (idx === -1) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, patchIndex: i, search, error: "search_not_found" }, null, 2) }] };
      }
      body = body.slice(0, idx) + replace + body.slice(idx + search.length);
    }

    const next = { ...(parsed.data || {}), id, updated: Date.now() };
    const skipCommit = cleanArgs.skipCommit === true;
    // Splice updated (+ id only when absent); untouched frontmatter lines stay byte-identical.
    const _upd = parsed.data?.id ? { updated: next.updated } : { id, updated: next.updated };
    writeNoteRaw(notePath, spliceNoteFrontmatterWithBody(raw, _upd, body) || formatWithFrontmatter(next, body), skipCommit ? {} : { skipEmbed: true });
    const inner = { ok: true, path: path.relative(notesDir, notePath), id, patchesApplied: input.patches.length };
    const wrapped = await commitDendronWriteResult({ tool: "dendron_edit_note", innerResult: inner, skipCommit });
    return { content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }] };
  });

  registerHandler("dendron_read_note", async (cleanArgs, ctx) => {
    const inputFilename = String((cleanArgs && cleanArgs.filename) || "").trim();
    if (!inputFilename) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Missing filename" }, null, 2) }] };
    const { notesDir } = getDendronContext();
    try {
      assertNotesDir(notesDir);
      const notePath = notePathFromFilename(notesDir, inputFilename);
      if (!fs.existsSync(notePath)) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Note not found` }, null, 2) }] };
      const raw = readNoteRaw(notePath);
      const sliced = sliceNote(raw, cleanArgs || {});
      // BYTE-IDENTICAL ON THE UNBOUNDED PATH. An under-cap read with no
      // selector returns exactly { ok, filename, content } as it always has —
      // this tool is the only route a Governor has to its own story note, and
      // every existing caller parses that shape. The size report is attached
      // only when the caller asked for a bounded read; on the unbounded path
      // `truncated` is always false and returnedBytes always equals totalBytes,
      // so reporting them there would be a value fixed by which branch ran
      // rather than by an observation.
      if (!sliced.bounded && !sliced.truncated) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, filename: inputFilename, content: raw }, null, 2) }] };
      }
      const payload = {
        ok: true,
        filename: inputFilename,
        truncated: sliced.truncated,
        totalBytes: sliced.totalBytes,
        returnedBytes: sliced.returnedBytes,
        // `truncated` is true for EVERY selection by construction, so it cannot tell a
        // caller whether what it asked for came back whole. These three can. A caller
        // that rebuilds an array from a slice must read selectionComplete, not truncated.
        selectionBytes: sliced.selectionBytes,
        selectionComplete: sliced.selectionComplete,
        fieldsNotFound: sliced.fieldsNotFound,
      };
      // Over cap with nothing named: a navigable manifest and NO content key,
      // so the first call always succeeds and names what can be asked for next.
      if (sliced.manifest) payload.manifest = sliced.manifest;
      else payload.content = sliced.content;
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2) }] };
    }
  });

  registerHandler("dendron_update_field", async (cleanArgs, ctx) => {
    const input = updateFieldSchema.parse(cleanArgs);
    const { notesDir } = getDendronContext();
    assertNotesDir(notesDir);
    const notePath = notePathFromFilename(notesDir, input.filename);
    if (!fs.existsSync(notePath)) throw new McpError(ErrorCode.InvalidParams, `Note not found`);
    const skipCommit = cleanArgs.skipCommit === true;
    // acknowledgeRemoval is threaded from the PARSED input, not from cleanArgs — declaring
    // it on both the zod schema and the advertised entry is what makes it discoverable,
    // unlike skipCommit above, which is declared on neither.
    const writeOptions = skipCommit ? {} : { skipEmbed: true };
    if (input.acknowledgeRemoval === true) writeOptions.acknowledgeRemoval = true;
    const result = Array.isArray(input.value)
      ? updateFieldDirect(notesDir, input.filename, input.field, input.value, writeOptions)
      : updateField(notesDir, input.filename, input.field, input.value, writeOptions);
    const inner = { ok: true, ...result };
    const wrapped = await commitDendronWriteResult({ tool: "dendron_update_field", innerResult: inner, skipCommit });
    return { content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }] };
  });

  // backlog.feat.dendron-update-fields-multi-field: N fields, one write, ONE commit. A refusal
  // (any field refused) wrote nothing, so it returns without reaching commitDendronWriteResult —
  // there is nothing to commit, and the refused list must reach the caller intact.
  registerHandler("dendron_update_fields", async (cleanArgs, ctx) => {
    const input = updateFieldsSchema.parse(cleanArgs);
    const { notesDir } = getDendronContext();
    assertNotesDir(notesDir);
    const notePath = notePathFromFilename(notesDir, input.filename);
    if (!fs.existsSync(notePath)) throw new McpError(ErrorCode.InvalidParams, `Note not found`);
    const skipCommit = cleanArgs.skipCommit === true;
    const writeOptions = skipCommit ? {} : { skipEmbed: true };
    if (input.acknowledgeRemoval === true) writeOptions.acknowledgeRemoval = true;
    const result = updateFields(notesDir, input.filename, input.fields, writeOptions);
    if (result.ok === false) {
      const refusal = { ...result, writeOk: false, commitOk: false };
      return { content: [{ type: "text", text: JSON.stringify(refusal, null, 2) }] };
    }
    const inner = { ok: true, ...result };
    const wrapped = await commitDendronWriteResult({ tool: "dendron_update_fields", innerResult: inner, skipCommit });
    return { content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }] };
  });

  // backlog.feat.dendron-rename-note-wikilinks: rename/move a note (optionally with its
  // hierarchy children), update a filename-equal frontmatter id, and rewrite every
  // [[wikilink]] that targets a renamed note across the vault — as ONE commit.
  //
  // Every check runs before any write; a refusal returns { ok: false, reason } having
  // written nothing. Writes are snapshotted first and restored byte-for-byte if any write
  // fails. dryRun computes the same plan and returns it without writing. Counts are read
  // from the rewrite that ran (rewriteWikilinks' measured count), never estimated.
  // notes/.dendron.cache.json is never read or written: only `<name>.md` files are touched.
  registerHandler("dendron_rename_note", async (cleanArgs, ctx) => {
    const input = renameNoteSchema.parse(cleanArgs);
    const { notesDir, projectRoot } = getDendronContext();
    assertNotesDir(notesDir);
    const reply = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
    const refuse = (reason, message, extra = {}) =>
      reply({ ok: false, reason, message, from: input.from, to: input.to, ...extra, writeOk: false, commitOk: false });

    const { from, to } = input;
    const includeChildren = input.includeChildren === true;
    const dryRun = input.dryRun === true;
    if (!isValidNoteName(from) || !isValidNoteName(to)) {
      return refuse("malformed_name", "from and to must be Dendron note names: dot-separated segments of [A-Za-z0-9_-], no path separators and no .md suffix.");
    }
    if (from === to) return refuse("same_name", "from and to are the same note.");

    const noteFile = (name) => path.join(notesDir, `${name}.md`);
    const vaultNames = fs.readdirSync(notesDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".md"))
      .map((d) => d.name.slice(0, -3))
      .sort();
    const existing = new Set(vaultNames);
    if (!existing.has(from)) return refuse("source_not_found", `Note not found: ${from}.md`);
    if (existing.has(to)) return refuse("target_exists", `Target already exists: ${to}.md`);

    const pairs = [{ from, to }];
    if (includeChildren) {
      for (const name of vaultNames) {
        if (name.startsWith(`${from}.`)) pairs.push({ from: name, to: `${to}${name.slice(from.length)}` });
      }
      const collisions = pairs.slice(1).filter((p) => existing.has(p.to)).map((p) => p.to);
      if (collisions.length > 0) {
        return refuse("child_target_exists", `Child rename target(s) already exist: ${collisions.join(", ")}`, { collisions });
      }
    }
    const renameMap = new Map(pairs.map((p) => [p.from, p.to]));

    // Plan every write in memory. Renamed notes get their links rewritten and a
    // filename-equal id updated; every other note gets its links rewritten.
    const plan = []; // { name (final), oldName?, raw, next, count }
    const idUpdated = [];
    for (const name of vaultNames) {
      const raw = readNoteRaw(noteFile(name));
      const { text: rewritten, count } = rewriteWikilinks(raw, renameMap);
      if (renameMap.has(name)) {
        const newName = renameMap.get(name);
        let next = rewritten;
        if (parseFrontmatter(raw).data?.id === name) {
          const spliced = spliceNoteFrontmatter(rewritten, { id: newName });
          if (spliced === null) return refuse("frontmatter_unreadable", `Cannot update the id of ${name}.md: no frontmatter block.`);
          next = spliced;
          idUpdated.push(newName);
        }
        plan.push({ name: newName, oldName: name, raw, next, count });
      } else if (count > 0) {
        plan.push({ name, raw, next: rewritten, count });
      }
    }
    const renamed = pairs.map((p) => ({ from: p.from, to: p.to }));
    // Sorted by the file's final name, so a dry run and a real run list files identically.
    const linksRewritten = plan.filter((p) => p.count > 0).map((p) => ({ file: `${p.name}.md`, count: p.count }))
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    const totalLinks = linksRewritten.reduce((n, l) => n + l.count, 0);
    const report = { renamed, linksRewritten, totalLinks, idUpdated };
    if (dryRun) return reply({ ok: true, dryRun: true, ...report, writeOk: false, commitOk: false });

    // Snapshot every path this call may touch (null = did not exist) so a failed write is
    // rolled back to the original bytes and nothing is committed.
    const snapshot = new Map();
    for (const p of plan) {
      if (p.oldName) {
        snapshot.set(noteFile(p.oldName), p.raw);
        snapshot.set(noteFile(p.name), null);
      } else {
        snapshot.set(noteFile(p.name), p.raw);
      }
    }
    const rollback = () => {
      for (const [abs, original] of snapshot) {
        try {
          if (original === null) { if (fs.existsSync(abs)) fs.unlinkSync(abs); }
          else fs.writeFileSync(abs, original, "utf8");
        } catch { /* best-effort: continue restoring the rest */ }
      }
    };
    const skipCommit = cleanArgs.skipCommit === true;
    const writeOptions = skipCommit ? {} : { skipEmbed: true };
    try {
      // Renames first, then the in-place link rewrites.
      for (const p of plan.filter((x) => x.oldName)) {
        fs.renameSync(noteFile(p.oldName), noteFile(p.name));
        if (p.next !== p.raw) writeNoteRaw(noteFile(p.name), p.next, writeOptions);
      }
      for (const p of plan.filter((x) => !x.oldName)) {
        writeNoteRaw(noteFile(p.name), p.next, writeOptions);
      }
    } catch (err) {
      rollback();
      return refuse("write_failed", `Rename rolled back: ${err?.message || String(err)}`, { rolledBack: true });
    }

    // ONE commit covering the moved files (old and new paths) and every rewritten note.
    // An old path is staged only when git tracks it: a pathspec naming an untracked,
    // now-absent file would make the scoped commit fail outright.
    const oldRel = plan.filter((p) => p.oldName).map((p) => path.relative(projectRoot, noteFile(p.oldName)));
    let tracked = new Set();
    if (!skipCommit && oldRel.length > 0) {
      try {
        tracked = new Set(execFileSync("git", ["ls-files", "--", ...oldRel], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
          .split("\n").filter(Boolean));
      } catch { /* not a repo: commitDendronWriteResult reports the commit failure */ }
    }
    const stagePaths = [];
    for (const p of plan) {
      if (p.oldName) {
        const rel = path.relative(projectRoot, noteFile(p.oldName));
        if (tracked.has(rel)) stagePaths.push(rel);
      }
      stagePaths.push(path.relative(projectRoot, noteFile(p.name)));
    }
    const inner = { ok: true, ...report, id: to, path: `${to}.md` };
    const wrapped = await commitDendronWriteResult({
      tool: "dendron_rename_note",
      innerResult: inner,
      skipCommit,
      extraStagePaths: stagePaths,
    });
    return reply(wrapped);
  });

  registerHandler("dendron_mark_implemented", async (cleanArgs, ctx) => {
    const input = markImplementedSchema.parse(cleanArgs);
    const { notesDir, projectRoot } = getDendronContext();
    assertNotesDir(notesDir);
    const notePath = notePathFromFilename(notesDir, input.filename);
    if (!fs.existsSync(notePath)) throw new McpError(ErrorCode.InvalidParams, `Note not found`);
    if (!input.filename.startsWith("backlog.") || input.filename.startsWith("backlog.z_implemented.")) {
      throw new McpError(ErrorCode.InvalidParams, `Note must be in backlog.* namespace`);
    }
    const raw = readNoteRaw(notePath);
    const parsed = parseFrontmatter(raw);
    const originalId = parsed.data?.id || canonicalIdFromFilename(input.filename);
    const newFilename = input.filename.replace(/^backlog\./, "backlog.z_implemented.");
    // Update the id field to match the new filename hierarchy
    const newId = originalId.includes("z_implemented")
      ? originalId
      : originalId.replace(/^backlog\./, "backlog.z_implemented.");
    const next = { ...(parsed.data || {}), id: newId, status: "implemented", updated: Date.now() };
    if (input.commitId) next.commitId = input.commitId;
    const skipCommit = cleanArgs.skipCommit === true;
    // Splice id/status/updated(/commitId); the body is carried through byte-for-byte.
    const _upd = { id: newId, status: next.status, updated: next.updated, ...(input.commitId ? { commitId: next.commitId } : {}) };
    writeNoteRaw(notePath, spliceNoteFrontmatter(raw, _upd) || formatWithFrontmatter(next, parsed.content), skipCommit ? {} : { skipEmbed: true });
    const newPath = notePathFromFilename(notesDir, newFilename);
    fs.renameSync(notePath, newPath);
    const oldRelFromRoot = path.relative(projectRoot, notePath);
    const inner = { ok: true, oldPath: input.filename, newPath: newFilename, id: newId, status: "implemented", commitId: input.commitId || null, path: path.relative(notesDir, newPath) };
    const wrapped = await commitDendronWriteResult({
      tool: "dendron_mark_implemented",
      innerResult: inner,
      skipCommit,
      extraStagePaths: [oldRelFromRoot],
    });
    return { content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }] };
  });
}

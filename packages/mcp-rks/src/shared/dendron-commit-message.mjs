// Moved from packages/mcp-rks/src/server.mjs (backlog.fix.research-agent-note-writes-uncommitted).
// Shared by the MCP-level dendron tools (server.mjs) and the research agent's
// in-agent note tools (agents/research.mjs) so both derive the same commit subject.
export function buildDendronCommitMessage(tool, noteId) {
  const id = String(noteId || "");
  let scope;
  if (id.startsWith("research.")) scope = "research";
  else if (id.startsWith("backlog.")) scope = "backlog";
  else if (id.startsWith("canon.")) scope = "canon";
  else if (id.startsWith("memories.")) scope = "memory";
  else scope = "notes";
  const action = {
    dendron_create_note: "create",
    dendron_edit_note: "edit",
    dendron_update_field: "update",
    // backlog.feat.dendron-update-fields-multi-field: distinct from the "update" fallback, so a
    // multi-field commit is recognisable in the log.
    dendron_update_fields: "update-fields",
    dendron_fix_frontmatter: "fix",
    dendron_mark_implemented: "implement",
    // backlog.feat.dendron-rename-note-wikilinks: a rename commit carries the new note name.
    dendron_rename_note: "rename",
  }[tool] || "update";
  return `docs(${scope}): ${action} ${id}`;
}

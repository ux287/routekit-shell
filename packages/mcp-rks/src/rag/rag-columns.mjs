/**
 * Canonical RAG index column contract — the single source of truth shared by the writer
 * (scripts/rag/embed.mjs) and BOTH readers (scripts/rag/query.mjs CLI, and
 * packages/mcp-rks/src/rag-context.mjs, the in-server reader the planner uses).
 *
 * backlog.fix.rag-index-unusable-after-embed
 * ------------------------------------------
 * Root cause this module exists to prevent: note rows carried a `status` field but CODE rows
 * (processCodeFile) did not. LanceDB infers the Arrow schema from the records handed to
 * createTable, so whenever a code row landed first the `embeddings` table was created with NO
 * `status` column — and every reader's `.select([... 'status' ...])` then threw
 * "No field named status". Worse, embed's schema-mismatch detector was ADD-only (it looked for
 * field names present in the record but absent from the table), so a code row — which introduces
 * no new names — never triggered a rebuild. The broken index therefore survived re-embeds, while
 * embed still reported ok:true because its success gate only called countRows().
 *
 * Every row is normalized to carry the full required set before write, both readers project
 * through RAG_REQUIRED_COLUMNS, and embed verifies the read contract before reporting success.
 */

/**
 * The columns every reader is entitled to select. This is the SUPERSET of what the two readers
 * ask for (rag-context.mjs selects 8; query.mjs selects those plus `id` and `content_type`), so a
 * table satisfying this contract satisfies both. Widening rag-context's projection is safe: embed
 * already writes all ten.
 */
export const RAG_REQUIRED_COLUMNS = Object.freeze([
  "id",
  "slug",
  "title",
  "path",
  "text",
  "chunkId",
  "tags",
  "status",
  "updatedAt",
  "content_type",
]);

/**
 * Type-correct defaults used to backfill a row that is missing a required column. Values must be
 * non-null and of the right Arrow-inferable type — LanceDB cannot infer a type from null or from
 * an empty array, which is why `tags` defaults to a non-empty array.
 */
const RAG_COLUMN_DEFAULTS = Object.freeze({
  id: "",
  slug: "",
  title: "",
  path: "",
  text: "",
  chunkId: 0,
  tags: ["untagged"],
  status: "unknown",
  updatedAt: new Date(0).toISOString(),
  content_type: "unknown",
});

/**
 * Backfill any missing required column on every row so the Arrow schema inferred at createTable
 * time always contains the full required set, regardless of which row happens to be first (a code
 * row, a note row, ...). Returns a new array; does not mutate the inputs' identity.
 *
 * Also repairs empty arrays on the schema-seed row: LanceDB cannot infer an element type from `[]`.
 */
export function normalizeRagRows(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const normalized = rows.map((row) => {
    const out = { ...row };
    for (const col of RAG_REQUIRED_COLUMNS) {
      const v = out[col];
      const missing =
        v === undefined ||
        v === null ||
        (Array.isArray(v) && v.length === 0 && Array.isArray(RAG_COLUMN_DEFAULTS[col]));
      if (missing) out[col] = RAG_COLUMN_DEFAULTS[col];
    }
    return out;
  });

  // Schema-seed hardening: the first record drives inference for non-required array columns too.
  const seed = normalized[0];
  if (!Array.isArray(seed.heading_path) || seed.heading_path.length === 0) {
    seed.heading_path = ["root"];
  }
  return normalized;
}

/** Required columns absent from the given table field-name list. */
export function missingRequiredColumns(fieldNames = []) {
  const have = new Set(fieldNames);
  return RAG_REQUIRED_COLUMNS.filter((c) => !have.has(c));
}

/**
 * The projection a reader should actually use against a table with `fieldNames`. Normally this is
 * RAG_REQUIRED_COLUMNS; against a legacy/broken table it degrades to the intersection so the
 * reader returns partial rows instead of throwing a raw driver error ("No field named status").
 */
export function selectableProjection(fieldNames = []) {
  const have = new Set(fieldNames);
  return RAG_REQUIRED_COLUMNS.filter((c) => have.has(c));
}

/** Read a LanceDB table's field names; returns [] when the schema can't be read. */
export async function tableFieldNames(table) {
  try {
    const schema = await table.schema();
    return (schema?.fields ?? []).map((f) => f.name);
  } catch {
    return [];
  }
}

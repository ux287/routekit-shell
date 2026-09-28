import { extractSymbols } from './symbol-extractor.mjs';

export async function chunkFile(filePath, codeText) {
  // Use the extractor
  const meta = extractSymbols(filePath, codeText);

  const chunks = [];

  // File summary chunk (AC2)
  const key_exports = meta.symbols.filter(s => s.exports).map(s => s.symbol_name);
  const primaryPurpose = (() => {
    if (meta.header_comment) {
      // attempt first sentence from header comment
      const txt = meta.header_comment.replace(/\/\*\*?|\*+\//g, '').replace(/\/\//g, '').trim();
      const m = txt.match(/([^.\n]+[.\n]?)/);
      return m ? m[0].trim() : txt.split('\n').slice(0, 2).join(' ').trim();
    }
    // fallback: list of top symbols
    const top = meta.symbols.slice(0, 3).map(s => s.symbol_name).filter(Boolean).join(', ');
    return top ? `Exports: ${top}` : 'No header comment available.';
  })();

  const fileSummaryContent = `FILE: ${filePath}\n\nPurpose: ${primaryPurpose}\n\nKey exports: ${key_exports.join(', ') || '(none)'}\n\nImports: ${meta.imports.join(', ') || '(none)'}\n`;

  chunks.push({
    id: `${filePath}:__file_summary__`,
    content: fileSummaryContent,
    path: filePath,
    symbol_name: null,
    symbol_type: 'file_summary',
    signature: null,
    enclosing_class: null,
    exports: false,
    line_start: 1,
    line_end: codeText.split(/\n/).length,
    imports: meta.imports,
    token_count: String(fileSummaryContent).split(/\s+/).filter(Boolean).length
  });

  // Symbol chunks (AC1, AC3)
  for (const s of meta.symbols) {
    const chunk = {
      id: s.id,
      content: s.content,
      path: filePath,
      symbol_name: s.symbol_name,
      symbol_type: s.symbol_type,
      signature: s.signature || null,
      enclosing_class: s.enclosing_class || null,
      exports: Boolean(s.exports),
      line_start: s.line_start || null,
      line_end: s.line_end || null,
      imports: s.imports || [],
      token_count: s.token_count || String(s.content || '').split(/\s+/).filter(Boolean).length
    };
    // preserve jsdoc if present by prefixing content (AC1)
    if (s.jsdoc) chunk.content = `${s.jsdoc}\n${chunk.content}`;
    // parent_chunk_id handled by extractor for large symbols (AC5)
    if (s.parent_chunk_id) chunk.parent_chunk_id = s.parent_chunk_id;

    chunks.push(chunk);
  }

  return chunks;
}

export default { chunkFile };

/*
  symbol-extractor.mjs
  Heuristic, regex-based symbol extraction for JS/TS/MJS files.
  Produces symbol metadata suitable for symbol-level chunking.
*/

export function extractSymbols(filePath, codeText) {
  const out = {
    path: filePath,
    imports: [],
    exports: [],
    header_comment: null,
    symbols: []
  };

  // Helpers
  const lines = codeText.split(/\n/);
  const lineForIndex = idx => {
    // compute line number (1-based) from string index
    const prefix = codeText.slice(0, idx);
    return prefix.split(/\n/).length;
  };

  const countTokens = str => {
    if (!str) return 0;
    // simple token estimate: split on whitespace
    return String(str).trim().split(/\s+/).filter(Boolean).length;
  };

  // 1) imports (ESM and require)
  const importRegex = /^(?:import\s.+?from\s+['\"](.+?)['\"];?|const\s+.+?=\s+require\(['\"](.+?)['\"]\))/gm;
  let m;
  while ((m = importRegex.exec(codeText)) !== null) {
    const pkg = m[1] || m[2];
    if (pkg && !out.imports.includes(pkg)) out.imports.push(pkg);
  }

  // 2) header comment (leading block comment or consecutive line comments)
  const headerBlockMatch = codeText.match(/^\s*(?:\/\*\*[\s\S]*?\*\/|(?:\/\/.*\n){1,6})/);
  if (headerBlockMatch) {
    out.header_comment = headerBlockMatch[0].trim();
  }

  // 3) track named exports via `export { ... }` and `export default` and inline exports
  const exportListRegex = /export\s*\{([^}]+)\}/g;
  while ((m = exportListRegex.exec(codeText)) !== null) {
    const names = m[1].split(',').map(s => s.split('as')[0].trim()).filter(Boolean);
    out.exports.push(...names);
  }
  if (/export\s+default\s+/m.test(codeText)) out.exports.push('default');

  // Utility: find balanced brace range starting at an index that has a '{'
  function findBalanced(startIdx) {
    let i = startIdx;
    const len = codeText.length;
    if (codeText[i] !== '{') return -1;
    let depth = 0;
    for (; i < len; i++) {
      const ch = codeText[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  // Utility: capture preceding JSDoc (/** ... */) immediately above a start index
  function captureJSDocBefore(startIdx) {
    // look backwards for nearest '/**' that ends right before startIdx (allow whitespace/newlines)
    const slice = codeText.slice(0, startIdx);
    const jsdocMatch = slice.match(/\/\*[\s\S]*?\*\//g);
    if (!jsdocMatch) return null;
    const last = jsdocMatch[jsdocMatch.length - 1];
    const lastIndex = slice.lastIndexOf(last);
    const between = slice.slice(lastIndex + last.length).trim();
    if (between === '') return last;
    return null;
  }

  // 4) find classes
  const classRegex = /(^|\n)\s*(export\s+)?class\s+([A-Za-z0-9_$]+)/g;
  while ((m = classRegex.exec(codeText)) !== null) {
    const name = m[3];
    const declIdx = m.index + m[0].indexOf('class');
    const braceStart = codeText.indexOf('{', declIdx);
    let bodyEnd = -1;
    if (braceStart !== -1) bodyEnd = findBalanced(braceStart);
    const startLine = lineForIndex(m.index + 1);
    const endLine = bodyEnd !== -1 ? lineForIndex(bodyEnd) : startLine;

    const signatureLine = codeText.slice(m.index, (braceStart === -1 ? m.index + m[0].length : braceStart)).split(/\n/)[0].trim();
    const jsdoc = captureJSDocBefore(m.index) || null;
    const fullText = codeText.slice(m.index, (bodyEnd === -1 ? m.index + m[0].length : bodyEnd + 1));
    const tokenCount = countTokens(fullText);

    // attempt to extract methods as sub-symbols (very heuristic)
    const methodRegex = /(?:^|\n)\s*(?:async\s+)?([A-Za-z0-9_$]+)\s*\(([\s\S]*?)\)\s*\{/g;
    const methods = [];
    const classBody = bodyEnd !== -1 ? codeText.slice(braceStart + 1, bodyEnd) : '';
    let mm;
    while ((mm = methodRegex.exec(classBody)) !== null) {
      const mName = mm[1];
      // compute approximate positions
      const methodStartInFile = braceStart + 1 + mm.index;
      const methodBodyStart = codeText.indexOf('{', methodStartInFile);
      const methodBodyEnd = methodBodyStart !== -1 ? findBalanced(methodBodyStart) : methodStartInFile;
      const methodText = codeText.slice(methodStartInFile, methodBodyEnd === -1 ? methodStartInFile + 1 : methodBodyEnd + 1);
      methods.push({ name: mName, content: methodText, line_start: lineForIndex(methodStartInFile), line_end: methodBodyEnd === -1 ? lineForIndex(methodStartInFile) : lineForIndex(methodBodyEnd) });
    }

    out.symbols.push({
      id: `${filePath}:${name}`,
      symbol_name: name,
      symbol_type: 'class',
      signature: signatureLine,
      content: fullText,
      enclosing_class: null,
      exports: /export\s+class/.test(m[0]) || out.exports.includes(name),
      line_start: startLine,
      line_end: endLine,
      imports: out.imports.slice(),
      token_count: tokenCount,
      jsdoc: jsdoc,
      methods
    });
  }

  // 5) functions (named function declarations)
  const funcRegex = /(^|\n)\s*(export\s+)?(async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([\s\S]*?)\)\s*\{/g;
  while ((m = funcRegex.exec(codeText)) !== null) {
    const name = m[4];
    const declIdx = m.index + m[0].indexOf('function');
    const braceStart = codeText.indexOf('{', declIdx);
    const bodyEnd = braceStart !== -1 ? findBalanced(braceStart) : declIdx + m[0].length;
    const startLine = lineForIndex(m.index + 1);
    const endLine = bodyEnd !== -1 ? lineForIndex(bodyEnd) : startLine;
    const signature = codeText.slice(m.index, braceStart).split(/\n/)[0].trim();
    const jsdoc = captureJSDocBefore(m.index) || null;
    const fullText = codeText.slice(m.index, (bodyEnd === -1 ? m.index + m[0].length : bodyEnd + 1));
    const tokenCount = countTokens(fullText);

    out.symbols.push({
      id: `${filePath}:${name}`,
      symbol_name: name,
      symbol_type: 'function',
      signature: signature,
      content: fullText,
      enclosing_class: null,
      exports: /export\s+function/.test(m[0]) || out.exports.includes(name),
      line_start: startLine,
      line_end: endLine,
      imports: out.imports.slice(),
      token_count: tokenCount,
      jsdoc
    });
  }

  // 6) arrow functions assigned to const/let/var
  const arrowRegex = /(^|\n)\s*(export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\(([\s\S]*?)\)|([A-Za-z0-9_$]+))\s*=>\s*(\{?)/g;
  while ((m = arrowRegex.exec(codeText)) !== null) {
    const name = m[3];
    const hasBlock = m[6] === '{';
    const declIdx = m.index + m[0].indexOf(m[0].trim());
    let bodyEnd = declIdx + m[0].length;
    if (hasBlock) {
      const braceStart = codeText.indexOf('{', declIdx + m[0].indexOf('=>'));
      if (braceStart !== -1) bodyEnd = findBalanced(braceStart);
    } else {
      // single-expression arrow -> end at next semicolon or newline
      const semIdx = codeText.indexOf(';', declIdx);
      if (semIdx !== -1) bodyEnd = semIdx;
      else {
        const nl = codeText.indexOf('\n', declIdx);
        if (nl !== -1) bodyEnd = nl;
      }
    }
    const startLine = lineForIndex(m.index + 1);
    const endLine = bodyEnd !== -1 ? lineForIndex(bodyEnd) : startLine;
    const signature = codeText.slice(m.index, (hasBlock ? codeText.indexOf('{', declIdx) : bodyEnd)).split(/\n/)[0].trim();
    const jsdoc = captureJSDocBefore(m.index) || null;
    const fullText = codeText.slice(m.index, (bodyEnd === -1 ? m.index + m[0].length : bodyEnd + 1));
    const tokenCount = countTokens(fullText);

    out.symbols.push({
      id: `${filePath}:${name}`,
      symbol_name: name,
      symbol_type: 'function',
      signature: signature,
      content: fullText,
      enclosing_class: null,
      exports: /export\s+(?:const|let|var)/.test(m[0]) || out.exports.includes(name),
      line_start: startLine,
      line_end: endLine,
      imports: out.imports.slice(),
      token_count: tokenCount,
      jsdoc
    });
  }

  // 7) types/interfaces
  const typeRegex = /(^|\n)\s*(export\s+)?(type|interface)\s+([A-Za-z0-9_$]+)\s*(=|\{)/g;
  while ((m = typeRegex.exec(codeText)) !== null) {
    const name = m[4];
    const declIdx = m.index + m[0].indexOf(m[0].trim());
    // capture until semicolon or matching brace
    let endIdx = codeText.indexOf(';', declIdx);
    if (m[5] === '{') {
      const braceStart = codeText.indexOf('{', declIdx);
      const braceEnd = braceStart !== -1 ? findBalanced(braceStart) : -1;
      endIdx = braceEnd === -1 ? (endIdx === -1 ? declIdx + m[0].length : endIdx) : braceEnd;
    }
    const startLine = lineForIndex(m.index + 1);
    const endLine = endIdx !== -1 ? lineForIndex(endIdx) : startLine;
    const signature = codeText.slice(m.index, endIdx === -1 ? m.index + m[0].length : endIdx + 1).split(/\n/)[0].trim();
    const fullText = codeText.slice(m.index, endIdx === -1 ? m.index + m[0].length : endIdx + 1);
    const tokenCount = countTokens(fullText);

    out.symbols.push({
      id: `${filePath}:${name}`,
      symbol_name: name,
      symbol_type: m[3],
      signature: signature,
      content: fullText,
      enclosing_class: null,
      exports: /export\s+(type|interface)/.test(m[0]) || out.exports.includes(name),
      line_start: startLine,
      line_end: endLine,
      imports: out.imports.slice(),
      token_count: tokenCount,
      jsdoc: null
    });
  }

  // 8) finalize exports: attempt to mark symbols that match names
  const exportNames = new Set(out.exports.filter(Boolean));
  if (exportNames.size > 0) {
    for (const s of out.symbols) {
      if (exportNames.has(s.symbol_name) || s.exports) s.exports = true;
    }
  }

  // 9) Large symbol handling: produce child segments metadata if token_count > 2000 (MVP: split by blank lines)
  const LARGE_TOKEN_THRESHOLD = 2000;
  const augmented = [];
  for (const s of out.symbols) {
    if (s.token_count > LARGE_TOKEN_THRESHOLD) {
      // create primary chunk with signature + first N lines
      const contentLines = s.content.split(/\n/);
      const firstN = 40; // simple heuristic for MVP
      const primary = Object.assign({}, s, {
        content: contentLines.slice(0, firstN).join('\n') + '\n/* truncated - see child segments */',
        token_count: countTokens(contentLines.slice(0, firstN).join('\n'))
      });
      // split remaining by blank lines
      const remaining = contentLines.slice(firstN).join('\n');
      const segments = remaining.split(/\n\s*\n/).filter(Boolean);
      const children = segments.map((seg, idx) => ({
        id: `${s.id}:segment:${idx + 1}`,
        symbol_name: `${s.symbol_name}::segment_${idx + 1}`,
        symbol_type: s.symbol_type,
        signature: `${s.signature} [segment ${idx + 1}]`,
        content: seg,
        enclosing_class: s.enclosing_class,
        exports: false,
        line_start: s.line_start,
        line_end: s.line_end,
        imports: s.imports,
        token_count: countTokens(seg),
        parent_chunk_id: s.id
      }));
      augmented.push(primary, ...children);
    } else {
      augmented.push(s);
    }
  }

  out.symbols = augmented;

  return out;
}

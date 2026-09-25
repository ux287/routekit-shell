import { parseDendronNote, headingPathForNode, estimateTokens } from './dendron-parser.mjs';

function simpleHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(16);
}

function joinParagraphs(pars) {
  return pars.map(p => p.trim()).filter(Boolean).join('\n\n');
}

export function chunkParsedNote(parsed, options = {}) {
  const SOFT_LIMIT = options.softLimit || 1500;
  const HARD_LIMIT = options.hardLimit || 2500;
  const OVERLAP_RATIO = options.overlapRatio || 0.12; // 10-15%

  const chunks = [];
  const nodes = parsed.nodes || [];
  // If the note has no headings, create a single pseudo-chunk for whole body
  if (!nodes.length) {
    const content = parsed.body || '';
    const token_count = estimateTokens(content);
    const dendron_id = parsed.dendron_id || 'unknown';
    const note_type = dendron_id && dendron_id.includes('.') ? dendron_id.split('.')[0] : '';
    chunks.push({
      id: `${dendron_id || 'note'}:${simpleHash(content.slice(0, 120))}`,
      content,
      path: parsed.path || null,
      dendron_id,
      heading_path: [],
      note_type,
      tags: parsed.metadata && parsed.metadata.tags ? parsed.metadata.tags : [],
      created: parsed.metadata && parsed.metadata.created ? parsed.metadata.created : null,
      updated: parsed.metadata && parsed.metadata.updated ? parsed.metadata.updated : null,
      token_count
    });
    return chunks;
  }

  // Build section chunks per heading node (each node is heading + its content)
  const sectionChunks = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const headingText = node.heading || '';
    const sectionText = (headingText ? `# ${headingText}\n\n` : '') + (node.content || '');
    sectionChunks.push({ node, text: sectionText });
  }

  // helper to split a long section into paragraph-based subchunks
  function splitSectionByParagraphs(text) {
    const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    if (paragraphs.length <= 1) return [text];
    const out = [];
    let cur = [];
    for (const p of paragraphs) {
      const candidate = joinParagraphs(cur.concat([p]));
      const tokens = estimateTokens(candidate);
      if (tokens > HARD_LIMIT && cur.length === 0) {
        // a single paragraph too big -> force include it (can't do better)
        out.push(p);
      } else if (tokens > HARD_LIMIT) {
        out.push(joinParagraphs(cur));
        cur = [p];
      } else {
        cur.push(p);
      }
    }
    if (cur.length) out.push(joinParagraphs(cur));
    return out.length ? out : [text];
  }

  // produce final chunks from sections (with internal splits as needed)
  const produced = [];
  for (let i = 0; i < sectionChunks.length; i++) {
    const sec = sectionChunks[i];
    const tokens = estimateTokens(sec.text);
    if (tokens <= HARD_LIMIT) {
      produced.push({ node: sec.node, text: sec.text });
    } else {
      // split by paragraphs
      const parts = splitSectionByParagraphs(sec.text);
      for (let p = 0; p < parts.length; p++) {
        const partText = parts[p];
        // if not the first part, include heading for context (heading prefix)
        const includeHeading = p === 0 ? '' : `# ${sec.node.heading}\n\n`;
        produced.push({ node: sec.node, text: includeHeading + partText });
      }
    }
  }

  // Apply overlap across produced chunks: include trailing words from previous chunk
  for (let i = 0; i < produced.length; i++) {
    const item = produced[i];
    const dendron_id = parsed.dendron_id || filenameFromPath(parsed.path) || 'unknown';
    const heading_path = headingPathForNode(item.node).map(h => String(h));
    let content = item.text.trim();

    // compute overlap from previous chunk (10-15%)
    if (i > 0) {
      const prevText = produced[i - 1].text || '';
      const prevTokens = estimateTokens(prevText);
      const overlapTokens = Math.max(1, Math.round(prevTokens * OVERLAP_RATIO));
      const prevWords = prevText.split(/\s+/).filter(Boolean);
      const overlapWords = prevWords.slice(-overlapTokens).join(' ');
      if (overlapWords) {
        content = overlapWords + '\n\n' + content;
      }
    }

    const token_count = estimateTokens(content);
    const hashSeed = `${dendron_id}:${heading_path.join('>')}:${content.slice(0, 120)}`;
    const id = `${dendron_id || 'note'}:${simpleHash(hashSeed)}`;
    const note_type = dendron_id && dendron_id.includes('.') ? dendron_id.split('.')[0] : '';

    produced[i] = Object.assign(item, { content, token_count, dendron_id, heading_path, id, note_type });
  }

  // Turn produced items into index records and attach metadata
  for (const p of produced) {
    chunks.push({
      id: p.id,
      content: p.content,
      path: parsed.path || null,
      dendron_id: p.dendron_id,
      heading_path: p.heading_path,
      note_type: p.note_type,
      tags: parsed.metadata && parsed.metadata.tags ? parsed.metadata.tags : [],
      created: parsed.metadata && parsed.metadata.created ? parsed.metadata.created : null,
      updated: parsed.metadata && parsed.metadata.updated ? parsed.metadata.updated : null,
      token_count: p.token_count
    });
  }

  return chunks;
}

function filenameFromPath(path) {
  if (!path) return null;
  return path.split('/').pop().replace(/\.mdx?$|\.md$/i, '');
}

export function chunkNoteText(text, path = null, options = {}) {
  const parsed = parseDendronNote(text, path);
  return chunkParsedNote(parsed, options);
}

export function chunkNoteFile(noteObject, options = {}) {
  // convenience: accept an object produced by parseDendronNote
  return chunkParsedNote(noteObject, options);
}

// default export convenience
export default { chunkNoteText, chunkParsedNote, chunkNoteFile };

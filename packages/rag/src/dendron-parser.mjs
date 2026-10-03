export function parseFrontmatter(text) {
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return { metadata: {} , raw: null };
  const raw = fmMatch[1];
  const lines = raw.split(/\n/);
  const metadata = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2];
    // quick parsing for common types
    if (val === "|" || val === ">") {
      // multiline - collect following indented lines
      let j = i + 1;
      const buf = [];
      while (j < lines.length && /^\s+/.test(lines[j])) {
        buf.push(lines[j].replace(/^\s+/, ""));
        j++;
      }
      val = buf.join('\n');
      i = j - 1;
    } else if (/^\[.*\]$/.test(val)) {
      // inline array
      try {
        // allow single-quoted items by replacing single quotes with double for JSON parsing
        const jsony = val.replace(/'/g, '"');
        val = JSON.parse(jsony);
      } catch (e) {
        // fallback: comma split
        val = val.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
      }
    } else if (/^\d{4}-\d{2}-\d{2}/.test(val)) {
      val = val; // keep date strings as-is
    } else if (val === 'true' || val === 'false') {
      val = val === 'true';
    } else if (!isNaN(Number(val))) {
      val = Number(val);
    }
    metadata[key] = val;
  }
  return { metadata, raw };
}

function ensureArray(x) { return Array.isArray(x) ? x : x ? [x] : []; }

export function parseHeadings(text) {
  const lines = text.split(/\n/);
  const nodes = [];
  const stack = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const level = m[1].length;
      const heading = m[2].trim();
      const node = {
        heading,
        level,
        startLine: i,
        endLine: null,
        children: [],
        parent: null
      };
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      if (stack.length) {
        node.parent = stack[stack.length - 1];
        stack[stack.length - 1].children.push(node);
      }
      stack.push(node);
      nodes.push(node);
    }
  }

  // compute endLine for each node (end is line before next node of same-or-higher level)
  for (let i = 0; i < nodes.length; i++) {
    const cur = nodes[i];
    let nextIdx = lines.length;
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[j].level <= cur.level) { nextIdx = nodes[j].startLine; break; }
    }
    cur.endLine = nextIdx - 1;
    // capture content lines between heading and endLine
    const contentLines = [];
    for (let L = cur.startLine + 1; L <= cur.endLine && L < lines.length; L++) contentLines.push(lines[L]);
    cur.content = contentLines.join('\n').trim();
  }

  return { lines, nodes };
}

function filenameToDendronId(path) {
  if (!path) return null;
  const seg = path.split('/').pop();
  return seg ? seg.replace(/\.mdx?$|\.md$/i, '') : null;
}

export function parseDendronNote(text, path = null) {
  const fm = parseFrontmatter(text);
  const body = fm.raw ? text.replace(/^---\n[\s\S]*?\n---\n?/, '') : text;
  const { nodes, lines } = parseHeadings(body);
  // build a flat list with root sections as needed
  const flat = nodes.map(n => ({
    heading: n.heading,
    level: n.level,
    content: n.content,
    parent: n.parent,
    children: n.children,
    startLine: n.startLine,
    endLine: n.endLine
  }));
  const dendron_id = fm.metadata && fm.metadata.id ? fm.metadata.id : filenameToDendronId(path);
  // some helpers
  return {
    metadata: fm.metadata || {},
    rawFrontmatter: fm.raw || null,
    body,
    dendron_id,
    path,
    lines,
    nodes: flat
  };
}

// simple utility to get heading path for a node (walk parents)
export function headingPathForNode(node) {
  const path = [];
  let cur = node;
  while (cur) {
    if (cur.heading) path.unshift(cur.heading);
    cur = cur.parent || null;
  }
  return path;
}

// simple token estimator (words -> tokens approx)
export function estimateTokens(text) {
  if (!text) return 0;
  const words = text.split(/\s+/).filter(Boolean).length;
  // rough heuristic: 1 token ~ 0.75 words (depends on tokenizer); using 1 word = 1 token is simpler and safe
  return Math.max(1, Math.round(words));
}

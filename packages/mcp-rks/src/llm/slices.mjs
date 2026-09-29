function findFunctionSlice(sourceText, functionName) {
  if (!sourceText || !functionName) return null;
  const patterns = [
    new RegExp(`\\bfunction\\s+${functionName}\\b`, "g"),
    new RegExp(`\\basync\\s+function\\s+${functionName}\\b`, "g"),
    new RegExp(`\\bexport\\s+function\\s+${functionName}\\b`, "g"),
    new RegExp(`\\bexport\\s+async\\s+function\\s+${functionName}\\b`, "g"),
    new RegExp(`\\b(?:const|let|var)\\s+${functionName}\\s*=\\s*\\(?`, "g"),
    new RegExp(`\\b${functionName}\\s*=\\s*\\(`, "g"),
  ];

  const candidates = [];

  patterns.forEach((pat) => {
    let match;
    while ((match = pat.exec(sourceText)) !== null) {
      candidates.push(match.index);
    }
  });

  // Remove duplicate indices
  const unique = Array.from(new Set(candidates)).sort((a, b) => a - b);
  if (unique.length !== 1) return null; // not found or ambiguous

  const startIndex = unique[0];
  const braceStart = sourceText.indexOf("{", startIndex);
  if (braceStart === -1) return null;

  let depth = 0;
  let endIndex = -1;
  for (let i = braceStart; i < sourceText.length; i += 1) {
    const ch = sourceText[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    if (depth === 0) {
      endIndex = i + 1; // include closing brace
      break;
    }
  }
  if (endIndex === -1) return null;

  return {
    startIndex,
    endIndex,
    text: sourceText.slice(startIndex, endIndex),
  };
}

function replaceSlice(sourceText, slice, newText) {
  if (!slice || typeof slice.startIndex !== "number" || typeof slice.endIndex !== "number") {
    throw new Error("Invalid slice");
  }
  return sourceText.slice(0, slice.startIndex) + newText + sourceText.slice(slice.endIndex);
}

/**
 * Extract a function slice with surrounding context lines.
 * Returns { text, startLine, endLine, totalLines, functionName } or null.
 * startLine/endLine are 1-indexed and include the context padding.
 */
function getSliceWithContext(sourceText, functionName, contextLines = 5) {
  const slice = findFunctionSlice(sourceText, functionName);
  if (!slice) return null;

  const lines = sourceText.split("\n");
  let charCount = 0;
  let sliceStartLine = 0;
  let sliceEndLine = lines.length - 1;

  for (let i = 0; i < lines.length; i++) {
    const lineEnd = charCount + lines[i].length + 1; // +1 for \n
    if (charCount <= slice.startIndex && slice.startIndex < lineEnd) {
      sliceStartLine = i;
    }
    if (slice.endIndex <= lineEnd) {
      sliceEndLine = i;
      break;
    }
    charCount = lineEnd;
  }

  const paddedStart = Math.max(0, sliceStartLine - contextLines);
  const paddedEnd = Math.min(lines.length - 1, sliceEndLine + contextLines);

  return {
    text: lines.slice(paddedStart, paddedEnd + 1).join("\n"),
    startLine: paddedStart + 1,
    endLine: paddedEnd + 1,
    totalLines: lines.length,
    functionName,
  };
}

export { findFunctionSlice, replaceSlice, getSliceWithContext };

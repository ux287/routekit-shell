// Observation-only sizing of an MCP tool response. Never throws; never mutates.
export function measureToolResponse(response) {
  const zero = { responseBytes: 0, responseChars: 0, approxTokens: 0, contentBlocks: 0 };
  const blocks = Array.isArray(response?.content) ? response.content : null;
  if (!blocks) return zero;
  let bytes = 0;
  let chars = 0;
  for (const block of blocks) {
    if (block && block.type === "text" && typeof block.text === "string") {
      bytes += Buffer.byteLength(block.text, "utf8");
      chars += block.text.length;
    }
  }
  return {
    responseBytes: bytes,
    responseChars: chars,
    approxTokens: Math.ceil(chars / 4),
    contentBlocks: blocks.length,
  };
}

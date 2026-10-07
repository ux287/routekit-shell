/**
 * backlog.fix.reviewer-response-invalid-escape-salvage
 *
 * A reviewer that quotes regex source inside a JSON string value emits invalid
 * JSON escapes (\d, \., \s, \w) and JSON.parse throws. parseReviewerResponse
 * must salvage those with a fallback escape-repair stage, and buildReviewPrompt
 * must stop asking for code snippets in the "line" field.
 *
 * Unit-tier pure: no spawn-family call, no vi.mock.
 */
import { describe, it, expect } from 'vitest';
import { parseReviewerResponse, buildReviewPrompt } from '../../packages/mcp-rks/src/server/review.mjs';

const INVALID = String.raw`{"verdict":"warn","summary":"s","findings":[{"line":"/^\d+\.\d+$/"}]}`;
const REGEX_TEXT = String.raw`/^\d+\.\d+$/`;

describe('parseReviewerResponse — invalid JSON escape repair', () => {
  it('fixture is genuinely invalid JSON (positive control)', () => {
    expect(() => JSON.parse(INVALID)).toThrow();
  });

  it('repairs \\d and \\. inside a string value and preserves the backslash', () => {
    const parsed = parseReviewerResponse(INVALID);
    expect(parsed).not.toBeNull();
    expect(parsed.verdict).toBe('warn');
    expect(parsed.findings[0].line).toBe(REGEX_TEXT);
  });

  it('repairs \\s and \\w as well', () => {
    const raw = String.raw`{"verdict":"pass","summary":"\s+\w*","findings":[]}`;
    expect(() => JSON.parse(raw)).toThrow();
    expect(parseReviewerResponse(raw).summary).toBe(String.raw`\s+\w*`);
  });

  it('repairs an invalid-escape object wrapped in prose', () => {
    const parsed = parseReviewerResponse(`I'll systematically review the diff.\n\n${INVALID}\n\nThat is all.`);
    expect(parsed).not.toBeNull();
    expect(parsed.findings[0].line).toBe(REGEX_TEXT);
  });

  it('repairs an invalid-escape object inside a json fence', () => {
    const parsed = parseReviewerResponse('```json\n' + INVALID + '\n```');
    expect(parsed).not.toBeNull();
    expect(parsed.findings[0].line).toBe(REGEX_TEXT);
  });

  it('decodes valid escapes exactly and preserves only the invalid one', () => {
    const raw = String.raw`{"verdict":"warn","summary":"a\nb \"q\" c\\d e\/f ` + '\\' + 'u' + String.raw`00e9 x\d","findings":[]}`; // contains a \\u-hex escape for e-acute
    expect(() => JSON.parse(raw)).toThrow();
    expect(parseReviewerResponse(raw).summary).toBe('a\nb "q" c\\d e/f é x\\d');
  });

  it('treats \\u without four hex digits as invalid and preserves it', () => {
    const raw = String.raw`{"verdict":"pass","summary":"\uZZ","findings":[]}`;
    expect(parseReviewerResponse(raw).summary).toBe(String.raw`\uZZ`);
  });

  it('parses valid JSON exactly as JSON.parse does (repair is fallback only)', () => {
    const samples = [
      String.raw`{"verdict":"pass","summary":"a\nb \"q\" c\\d e\/f ` + '\\' + 'u' + String.raw`00e9","findings":[]}`,
      '{"verdict":"block","summary":"x","findings":[{"category":"security","severity":"block","file":"a.js","line":12,"message":"m"}]}',
    ];
    for (const s of samples) {
      expect(parseReviewerResponse(s)).toEqual(JSON.parse(s));
      expect(parseReviewerResponse('Preamble.\n' + s + '\nTrailer.')).toEqual(JSON.parse(s));
    }
  });

  it('does not repair a backslash outside string literals', () => {
    expect(parseReviewerResponse(String.raw`{"verdict":"pass"\d,"findings":[]}`)).toBeNull();
  });

  it('never throws and returns null for unrecoverable input', () => {
    const inputs = ['', null, undefined, 'no json here', '{', '{"a":"\\', '{"a":"\\q'];
    for (const input of inputs) {
      expect(() => parseReviewerResponse(input)).not.toThrow();
      expect(parseReviewerResponse(input)).toBeNull();
    }
  });
});

describe('buildReviewPrompt — line numbers, not quoted code', () => {
  const prompt = buildReviewPrompt({
    diff: '+const re = /^\\d+$/;',
    story: null,
    ragContext: [],
    changedFiles: ['src/a.js'],
  });

  it('no longer requests a code snippet for line', () => {
    expect(prompt).not.toContain('relevant code snippet or null');
    expect(prompt).not.toContain('Reference actual code from the diff in your findings.');
  });

  it('asks for a line number and forbids quoting code in JSON values', () => {
    expect(prompt).toMatch(/"line":[^\n]*line number/i);
    expect(prompt).toMatch(/do not quote code/i);
  });

  it('keeps the JSON-only output contract', () => {
    expect(prompt).toContain('Respond with JSON only');
    expect(prompt).toContain('"findings"');
  });
});

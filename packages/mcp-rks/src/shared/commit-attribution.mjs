/**
 * backlog.fix.commit-trailer-hardcodes-stale-model-name
 *
 * The Co-Authored-By trailer is sourced ONLY from what the caller supplies. rks does not
 * observe which model drove a session, so it never writes a model name of its own: a
 * hardcoded name is intent, not observation, and goes stale the moment the model changes.
 * No value, or a malformed one, yields no trailer.
 */
const CO_AUTHOR_RE = /^[^\r\n<>]+ <[^\s<>@]+@[^\s<>]+>$/;

// Returned and logged by the rks_git_commit and rks_guardrails_on handlers when a caller
// supplied a coAuthor that coAuthorTrailer rejected (ARCH R9: never degrade silently).
export const CO_AUTHOR_REJECTED_WARNING = "coAuthor was not 'Name <email>'; no Co-Authored-By trailer was written";

export function coAuthorTrailer(coAuthor) {
  if (typeof coAuthor !== "string") return "";
  const value = coAuthor.trim();
  if (!CO_AUTHOR_RE.test(value)) return "";
  return `\n\nCo-Authored-By: ${value}`;
}

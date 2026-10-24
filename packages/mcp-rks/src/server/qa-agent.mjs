import { resolveBackend } from "../llm/backend.mjs";
import { getTelemetryCollector } from "@routekit/telemetry";
import { assertAnthropicCredential } from "../llm/credential-preflight.mjs";
import { DEFAULT_SONNET_MODEL } from "../shared/default-models.mjs";
import { SUBSCRIPTION_REFUSAL_REASON } from "../llm/claude-cli/subscription-status.mjs";

const QA_AGENT_PROMPT = `You are a QA Agent with a FALSIFICATION mindset. Your job is to FIND BUGS that tests would miss.

PHILOSOPHY:
- Assume all software has bugs
- Your job is NOT to validate tests look good
- Your job IS to find the exploitable gap
- Success = "I tried hard but couldn't break it" (disappointed, not satisfied)

STORY CLASSIFICATION: {{tddApplicable}}

{{#if tddApplicable === 'strong'}}
TDD-APPLICABLE STORY - Additional checks:
- Does the failing test actually reproduce the bug, or just a symptom?
- What related bug could exist that this test wouldn't catch?
- Is there a way to pass this test while still being broken?
{{else}}
NON-TDD STORY - Focus on:
- What failure mode is completely unhandled?
- Where is the riskiest code path?
- What would a malicious user try?
{{/if}}

ADVERSARIAL QUESTIONS TO ASK:
- What happens if I pass null here?
- What if the network fails mid-operation?
- What if two requests arrive simultaneously?
- What if the input is empty? Huge? Contains special characters?

PLANNED TESTS:
{{testCode}}

IMPLEMENTATION BEING TESTED:
{{implementationCode}}

RESPOND WITH JSON:
{
  "verdict": "block" | "warn" | "pass",
  "exploitableGaps": ["gap1", "gap2"],
  "missingTestCases": ["case1", "case2"],
  "reasoning": "Why I believe these gaps exist",
  "disappointment": "What I tried but couldn't break" // Only if verdict is pass
}`;

export async function runQaAgentReview({ plan, tddApplicable, testCode, implementationCode, projectId }) {
  const collector = getTelemetryCollector();
  const startTime = Date.now();

  try {
    // Invoke-time credential gate (shared guard) — clear, value-free error before the SDK is
    // constructed on a keyless boot; surfaced by the enclosing catch as a graceful { ok:false }.
    // backlog.feat.oneshot-callers-keyless-reachable (AC1, AC2): with no key the backend is
    // resolved, and the guard's error stands unless that backend is the claude-cli one-shot. A
    // throw from resolution counts as "not claude-cli". The keyed path is unchanged.
    let noKeyBackend = null;
    try {
      assertAnthropicCredential();
    } catch (credentialError) {
      try {
        noKeyBackend = resolveBackend({ caller: "qa-agent", pinProvider: "anthropic" });
      } catch {
        noKeyBackend = null;
      }
      if (noKeyBackend?.id !== "claude-cli") throw credentialError;
    }
    const backend = noKeyBackend || resolveBackend({ caller: "qa-agent", pinProvider: "anthropic" });
    const prompt = QA_AGENT_PROMPT
      .replace('{{tddApplicable}}', tddApplicable || 'unknown')
      .replace('{{testCode}}', testCode || 'No test code provided')
      .replace('{{implementationCode}}', implementationCode || 'No implementation code provided');

    const model = DEFAULT_SONNET_MODEL;
    const completion = await backend.complete({
      transport: "sdk",
      model,
      prompt,
      maxTokens: 1024,
      context: { projectId: projectId || null, caller: "qa-agent" },
    });
    // AC4: a one-shot refusal is detected from its reason field (never its error text). No retry,
    // and never ok:true without a verdict.
    if (completion?.reason === SUBSCRIPTION_REFUSAL_REASON) {
      const error = completion.message || completion.error || SUBSCRIPTION_REFUSAL_REASON;
      collector.emit("qa_agent.error", projectId, { error, reason: SUBSCRIPTION_REFUSAL_REASON });
      return {
        ok: false,
        blocked: false, // Don't block on QA Agent errors
        error,
        reason: SUBSCRIPTION_REFUSAL_REASON,
        fallback: "none",
        ...(completion.probeReason ? { probeReason: completion.probeReason } : {}),
      };
    }
    const { content: replyText, usage, usageEmitted } = completion;

    // One llm.token_usage per billed response (backlog.fix.llm-token-usage-complete-coverage).
    // Best-effort: a throwing collector never turns a good review into ok:false.
    if (!usageEmitted && usage) {
      try {
        collector.emit("llm.token_usage", projectId || null, {
          clientName: "anthropic-sdk",
          model,
          caller: "qa-agent",
          tokens: {
            in: usage.input_tokens ?? 0,
            out: usage.output_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheCreate: usage.cache_creation_input_tokens ?? 0,
          },
        });
      } catch { /* telemetry is best-effort */ }
    }

    const content = replyText || '{}';
    let result;
    try {
      result = JSON.parse(content);
    } catch {
      result = { verdict: 'warn', reasoning: content, exploitableGaps: [] };
    }

    collector.emit("qa_agent.review", projectId, {
      verdict: result.verdict,
      gapCount: result.exploitableGaps?.length || 0,
      tddApplicable,
      durationMs: Date.now() - startTime,
    });

    return {
      ok: true,
      ...result,
      blocked: result.verdict === 'block',
    };
  } catch (error) {
    collector.emit("qa_agent.error", projectId, { error: error.message });
    return {
      ok: false,
      error: error.message,
      blocked: false, // Don't block on QA Agent errors
    };
  }
}

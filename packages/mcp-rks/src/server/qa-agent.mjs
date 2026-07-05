import Anthropic from "@anthropic-ai/sdk";
import { getTelemetryCollector } from "./telemetry/index.mjs";

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
    const client = new Anthropic();
    const prompt = QA_AGENT_PROMPT
      .replace('{{tddApplicable}}', tddApplicable || 'unknown')
      .replace('{{testCode}}', testCode || 'No test code provided')
      .replace('{{implementationCode}}', implementationCode || 'No implementation code provided');

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const content = response.content[0]?.text || '{}';
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

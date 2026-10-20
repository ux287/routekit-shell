#!/usr/bin/env node

/**
 * Orchestrator Phase 1 Test Suite
 * Tests core orchestration functionality
 */

import { analyzeQuery, shouldOrchestrate, QUERY_TYPES, COMPLEXITY_LEVELS, RESPONSE_FORMATS } from "./mcp/orchestrator-engine.mjs";

console.log("🧪 Starting Orchestrator Phase 1 Test Suite\n");

// Test cases from the patterns configuration
const testCases = [
  // Implementation queries
  {
    query: "How do I implement authentication in RouteKit?",
    expected: {
      type: QUERY_TYPES.IMPLEMENTATION,
      complexity: COMPLEXITY_LEVELS.MULTI_STEP,
      format: RESPONSE_FORMATS.IMPLEMENTATION
    },
    expectOrchestration: true
  },
  {
    query: "How can I add a new CLI command?",
    expected: {
      type: QUERY_TYPES.IMPLEMENTATION,
      complexity: COMPLEXITY_LEVELS.MULTI_STEP,
      format: RESPONSE_FORMATS.IMPLEMENTATION
    },
    expectOrchestration: true
  },
  
  // Comparative queries
  {
    query: "Compare CLI approach vs template approach",
    expected: {
      type: QUERY_TYPES.COMPARATIVE,
      complexity: COMPLEXITY_LEVELS.MULTI_STEP,
      format: RESPONSE_FORMATS.COMPARISON
    },
    expectOrchestration: true
  },
  {
    query: "What's the difference between RAG and FS search?",
    expected: {
      type: QUERY_TYPES.COMPARATIVE,
      complexity: COMPLEXITY_LEVELS.MULTI_STEP,
      format: RESPONSE_FORMATS.COMPARISON
    },
    expectOrchestration: true
  },
  
  // Architectural queries
  {
    query: "Best approach for state management in RouteKit?",
    expected: {
      type: QUERY_TYPES.ARCHITECTURAL,
      complexity: COMPLEXITY_LEVELS.MULTI_STEP,
      format: RESPONSE_FORMATS.GUIDANCE
    },
    expectOrchestration: true
  },
  {
    query: "Recommended patterns for error handling",
    expected: {
      type: QUERY_TYPES.ARCHITECTURAL,
      complexity: COMPLEXITY_LEVELS.MULTI_STEP,
      format: RESPONSE_FORMATS.GUIDANCE
    },
    expectOrchestration: true
  },
  
  // Discovery queries
  {
    query: "What are all the available CLI commands?",
    expected: {
      type: QUERY_TYPES.DISCOVERY,
      complexity: COMPLEXITY_LEVELS.COMPREHENSIVE,
      format: RESPONSE_FORMATS.REFERENCE
    },
    expectOrchestration: true
  },
  {
    query: "Show me all design system components",
    expected: {
      type: QUERY_TYPES.DISCOVERY,
      complexity: COMPLEXITY_LEVELS.COMPREHENSIVE,
      format: RESPONSE_FORMATS.REFERENCE
    },
    expectOrchestration: true
  },
  
  // Factual queries (should NOT orchestrate)
  {
    query: "What is RouteKit Shell?",
    expected: {
      type: QUERY_TYPES.FACTUAL,
      complexity: COMPLEXITY_LEVELS.SIMPLE,
      format: RESPONSE_FORMATS.GUIDANCE
    },
    expectOrchestration: false
  },
  {
    query: "Define MCP integration",
    expected: {
      type: QUERY_TYPES.FACTUAL,
      complexity: COMPLEXITY_LEVELS.SIMPLE,
      format: RESPONSE_FORMATS.GUIDANCE
    },
    expectOrchestration: false
  }
];

let passed = 0;
let failed = 0;

console.log("📊 Running Query Classification Tests...\n");

for (const testCase of testCases) {
  console.log(`🔍 Testing: "${testCase.query}"`);
  
  try {
    const analysis = analyzeQuery(testCase.query);
    const shouldOrch = shouldOrchestrate(testCase.query);
    
    // Check classification
    const typeMatch = analysis.classification.type === testCase.expected.type;
    const complexityMatch = analysis.classification.complexity === testCase.expected.complexity;
    const formatMatch = analysis.classification.format === testCase.expected.format;
    const orchestrationMatch = shouldOrch === testCase.expectOrchestration;
    
    if (typeMatch && complexityMatch && formatMatch && orchestrationMatch) {
      console.log(`   ✅ PASSED - Type: ${analysis.classification.type}, Complexity: ${analysis.classification.complexity}, Format: ${analysis.classification.format}, Orchestration: ${shouldOrch}`);
      console.log(`   📋 Plan: ${analysis.orchestrationPlan.steps.length} steps, ${analysis.orchestrationPlan.estimatedQueries} queries`);
      passed++;
    } else {
      console.log(`   ❌ FAILED`);
      console.log(`      Expected: type=${testCase.expected.type}, complexity=${testCase.expected.complexity}, format=${testCase.expected.format}, orchestration=${testCase.expectOrchestration}`);
      console.log(`      Actual:   type=${analysis.classification.type}, complexity=${analysis.classification.complexity}, format=${analysis.classification.format}, orchestration=${shouldOrch}`);
      failed++;
    }
    
  } catch (error) {
    console.log(`   💥 ERROR: ${error.message}`);
    failed++;
  }
  
  console.log("");
}

console.log("📈 Test Results Summary:");
console.log(`✅ Passed: ${passed}/${testCases.length}`);
console.log(`❌ Failed: ${failed}/${testCases.length}`);
console.log(`📊 Success Rate: ${Math.round((passed / testCases.length) * 100)}%\n`);

if (failed === 0) {
  console.log("🎉 All tests passed! Phase 1 orchestrator implementation is working correctly.");
} else {
  console.log("⚠️  Some tests failed. Review the classification logic in orchestrator-engine.mjs");
}

// Test orchestration plan generation
console.log("🔧 Testing Orchestration Plan Generation...\n");

const complexQuery = "How do I implement authentication following our existing patterns and best practices?";
console.log(`🔍 Complex Query: "${complexQuery}"`);

try {
  const analysis = analyzeQuery(complexQuery);
  console.log(`📋 Generated Plan:`);
  console.log(`   Type: ${analysis.classification.type}`);
  console.log(`   Complexity: ${analysis.classification.complexity}`);
  console.log(`   Steps: ${analysis.orchestrationPlan.steps.length}`);
  console.log(`   Estimated Queries: ${analysis.orchestrationPlan.estimatedQueries}`);
  console.log(`   Plan Steps:`);
  
  analysis.orchestrationPlan.steps.forEach((step, i) => {
    console.log(`      ${i + 1}. ${step.type}: ${step.description}`);
    if (step.query) {
      console.log(`         Query: "${step.query}"`);
    }
    if (step.queries) {
      console.log(`         Queries: [${step.queries.join('", "')}]`);
    }
  });
  
  console.log("\n✅ Plan generation working correctly!");
  
} catch (error) {
  console.log(`💥 Plan generation error: ${error.message}`);
}

console.log("\n🏁 Phase 1 Test Suite Complete!");
console.log("\n📝 Next Steps:");
console.log("   1. Test the orchestrator_query MCP tool with Claude Code");
console.log("   2. Validate multi-step orchestration with real queries");
console.log("   3. Verify response template formatting");
console.log("   4. Measure performance impact");
console.log("   5. Test fallback mechanisms");
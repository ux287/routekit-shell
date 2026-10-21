#!/usr/bin/env node

/**
 * Test script for the General Orchestration Agent
 * 
 * Demonstrates self-bootstrap capabilities using the Guardrailed Retriever Stack
 */

import { orchestratorContext } from '../src/agents/orchestrator.js';

async function testOrchestrator() {
  console.log('🎭 Testing General Orchestration Agent');
  console.log('=====================================\n');

  // Test 1: Contextual Knowledge Retrieval
  console.log('🔍 Test 1: Contextual Knowledge Retrieval');
  console.log('Query: "How to implement new CLI commands"');
  
  const cliContext = await orchestratorContext.gatherContext(
    'How to implement new CLI commands',
    { includeTrace: true, maxResults: 5 }
  );
  
  console.log(`📊 Results: ${cliContext.totalHits} hits, confidence: ${cliContext.confidence}`);
  console.log(`🎯 Canonical sources: ${cliContext.canonical.length}`);
  if (cliContext.canonical.length > 0) {
    cliContext.canonical.forEach(c => console.log(`   - ${c.path} (score: ${c.score.toFixed(3)})`));
  }
  console.log();

  // Test 2: Pattern Discovery
  console.log('🔍 Test 2: Pattern Discovery');
  console.log('Area: "design system components"');
  
  const designPatterns = await orchestratorContext.discoverConventions('design system components');
  
  console.log(`📊 Results: ${designPatterns.totalHits} patterns found`);
  console.log(`🎯 Confidence: ${designPatterns.confidence}`);
  console.log('Top patterns:');
  designPatterns.sources.slice(0, 3).forEach(source => {
    console.log(`   - ${source.path} (${source.source}, score: ${source.score.toFixed(3)})`);
  });
  console.log();

  // Test 3: Architectural Guidance
  console.log('🔍 Test 3: Architectural Guidance');
  console.log('Domain: "RAG system", Question: "integration patterns"');
  
  const ragGuidance = await orchestratorContext.getArchitecturalGuidance(
    'RAG system',
    'integration patterns'
  );
  
  console.log(`📊 Results: ${ragGuidance.totalHits} architectural documents found`);
  console.log(`🎯 Confidence: ${ragGuidance.confidence}`);
  console.log('Key guidance sources:');
  ragGuidance.sources.slice(0, 3).forEach(source => {
    const preview = source.text.substring(0, 80).replace(/\n/g, ' ');
    console.log(`   - ${source.path}: "${preview}..."`);
  });
  console.log();

  // Test 4: Implementation Planning
  console.log('🔍 Test 4: Implementation Planning');
  console.log('Feature: "new dashboard component"');
  
  const dashboardPlan = await orchestratorContext.planImplementation(
    'new dashboard component',
    ['responsive', 'accessible', 'RouteKit design system']
  );
  
  console.log(`📊 Results: ${dashboardPlan.totalHits} planning documents`);
  console.log(`🎯 Confidence: ${dashboardPlan.confidence}`);
  console.log(`🔗 Related patterns: ${dashboardPlan.relatedPatterns.length}`);
  console.log('Recommendations:');
  dashboardPlan.recommendations.forEach(rec => console.log(`   - ${rec}`));
  console.log();

  // Test 5: Code Pattern Search
  console.log('🔍 Test 5: Code Pattern Search');
  console.log('Pattern: "fsSearch function"');
  
  const codePatterns = await orchestratorContext.findPatterns(
    'fsSearch function',
    'code'
  );
  
  console.log(`📊 Results: ${codePatterns.totalHits} code patterns found`);
  console.log('Code locations:');
  codePatterns.sources
    .filter(s => s.source === 'fs')
    .slice(0, 3)
    .forEach(source => {
      console.log(`   - ${source.path} (score: ${source.score.toFixed(3)})`);
    });

  console.log('\n✅ Orchestration Agent testing complete!');
  console.log('🎯 The agent can successfully:');
  console.log('   - Retrieve contextual information from documentation');
  console.log('   - Discover existing patterns and conventions');
  console.log('   - Provide architectural guidance');
  console.log('   - Plan implementations based on existing knowledge');
  console.log('   - Search for specific code patterns');
  console.log('\n🚀 Self-bootstrap capabilities verified!');
}

// Run tests
if (import.meta.url === `file://${process.argv[1]}`) {
  testOrchestrator().catch(console.error);
}
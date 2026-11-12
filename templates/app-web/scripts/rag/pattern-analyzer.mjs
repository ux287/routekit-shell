#!/usr/bin/env node

/**
 * Pattern Analyzer for Guardrailed Retriever Stack Learning System
 * 
 * Analyzes query logs to identify patterns in tool usage, routing decisions,
 * and context quality to optimize future interactions.
 */

import fs from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

// Learning system paths
const LEARNING_BASE_PATH = join(homedir(), '.routekit', 'learning');
const QUERY_LOGS_PATH = join(LEARNING_BASE_PATH, 'query-logs');
const PATTERNS_PATH = join(LEARNING_BASE_PATH, 'patterns');

/**
 * Load all query logs
 */
async function loadAllQueries() {
  try {
    const files = await fs.readdir(QUERY_LOGS_PATH);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
    
    let allQueries = [];
    for (const file of jsonlFiles) {
      try {
        const content = await fs.readFile(join(QUERY_LOGS_PATH, file), 'utf8');
        const queries = content.trim().split('\n')
          .filter(line => line.trim())
          .map(line => JSON.parse(line));
        allQueries.push(...queries);
      } catch (error) {
        console.error(`⚠️ Error reading ${file}:`, error.message);
      }
    }
    
    return allQueries.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  } catch (error) {
    console.error('❌ Failed to load queries:', error.message);
    return [];
  }
}

/**
 * Analyze tool sequence patterns
 */
function analyzeToolSequences(queries) {
  const sequences = new Map();
  const transitions = new Map();
  
  for (const query of queries) {
    if (!query.toolSequence || query.toolSequence.length === 0) continue;
    
    // Track complete sequences
    const sequence = query.toolSequence.map(t => t.tool).join(' → ');
    const current = sequences.get(sequence) || { count: 0, queries: [], avgQuality: 0 };
    current.count++;
    current.queries.push(query.query);
    current.avgQuality = (current.avgQuality * (current.count - 1) + getQualityScore(query.contextQuality)) / current.count;
    sequences.set(sequence, current);
    
    // Track tool transitions
    for (let i = 0; i < query.toolSequence.length - 1; i++) {
      const from = query.toolSequence[i].tool;
      const to = query.toolSequence[i + 1].tool;
      const transition = `${from} → ${to}`;
      
      const transitionData = transitions.get(transition) || { count: 0, contexts: new Set() };
      transitionData.count++;
      transitionData.contexts.add(query.routingReason);
      transitions.set(transition, transitionData);
    }
  }
  
  return {
    sequences: Array.from(sequences.entries())
      .map(([seq, data]) => ({ sequence: seq, ...data }))
      .sort((a, b) => b.count - a.count),
    transitions: Array.from(transitions.entries())
      .map(([trans, data]) => ({ 
        transition: trans, 
        count: data.count, 
        contexts: Array.from(data.contexts) 
      }))
      .sort((a, b) => b.count - a.count)
  };
}

/**
 * Analyze routing patterns
 */
function analyzeRoutingPatterns(queries) {
  const routingReasons = new Map();
  const queryTypes = new Map();
  
  for (const query of queries) {
    // Routing reason patterns
    const reason = query.routingReason || 'unknown';
    const reasonData = routingReasons.get(reason) || {
      count: 0,
      tools: new Map(),
      quality: { high: 0, medium: 0, low: 0 },
      avgDuration: 0
    };
    
    reasonData.count++;
    reasonData.quality[query.contextQuality] = (reasonData.quality[query.contextQuality] || 0) + 1;
    
    // Track tool usage by routing reason
    for (const tool of query.toolSequence || []) {
      const toolCount = reasonData.tools.get(tool.tool) || 0;
      reasonData.tools.set(tool.tool, toolCount + 1);
    }
    
    routingReasons.set(reason, reasonData);
    
    // Query type classification
    const queryType = classifyQuery(query.query);
    const typeData = queryTypes.get(queryType) || { count: 0, examples: [] };
    typeData.count++;
    if (typeData.examples.length < 5) {
      typeData.examples.push(query.query);
    }
    queryTypes.set(queryType, typeData);
  }
  
  return {
    routingReasons: Array.from(routingReasons.entries())
      .map(([reason, data]) => ({
        reason,
        count: data.count,
        topTools: Array.from(data.tools.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([tool, count]) => ({ tool, count })),
        qualityDistribution: data.quality,
        successRate: ((data.quality.high || 0) + (data.quality.medium || 0)) / data.count
      }))
      .sort((a, b) => b.count - a.count),
    queryTypes: Array.from(queryTypes.entries())
      .map(([type, data]) => ({ type, ...data }))
      .sort((a, b) => b.count - a.count)
  };
}

/**
 * Analyze cross-project patterns
 */
function analyzeCrossProjectPatterns(queries) {
  const projectPatterns = new Map();
  
  for (const query of queries) {
    const project = query.projectContext || 'unknown';
    const projectData = projectPatterns.get(project) || {
      count: 0,
      commonTools: new Map(),
      routingReasons: new Map(),
      avgToolsPerQuery: 0
    };
    
    projectData.count++;
    
    for (const tool of query.toolSequence || []) {
      const toolCount = projectData.commonTools.get(tool.tool) || 0;
      projectData.commonTools.set(tool.tool, toolCount + 1);
    }
    
    const reason = query.routingReason || 'unknown';
    projectData.routingReasons.set(reason, (projectData.routingReasons.get(reason) || 0) + 1);
    
    const toolCount = query.toolSequence?.length || 0;
    projectData.avgToolsPerQuery = (projectData.avgToolsPerQuery * (projectData.count - 1) + toolCount) / projectData.count;
    
    projectPatterns.set(project, projectData);
  }
  
  return Array.from(projectPatterns.entries())
    .map(([project, data]) => ({
      project,
      count: data.count,
      avgToolsPerQuery: Math.round(data.avgToolsPerQuery * 100) / 100,
      topTools: Array.from(data.commonTools.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([tool, count]) => ({ tool, count })),
      topReasons: Array.from(data.routingReasons.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([reason, count]) => ({ reason, count }))
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Generate optimization recommendations
 */
function generateRecommendations(patterns) {
  const recommendations = [];
  
  // Tool sequence optimization
  const highSuccessSequences = patterns.toolSequences.sequences
    .filter(seq => seq.avgQuality > 0.8 && seq.count >= 3);
    
  if (highSuccessSequences.length > 0) {
    recommendations.push({
      type: 'tool_templates',
      priority: 'high',
      description: 'Create templates for successful tool sequences',
      data: highSuccessSequences.slice(0, 5)
    });
  }
  
  // Context pre-loading opportunities
  const commonTransitions = patterns.toolSequences.transitions
    .filter(t => t.count >= 3);
    
  if (commonTransitions.length > 0) {
    recommendations.push({
      type: 'preload_opportunities',
      priority: 'medium',
      description: 'Pre-load context for common tool transitions',
      data: commonTransitions.slice(0, 5)
    });
  }
  
  // Cross-project learning
  const crossProjectTools = new Map();
  for (const project of patterns.crossProject) {
    for (const tool of project.topTools) {
      const current = crossProjectTools.get(tool.tool) || { projects: new Set(), totalCount: 0 };
      current.projects.add(project.project);
      current.totalCount += tool.count;
      crossProjectTools.set(tool.tool, current);
    }
  }
  
  const universalTools = Array.from(crossProjectTools.entries())
    .filter(([tool, data]) => data.projects.size >= 2)
    .sort((a, b) => b[1].totalCount - a[1].totalCount);
    
  if (universalTools.length > 0) {
    recommendations.push({
      type: 'universal_patterns',
      priority: 'high',
      description: 'Tools used consistently across projects',
      data: universalTools.slice(0, 5).map(([tool, data]) => ({
        tool,
        projects: Array.from(data.projects),
        totalUsage: data.totalCount
      }))
    });
  }
  
  return recommendations;
}

/**
 * Helper functions
 */
function getQualityScore(quality) {
  switch (quality) {
    case 'high': return 1.0;
    case 'medium': return 0.6;
    case 'low': return 0.2;
    default: return 0.4;
  }
}

function classifyQuery(query) {
  const lower = query.toLowerCase();
  
  if (lower.includes('how do') || lower.includes('how to')) return 'how_to';
  if (lower.includes('what is') || lower.includes('what are')) return 'definition';
  if (lower.includes('configure') || lower.includes('setup')) return 'configuration';
  if (lower.includes('error') || lower.includes('failed') || lower.includes('broken')) return 'troubleshooting';
  if (lower.includes('blog') || lower.includes('publish')) return 'content_management';
  if (lower.includes('implement') || lower.includes('create')) return 'implementation';
  
  return 'general';
}

/**
 * Save patterns to files
 */
async function savePatterns(patterns, recommendations) {
  try {
    await fs.writeFile(
      join(PATTERNS_PATH, 'tool-sequences.json'),
      JSON.stringify(patterns.toolSequences, null, 2),
      'utf8'
    );
    
    await fs.writeFile(
      join(PATTERNS_PATH, 'routing-rules.json'),
      JSON.stringify(patterns.routing, null, 2),
      'utf8'
    );
    
    await fs.writeFile(
      join(PATTERNS_PATH, 'cross-project-patterns.json'),
      JSON.stringify(patterns.crossProject, null, 2),
      'utf8'
    );
    
    await fs.writeFile(
      join(PATTERNS_PATH, 'optimization-recommendations.json'),
      JSON.stringify(recommendations, null, 2),
      'utf8'
    );
    
    console.log('💾 Patterns saved to ~/.routekit/learning/patterns/');
  } catch (error) {
    console.error('❌ Failed to save patterns:', error.message);
  }
}

/**
 * Main analysis function
 */
export async function analyzePatterns() {
  console.log('🔍 Analyzing query patterns...');
  
  const queries = await loadAllQueries();
  
  if (queries.length === 0) {
    console.log('📊 No queries found to analyze');
    return null;
  }
  
  console.log(`📊 Analyzing ${queries.length} queries...`);
  
  const patterns = {
    toolSequences: analyzeToolSequences(queries),
    routing: analyzeRoutingPatterns(queries),
    crossProject: analyzeCrossProjectPatterns(queries)
  };
  
  const recommendations = generateRecommendations(patterns);
  
  await savePatterns(patterns, recommendations);
  
  return { patterns, recommendations };
}

/**
 * CLI interface
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2];
  
  if (command === 'analyze' || !command) {
    const result = await analyzePatterns();
    
    if (result) {
      const { patterns, recommendations } = result;
      
      console.log('\n📈 Analysis Results:\n');
      
      console.log('🔧 Top Tool Sequences:');
      patterns.toolSequences.sequences.slice(0, 5).forEach((seq, i) => {
        console.log(`${i + 1}. ${seq.sequence} (${seq.count}x, quality: ${seq.avgQuality.toFixed(2)})`);
      });
      
      console.log('\n🎯 Routing Patterns:');
      patterns.routing.routingReasons.slice(0, 5).forEach((reason, i) => {
        console.log(`${i + 1}. ${reason.reason}: ${reason.count} queries (${(reason.successRate * 100).toFixed(1)}% success)`);
      });
      
      console.log('\n🌐 Cross-Project Usage:');
      patterns.crossProject.forEach((project, i) => {
        console.log(`${i + 1}. ${project.project}: ${project.count} queries, avg ${project.avgToolsPerQuery} tools/query`);
      });
      
      console.log('\n💡 Recommendations:');
      recommendations.slice(0, 3).forEach((rec, i) => {
        console.log(`${i + 1}. [${rec.priority.toUpperCase()}] ${rec.description}`);
      });
      
    }
    
  } else {
    console.log(`
Usage:
  node pattern-analyzer.mjs [analyze]  # Analyze all query logs
    `);
  }
}
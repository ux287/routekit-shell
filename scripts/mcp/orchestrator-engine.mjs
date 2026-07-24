/**
 * Orchestrator Core Engine
 * Provides intelligent query coordination and multi-step orchestration
 */

import { retrieveWithRouting } from "../../src/router.js";
import { formatRoutingResponse, getConfidenceLevel } from "./response-formatter.mjs";
import { 
  validateResponseGrounding, 
  createUncertaintyResponse,
  CONFIDENCE_THRESHOLDS 
} from "./response-validator.mjs";
import { 
  loadFallbackPerformance, 
  updateFallbackPerformance 
} from "./learning-storage.mjs";
import { classifyQueryForLearning } from "./learning-engine.mjs";
import { appendLearningPattern, queryLearningPatterns } from "./dendron-learning.mjs";

/**
 * Query types for classification
 */
export const QUERY_TYPES = {
  FACTUAL: "factual",           // "What is X?" → Direct retrieval
  IMPLEMENTATION: "implementation", // "How do I implement Y?" → Multi-step guidance
  COMPARATIVE: "comparative",    // "Compare A vs B" → Parallel retrieval + synthesis
  ARCHITECTURAL: "architectural", // "Best approach for Z?" → Analysis + recommendation
  DISCOVERY: "discovery"         // "What options exist for W?" → Comprehensive search
};

/**
 * Response formats for different query types
 */
export const RESPONSE_FORMATS = {
  GUIDANCE: "guidance",         // Step-by-step implementation guidance
  COMPARISON: "comparison",     // Structured A vs B analysis
  IMPLEMENTATION: "implementation", // Complete implementation walkthrough
  REFERENCE: "reference"        // Comprehensive reference with examples
};

/**
 * Orchestration complexity levels
 */
export const COMPLEXITY_LEVELS = {
  SIMPLE: "simple",             // Direct routing, single source
  MULTI_STEP: "multi-step",     // Sequential queries with context building
  COMPREHENSIVE: "comprehensive" // Full orchestration with synthesis
};

/**
 * Analyze query to determine classification and orchestration plan
 * Enhanced with self-querying learning system
 * @param {string} query - User query to analyze
 * @param {string} context - Additional context about current task/domain
 * @param {Object} routingConfig - Routing configuration for self-querying
 * @returns {Object} Analysis result with type, complexity, and orchestration plan
 */
export async function analyzeQuery(query, context = "", routingConfig = null) {
  // Ensure both parameters are strings to prevent undefined errors
  const safeQuery = query || "";
  const safeContext = context || "";
  const combined = (safeQuery + " " + safeContext).toString().toLowerCase();
  
  // Query type classification
  let queryType = QUERY_TYPES.FACTUAL; // default
  let complexity = COMPLEXITY_LEVELS.SIMPLE; // default
  let format = RESPONSE_FORMATS.GUIDANCE; // default

  // Strategic decision patterns (check first - highest priority)
  if (combined.match(/(should\s+we\s+(prioritize|focus|implement)|roadmap|priority|strategic|decision|continue\s+with|move\s+forward|next\s+step)/i)) {
    queryType = QUERY_TYPES.ARCHITECTURAL;
    complexity = COMPLEXITY_LEVELS.COMPREHENSIVE;
    format = RESPONSE_FORMATS.GUIDANCE;
  }

  // Implementation patterns
  else if (combined.match(/how\s+(do|can|to)\s+i?\s*(implement|build|create|add|setup|configure)/i)) {
    queryType = QUERY_TYPES.IMPLEMENTATION;
    complexity = COMPLEXITY_LEVELS.MULTI_STEP;
    format = RESPONSE_FORMATS.IMPLEMENTATION;
  }

  // Meta-system patterns (questions about the system itself)
  else if (combined.match(/(use\s+the\s+system|how\s+(does|do)\s+(rag|orchestrator|system)\s+work|interact\s+with|preface\s+prompts|command)/i)) {
    queryType = QUERY_TYPES.ARCHITECTURAL;
    complexity = COMPLEXITY_LEVELS.MULTI_STEP;
    format = RESPONSE_FORMATS.GUIDANCE;
  }

  // Architectural/best practice patterns
  else if (combined.match(/(best\s+(approach|practice|way|method)|recommended|should\s+i|architecture|pattern)/i)) {
    queryType = QUERY_TYPES.ARCHITECTURAL;
    complexity = COMPLEXITY_LEVELS.MULTI_STEP;
    format = RESPONSE_FORMATS.GUIDANCE;
  }

  // Comparative patterns
  else if (combined.match(/(compare|versus|vs\.?|difference between|better(?!\s+(approach|practice|way|method)))/i)) {
    queryType = QUERY_TYPES.COMPARATIVE;
    complexity = COMPLEXITY_LEVELS.MULTI_STEP;
    format = RESPONSE_FORMATS.COMPARISON;
  }

  // Discovery patterns
  else if (combined.match(/(what\s+(are|options|choices|alternatives)|show\s+me\s+all|list\s+(all|available))/i)) {
    queryType = QUERY_TYPES.DISCOVERY;
    complexity = COMPLEXITY_LEVELS.COMPREHENSIVE;
    format = RESPONSE_FORMATS.REFERENCE;
  }

  // Multi-domain/complex indicators
  const complexityIndicators = [
    /multiple|several|various|different|across/i,
    /integrate|coordination|workflow|process/i,
    /end.to.end|complete|comprehensive|full/i
  ];

  if (complexityIndicators.some(pattern => pattern.test(combined))) {
    complexity = COMPLEXITY_LEVELS.COMPREHENSIVE;
  }

  const baseAnalysis = {
    query: query.trim(),
    context: context.trim(),
    classification: {
      type: queryType,
      complexity,
      format
    },
    orchestrationPlan: createOrchestrationPlan(queryType, complexity, query, context)
  };
  
  // Self-query learning patterns if routing config available
  if (routingConfig) {
    try {
      console.log(`🧠 Self-querying learning patterns for ${queryType}`);
      const learningAnalysis = await queryLearningPatterns(queryType, routingConfig);
      
      if (learningAnalysis.success && learningAnalysis.recommendations.length > 0) {
        console.log(`📈 Applied ${learningAnalysis.recommendations.length} learning recommendations`);
        
        // Apply learning insights to routing plan
        baseAnalysis.learningEnhanced = true;
        baseAnalysis.learningInsights = learningAnalysis.insights;
        baseAnalysis.routingRecommendations = learningAnalysis.recommendations;
        
        // Apply pattern-based routing optimization
        const routingOptimization = applyPatternBasedOptimization(
          baseAnalysis.orchestrationPlan, 
          learningAnalysis.insights, 
          queryType
        );
        
        if (routingOptimization.optimized) {
          baseAnalysis.orchestrationPlan = routingOptimization.optimizedPlan;
          baseAnalysis.routingOptimized = true;
          baseAnalysis.optimizationReason = routingOptimization.reason;
          console.log(`🎯 Applied routing optimization: ${routingOptimization.reason}`);
        }
        
        // Adjust confidence thresholds based on learning
        if (learningAnalysis.insights.some(i => i.type === "confidence_calibration")) {
          baseAnalysis.confidenceCalibrated = true;
        }
      }
    } catch (error) {
      console.warn("Self-querying learning patterns failed:", error.message);
      // Continue with base analysis
    }
  }
  
  return baseAnalysis;
}

/**
 * Create orchestration plan based on query analysis
 * @param {string} queryType - Classified query type
 * @param {string} complexity - Complexity level
 * @param {string} query - Original query
 * @param {string} context - Additional context
 * @returns {Object} Orchestration plan with steps
 */
function createOrchestrationPlan(queryType, complexity, query, context) {
  const plan = {
    steps: [],
    requiresOrchestration: complexity !== COMPLEXITY_LEVELS.SIMPLE,
    estimatedQueries: 1
  };

  if (!plan.requiresOrchestration) {
    plan.steps.push({
      type: "direct_retrieval",
      query: query,
      description: "Direct retrieval for simple query"
    });
    return plan;
  }

  // Multi-step orchestration plans
  switch (queryType) {
    case QUERY_TYPES.IMPLEMENTATION:
      plan.steps = [
        {
          type: "pattern_search",
          query: extractPatternQuery(query),
          description: "Search for existing patterns and examples"
        },
        {
          type: "implementation_search", 
          query: query,
          description: "Find specific implementation guidance"
        },
        {
          type: "synthesis",
          description: "Combine patterns with implementation steps"
        }
      ];
      plan.estimatedQueries = 2;
      break;

    case QUERY_TYPES.COMPARATIVE:
      const terms = extractComparisonTerms(query);
      plan.steps = [
        {
          type: "parallel_search",
          queries: terms.map(term => `${term} ${context}`.trim()),
          description: `Search for information about each: ${terms.join(", ")}`
        },
        {
          type: "comparison_synthesis",
          description: "Compare and contrast the retrieved information"
        }
      ];
      plan.estimatedQueries = terms.length;
      break;

    case QUERY_TYPES.ARCHITECTURAL:
      plan.steps = [
        {
          type: "architecture_search",
          query: `architecture patterns ${extractDomain(query, context)}`,
          description: "Search for architectural patterns and best practices"
        },
        {
          type: "implementation_examples",
          query: query,
          description: "Find implementation examples"
        },
        {
          type: "recommendation_synthesis",
          description: "Generate contextualized recommendations"
        }
      ];
      plan.estimatedQueries = 2;
      break;

    case QUERY_TYPES.DISCOVERY:
      plan.steps = [
        {
          type: "comprehensive_search",
          query: query,
          description: "Comprehensive search across all domains"
        },
        {
          type: "categorization",
          description: "Organize and categorize findings"
        }
      ];
      plan.estimatedQueries = 1;
      break;

    default:
      // Fallback to direct retrieval
      plan.requiresOrchestration = false;
      plan.steps.push({
        type: "direct_retrieval",
        query: query,
        description: "Direct retrieval for unclassified query"
      });
  }

  return plan;
}

/**
 * Determine if query should be orchestrated
 * @param {string} query - User query
 * @param {string} context - Additional context
 * @returns {boolean} Whether orchestration would add value
 */
export async function shouldOrchestrate(query, context = "", routingConfig = null) {
  const analysis = await analyzeQuery(query, context, routingConfig);
  
  // Don't orchestrate simple factual queries
  if (analysis.classification.complexity === COMPLEXITY_LEVELS.SIMPLE) {
    return false;
  }

  // Don't orchestrate very short queries (likely simple)
  if (query.trim().split(/\s+/).length < 4) {
    return false;
  }

  return analysis.orchestrationPlan.requiresOrchestration;
}

/**
 * Execute orchestration plan
 * @param {Object} plan - Orchestration plan from analyzeQuery
 * @param {Object} routingConfig - Routing configuration
 * @returns {Object} Orchestration results with all retrieved information
 */
export async function executeOrchestration(plan, routingConfig) {
  const results = {
    steps: [],
    allPassages: [],
    traces: [],
    metadata: {
      totalQueries: 0,
      startTime: Date.now()
    }
  };

  for (const step of plan.steps) {
    const stepResult = await executeStep(step, routingConfig);
    results.steps.push(stepResult);
    
    if (stepResult.passages) {
      results.allPassages.push(...stepResult.passages);
      results.traces.push(stepResult.trace);
      results.metadata.totalQueries++;
    }
  }

  results.metadata.endTime = Date.now();
  results.metadata.duration = results.metadata.endTime - results.metadata.startTime;

  return results;
}

/**
 * Execute individual orchestration step
 * @param {Object} step - Step configuration
 * @param {Object} routingConfig - Routing configuration
 * @returns {Object} Step execution result
 */
async function executeStep(step, routingConfig) {
  const result = {
    type: step.type,
    description: step.description,
    passages: [],
    trace: null,
    success: true
  };

  try {
    switch (step.type) {
      case "direct_retrieval":
      case "pattern_search":
      case "implementation_search":
      case "architecture_search":
      case "implementation_examples":
      case "comprehensive_search":
        const retrieved = await retrieveWithRouting(step.query, routingConfig);
        result.passages = retrieved.passages;
        result.trace = retrieved.TRACE;
        break;

      case "parallel_search":
        const parallelResults = await Promise.all(
          step.queries.map(q => retrieveWithRouting(q, routingConfig))
        );
        result.passages = parallelResults.flatMap(r => r.passages);
        result.trace = parallelResults.map(r => r.TRACE).join("; ");
        break;

      case "synthesis":
      case "comparison_synthesis":
      case "recommendation_synthesis":
      case "categorization":
        // These are handled in the response synthesis phase
        result.passages = [];
        result.trace = `ORCHESTRATOR synthesis_step=${step.type}`;
        break;

      default:
        throw new Error(`Unknown step type: ${step.type}`);
    }
  } catch (error) {
    result.success = false;
    result.error = error.message;
    result.trace = `ORCHESTRATOR error=${error.message}`;
  }

  return result;
}

/**
 * Synthesize orchestrated response
 * @param {Object} results - Results from executeOrchestration
 * @param {string} format - Desired response format
 * @param {Object} originalQuery - Original query analysis
 * @returns {Object} Synthesized response
 */
export function synthesizeResponse(results, format, originalQuery) {
  // For Phase 1, use enhanced version of existing formatter
  const allPassages = results.allPassages;
  const combinedTrace = results.traces.join("; ");
  
  // Generate base response using existing formatter
  const baseResponse = formatRoutingResponse(allPassages, combinedTrace);
  
  // Enhance with orchestration context
  const orchestrationEnhancement = generateOrchestrationEnhancement(
    results, 
    format, 
    originalQuery
  );

  return {
    ...baseResponse,
    orchestration: {
      steps: results.steps.length,
      queries: results.metadata.totalQueries,
      duration: results.metadata.duration,
      enhancement: orchestrationEnhancement
    }
  };
}

/**
 * Generate orchestration-specific enhancements
 * @param {Object} results - Orchestration results
 * @param {string} format - Response format
 * @param {Object} originalQuery - Original query analysis
 * @returns {string} Enhancement text
 */
function generateOrchestrationEnhancement(results, format, originalQuery) {
  const successful_steps = results.steps.filter(s => s.success).length;
  const total_steps = results.steps.length;
  
  let enhancement = `\n\n## Orchestration Summary\n\n`;
  enhancement += `**Query Type**: ${originalQuery.classification.type}\n`;
  enhancement += `**Complexity**: ${originalQuery.classification.complexity}\n`;  
  enhancement += `**Steps Completed**: ${successful_steps}/${total_steps}\n`;
  enhancement += `**Total Queries**: ${results.metadata.totalQueries}\n`;
  enhancement += `**Processing Time**: ${results.metadata.duration}ms\n`;

  if (results.steps.some(s => !s.success)) {
    enhancement += `\n**Note**: Some orchestration steps encountered issues but core results were retrieved successfully.\n`;
  }

  return enhancement;
}

// Utility functions for query analysis

function extractPatternQuery(query) {
  // Extract domain/feature from implementation query
  const match = query.match(/implement\s+(\w+(?:\s+\w+)*)/i);
  return match ? `${match[1]} pattern examples` : `${query} patterns`;
}

function extractComparisonTerms(query) {
  // Extract terms being compared
  const vsMatch = query.match(/(.+?)\s+(?:vs\.?|versus|compared?\s+to)\s+(.+)/i);
  if (vsMatch) {
    return [vsMatch[1].trim(), vsMatch[2].trim()];
  }
  
  const betweenMatch = query.match(/(?:difference|compare)\s+between\s+(.+?)\s+and\s+(.+)/i);
  if (betweenMatch) {
    return [betweenMatch[1].trim(), betweenMatch[2].trim()];
  }

  // Fallback: split on common separators
  return query.split(/\s+(?:and|or|vs\.?|versus)\s+/i).map(t => t.trim());
}

function extractDomain(query, context) {
  // Extract domain context from query and context
  const domains = ["CLI", "design system", "templates", "backend", "frontend"];
  const safeQuery = query || "";
  const safeContext = context || "";
  const combined = (safeQuery + " " + safeContext).toString().toLowerCase();
  
  for (const domain of domains) {
    if (combined.includes(domain.toLowerCase())) {
      return domain;
    }
  }
  
  return "application";
}

/**
 * Apply pattern-based routing optimization using learning insights
 * @param {Object} orchestrationPlan - Original orchestration plan
 * @param {Array} learningInsights - Insights from learning patterns
 * @param {string} queryType - Type of query being processed
 * @returns {Object} Optimization result with optimized plan if applicable
 */
function applyPatternBasedOptimization(orchestrationPlan, learningInsights, queryType) {
  if (!learningInsights || learningInsights.length === 0) {
    return { optimized: false, reason: "No learning insights available" };
  }
  
  const successfulPatterns = learningInsights.filter(i => i.type === "successful_pattern");
  const errorLearnings = learningInsights.filter(i => i.type === "error_learning");
  
  // Check for high-confidence routing patterns
  const highConfidenceRoutes = successfulPatterns
    .filter(p => p.confidence >= 0.8)
    .reduce((acc, pattern) => {
      const route = pattern.route;
      if (!acc[route]) acc[route] = [];
      acc[route].push(pattern);
      return acc;
    }, {});
  
  // If we have a strongly preferred route for this query type, optimize toward it
  const bestRoute = Object.entries(highConfidenceRoutes)
    .sort(([,a], [,b]) => b.length - a.length)[0];
  
  if (bestRoute && bestRoute[1].length >= 2) { // At least 2 successful patterns
    const [routeName, patterns] = bestRoute;
    const avgConfidence = patterns.reduce((sum, p) => sum + p.confidence, 0) / patterns.length;
    
    // Optimize orchestration plan based on successful route
    const optimizedPlan = { ...orchestrationPlan };
    
    if (routeName === "direct_retrieval" && orchestrationPlan.requiresOrchestration) {
      // Learning suggests direct retrieval works better for this type
      optimizedPlan.requiresOrchestration = false;
      optimizedPlan.steps = [{
        type: "direct_retrieval",
        query: orchestrationPlan.steps[0]?.query || "direct query",
        description: "Direct retrieval based on successful learning patterns"
      }];
      optimizedPlan.estimatedQueries = 1;
      
      return {
        optimized: true,
        optimizedPlan,
        reason: `Direct retrieval preferred (${patterns.length} successful patterns, ${avgConfidence.toFixed(2)} avg confidence)`
      };
    }
    
    if (routeName === "orchestrator_query" && !orchestrationPlan.requiresOrchestration) {
      // Learning suggests orchestration works better
      optimizedPlan.requiresOrchestration = true;
      optimizedPlan.steps = createOrchestrationPlan(queryType, COMPLEXITY_LEVELS.MULTI_STEP, "enhanced by learning", "").steps;
      
      return {
        optimized: true,
        optimizedPlan,
        reason: `Orchestration preferred (${patterns.length} successful patterns, ${avgConfidence.toFixed(2)} avg confidence)`
      };
    }
  }
  
  // Apply error prevention strategies
  if (errorLearnings.length > 0) {
    const optimizedPlan = { ...orchestrationPlan };
    let applied = false;
    
    // Add error prevention steps based on learnings
    for (const errorLearning of errorLearnings) {
      if (errorLearning.prevention && errorLearning.prevention.includes("validation")) {
        // Add validation step if not present
        const hasValidation = optimizedPlan.steps.some(s => s.type.includes("validation"));
        if (!hasValidation) {
          optimizedPlan.steps.push({
            type: "confidence_validation",
            description: "Added validation based on error learning patterns"
          });
          applied = true;
        }
      }
    }
    
    if (applied) {
      return {
        optimized: true,
        optimizedPlan,
        reason: `Added error prevention steps (${errorLearnings.length} error patterns analyzed)`
      };
    }
  }
  
  return { 
    optimized: false, 
    reason: "No applicable optimizations found from learning patterns" 
  };
}

// Phase 3: Fallback Mechanisms

/**
 * Handle low confidence responses with fallback strategies
 * @param {string} query - Original query
 * @param {number} confidence - Confidence score (0-1)
 * @param {string} context - Additional context
 * @param {Object} routingConfig - Routing configuration
 * @returns {Object} Fallback response or uncertainty response
 */
export async function handleLowConfidenceResponse(query, confidence, context, routingConfig) {
  console.log(`🔄 Low confidence (${confidence.toFixed(2)}) - attempting fallback strategies`);
  
  if (confidence < CONFIDENCE_THRESHOLDS.CRITICAL) {
    // Critical failure - throw error to trigger router escalation
    const error = new Error('Critical confidence failure - escalation needed');
    error.confidence = confidence;
    error.needsEscalation = true;
    throw error;
  }
  
  if (confidence < CONFIDENCE_THRESHOLDS.LOW) {
    // Try alternative search strategies
    const fallbackResult = await tryFallbackSearch(query, context, routingConfig);
    
    if (fallbackResult.confidence > CONFIDENCE_THRESHOLDS.MEDIUM) {
      console.log(`✅ Fallback search improved confidence: ${confidence.toFixed(2)} → ${fallbackResult.confidence.toFixed(2)}`);
      return fallbackResult;
    }
    
    // Fallback didn't help - return honest uncertainty
    return {
      content: createUncertaintyResponse(query, context),
      metadata: {
        fallbackStrategy: "uncertainty_after_fallback",
        originalConfidence: confidence,
        fallbackConfidence: fallbackResult.confidence,
        reason: "fallback_search_insufficient"
      }
    };
  }
  
  // Confidence is low but not critical - return with uncertainty indicators
  return null; // Let the normal response flow handle this
}

/**
 * Phase 4: Get adaptive fallback strategy order based on learning
 * @param {string} query - Query to get strategies for
 * @param {string} context - Additional context
 * @returns {Array} Ordered strategies based on learned performance
 */
function getAdaptiveFallbackStrategies(query, context) {
  const strategyFunctions = [
    { name: "broader_semantic", fn: broaderSemanticSearch },
    { name: "keyword_based", fn: keywordBasedSearch },
    { name: "domain_specific", fn: domainSpecificSearch }
  ];
  
  try {
    const queryType = classifyQueryForLearning(query);
    const { strategies } = loadFallbackPerformance();
    
    // Sort strategies by effectiveness for this query type
    const sortedStrategies = strategyFunctions.sort((a, b) => {
      const aPerf = strategies[a.name];
      const bPerf = strategies[b.name];
      
      if (!aPerf && !bPerf) return 0;
      if (!aPerf) return 1;
      if (!bPerf) return -1;
      
      // Check if query type is in best query types for each strategy
      const aIsGoodForType = aPerf.bestQueryTypes?.includes(queryType) ? 1.5 : 1.0;
      const bIsGoodForType = bPerf.bestQueryTypes?.includes(queryType) ? 1.5 : 1.0;
      
      // Calculate effectiveness score
      const aScore = (aPerf.avgImprovement * aIsGoodForType) * (aPerf.successfulImprovements / Math.max(aPerf.totalAttempts, 1));
      const bScore = (bPerf.avgImprovement * bIsGoodForType) * (bPerf.successfulImprovements / Math.max(bPerf.totalAttempts, 1));
      
      return bScore - aScore;
    });
    
    console.error(`🧠 Adaptive fallback order for ${queryType}:`, sortedStrategies.map(s => s.name).join(" → "));
    return sortedStrategies;
    
  } catch (error) {
    console.error('Failed to load adaptive fallback strategies:', error.message);
    return strategyFunctions; // Fallback to default order
  }
}

/**
 * Try alternative search strategies for failed queries (Phase 4: Adaptive)
 * @param {string} query - Original query
 * @param {string} context - Additional context
 * @param {Object} routingConfig - Routing configuration
 * @returns {Object} Alternative search results with validation
 */
async function tryFallbackSearch(query, context, routingConfig) {
  const fallbackStrategies = getAdaptiveFallbackStrategies(query, context);
  const queryType = classifyQueryForLearning(query);
  
  for (const { name, fn } of fallbackStrategies) {
    try {
      console.log(`🔄 Trying adaptive fallback: ${name}`);
      const startTime = Date.now();
      const result = await fn(query, context, routingConfig);
      const duration = Date.now() - startTime;
      
      if (result.passages && result.passages.length > 0) {
        // Validate the fallback result
        const response = formatRoutingResponse(result.passages, result.TRACE);
        const validation = validateResponseGrounding(response.content, result.passages);
        
        // Record strategy performance for learning
        const improvement = validation.confidence; // Since original was low confidence
        const performance = {
          queryType,
          improvement,
          success: validation.confidence > CONFIDENCE_THRESHOLDS.MEDIUM,
          duration
        };
        
        // Async update performance (don't block response)
        updateFallbackPerformance(name, performance).catch(error => 
          console.error('Failed to update fallback performance:', error.message)
        );
        
        if (validation.confidence > CONFIDENCE_THRESHOLDS.MEDIUM) {
          console.log(`✅ Adaptive fallback ${name} succeeded: confidence ${validation.confidence.toFixed(2)}`);
          
          return {
            ...response,
            confidence: validation.confidence,
            metadata: {
              fallbackStrategy: name,
              validation,
              duration,
              wasAdaptive: true
            }
          };
        } else {
          console.log(`⚠️ Adaptive fallback ${name} low confidence: ${validation.confidence.toFixed(2)}`);
        }
      } else {
        // Record failed attempt
        const performance = {
          queryType,
          improvement: 0,
          success: false,
          duration
        };
        
        updateFallbackPerformance(name, performance).catch(error => 
          console.error('Failed to update fallback performance:', error.message)
        );
      }
      
    } catch (error) {
      console.log(`⚠️ Adaptive fallback strategy ${name} failed: ${error.message}`);
      
      // Record failed attempt
      const performance = {
        queryType,
        improvement: 0,
        success: false,
        duration: 0
      };
      
      updateFallbackPerformance(name, performance).catch(err => 
        console.error('Failed to update fallback performance:', err.message)
      );
    }
  }
  
  return {
    content: "",
    confidence: 0,
    metadata: {
      fallbackStrategy: "all_adaptive_strategies_failed",
      queriedStrategies: fallbackStrategies.map(s => s.name)
    }
  };
}

/**
 * Broader semantic search - remove specific terms, search more generally
 */
async function broaderSemanticSearch(query, _context, routingConfig) {
  // Remove specific implementation terms, focus on domain
  const broadQuery = query
    .replace(/\b(implement|build|create|setup|configure|how\s+to)\s+/gi, "")
    .replace(/\b(specific|exact|precise)\s+/gi, "")
    .trim();
  
  if (broadQuery !== query) {
    console.log(`🔍 Broader search: "${query}" → "${broadQuery}"`);
    const result = await retrieveWithRouting(broadQuery, routingConfig);
    return { ...result, strategy: "broader_semantic" };
  }
  
  return { passages: [], strategy: "broader_semantic_skipped" };
}

/**
 * Keyword-based search - extract key terms and search individually
 */
async function keywordBasedSearch(query, context, routingConfig) {
  const keywords = extractKeywords(query, context);
  
  if (keywords.length > 0) {
    const keywordQuery = keywords.join(" ");
    console.log(`🔑 Keyword search: [${keywords.join(", ")}]`);
    
    const result = await retrieveWithRouting(keywordQuery, routingConfig);
    return { ...result, strategy: "keyword_based" };
  }
  
  return { passages: [], strategy: "keyword_based_skipped" };
}

/**
 * Domain-specific search - search within likely domain
 */
async function domainSpecificSearch(query, context, routingConfig) {
  const domain = extractDomain(query, context);
  const domainQuery = `${domain} ${query}`;
  
  console.log(`🎯 Domain search: "${domainQuery}"`);
  const result = await retrieveWithRouting(domainQuery, routingConfig);
  return { ...result, strategy: "domain_specific" };
}

/**
 * Extract keywords from query for fallback search
 */
function extractKeywords(query, context) {
  const safeQuery = query || "";
  const safeContext = context || "";
  const combined = `${safeQuery} ${safeContext}`;
  const stopWords = ["the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by", "how", "what", "where", "when", "why", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did", "will", "would", "could", "should", "may", "might", "can", "must"];
  
  // Ensure combined is a string before processing
  const safeCombined = (combined || "").toString();
  
  return safeCombined
    .toLowerCase()
    .split(/\W+/)
    .filter(word => word.length > 2 && !stopWords.includes(word))
    .slice(0, 5); // Limit to top 5 keywords
}

/**
 * Enhanced synthesis with confidence validation
 * @param {Object} results - Results from executeOrchestration
 * @param {string} format - Desired response format
 * @param {Object} originalQuery - Original query analysis
 * @param {Object} routingConfig - Routing configuration
 * @returns {Object} Synthesized response with validation
 */
export async function synthesizeResponseWithValidation(results, format, originalQuery, routingConfig) {
  // Generate base response
  const baseResponse = synthesizeResponse(results, format, originalQuery);
  
  // Validate response confidence
  const allPassages = results.allPassages;
  let validation;
  
  try {
    validation = validateResponseGrounding(baseResponse.content, allPassages);
    
    // Defensive programming - ensure validation object is complete
    if (!validation || typeof validation !== 'object') {
      throw new Error('Validation function returned invalid result');
    }
    
    // Ensure required properties exist
    validation.confidence = validation.confidence ?? 0.0;
    validation.confidenceLevel = validation.confidenceLevel ?? 'CRITICAL';
    validation.citations = validation.citations ?? { valid: 0, total: 0, invalid: 0 };
    
  } catch (error) {
    console.error(`❌ Validation error: ${error.message}`);
    
    // Create fallback validation object
    validation = {
      isValid: false,
      confidence: 0.0,
      confidenceLevel: 'CRITICAL',
      citationAccuracy: 0.0,
      groundingScore: 0.0,
      citations: { valid: 0, total: 0, invalid: 0 },
      validCitations: [],
      invalidCitations: [],
      retrievedDocCount: allPassages?.length || 0,
      responseLength: baseResponse?.content?.length || 0,
      error: error.message
    };
  }
  
  console.log(`📊 Response validation: ${(validation.confidence * 100).toFixed(1)}% confidence (${validation.confidenceLevel})`);
  
  // Handle low confidence responses
  if (validation.confidence < CONFIDENCE_THRESHOLDS.MEDIUM) {
    const fallbackResult = await handleLowConfidenceResponse(
      originalQuery.query,
      validation.confidence,
      originalQuery.context,
      routingConfig
    );
    
    if (fallbackResult) {
      return {
        ...fallbackResult,
        validation,
        fallbackApplied: true
      };
    }
  }
  
  // Capture learning pattern before returning
  try {
    const queryResult = {
      query: originalQuery.query,
      classification: {
        type: originalQuery.classification?.type || "unknown",
        complexity: originalQuery.classification?.complexity || "simple"
      },
      routing: {
        primary: "orchestrator_query",
        escalation: fallbackResult ? true : false
      },
      confidence: validation.confidence,
      success: validation.confidence >= CONFIDENCE_THRESHOLDS.MEDIUM,
      responseQuality: validation.confidenceLevel,
      sourcesCount: validation.retrievedDocCount || 0,
      processingTime: results.metadata?.duration || 0,
      learningInsights: `Orchestration ${validation.confidence >= CONFIDENCE_THRESHOLDS.MEDIUM ? 'successful' : 'needs improvement'} for ${originalQuery.classification?.type} query`
    };
    
    // Enhanced learning capture with self-query insights and routing optimization
    queryResult.learningEnhanced = originalQuery.learningEnhanced || false;
    queryResult.appliedRecommendations = originalQuery.routingRecommendations?.length || 0;
    queryResult.routingOptimized = originalQuery.routingOptimized || false;
    queryResult.optimizationReason = originalQuery.optimizationReason || null;
    queryResult.learningInsights = `${queryResult.learningInsights}${originalQuery.routingOptimized ? ' (routing optimized)' : ''}`;
    
    await appendLearningPattern(queryResult);
  } catch (learningError) {
    console.warn("Learning capture failed:", learningError.message);
  }

  // Add confidence information to response
  return {
    ...baseResponse,
    validation,
    confidenceIndicators: generateConfidenceIndicators(validation)
  };
}

/**
 * Generate confidence indicators for user display
 */
function generateConfidenceIndicators(validation) {
  const confidence = validation.confidence;
  const level = validation.confidenceLevel;
  
  let indicator = "";
  let explanation = "";
  
  switch (level) {
    case "HIGH":
      indicator = "🎯 High Confidence";
      explanation = "Response is well-grounded in documentation with reliable citations.";
      break;
    case "MEDIUM":
      indicator = "📋 Medium Confidence";
      explanation = "Response is based on available documentation but may have some gaps.";
      break;
    case "LOW":
      indicator = "⚠️ Low Confidence";
      explanation = "Response has limited documentation support. Consider verifying information.";
      break;
    case "CRITICAL":
      indicator = "🚨 Critical - Low Reliability";
      explanation = "Response lacks adequate documentation support. Use with caution.";
      break;
  }
  
  return {
    level,
    confidence: Math.round(confidence * 100),
    indicator,
    explanation,
    citations: validation.citations,
    sources: validation.retrievedDocCount
  };
}
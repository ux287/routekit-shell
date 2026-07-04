/**
 * Learning Engine
 * 
 * Adaptive learning system that improves retrieval quality based on usage patterns,
 * confidence feedback, and query success metrics.
 */

import { createHash } from "crypto";

/**
 * Query classification types for pattern learning
 */
export const LEARNING_QUERY_TYPES = {
  STRATEGIC: "strategic",
  IMPLEMENTATION: "implementation", 
  FACTUAL: "factual",
  COMPARATIVE: "comparative",
  ARCHITECTURAL: "architectural",
  DISCOVERY: "discovery"
};

/**
 * Learning configuration and thresholds
 */
export const LEARNING_CONFIG = {
  // Minimum confidence threshold to learn from a query
  MIN_LEARNING_CONFIDENCE: 0.5,
  
  // Maximum patterns to store per query type
  MAX_PATTERNS_PER_TYPE: 1000,
  
  // Pattern decay factor (patterns lose relevance over time)
  PATTERN_DECAY_RATE: 0.95, // 5% decay per week
  
  // Minimum usage count to consider a pattern reliable
  MIN_PATTERN_USAGE: 3,
  
  // Time window for pattern freshness (30 days)
  PATTERN_FRESHNESS_WINDOW: 30 * 24 * 60 * 60 * 1000,
  
  // Learning performance tracking window
  PERFORMANCE_WINDOW: 100 // Track last 100 queries for metrics
};

/**
 * Extract key terms from a query for pattern matching
 * @param {string} query - Query text to analyze
 * @returns {Array<string>} Extracted key terms
 */
export function extractKeyTerms(query) {
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", 
    "of", "with", "by", "how", "what", "where", "when", "why", "is", "are", 
    "was", "were", "be", "been", "being", "have", "has", "had", "do", "does", 
    "did", "will", "would", "could", "should", "may", "might", "can", "must",
    "i", "you", "we", "they", "me", "us", "them", "my", "your", "our", "their"
  ]);

  // Ensure query is a string to prevent undefined errors
  const safeQuery = (query || "").toString();

  return safeQuery
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ") // Replace punctuation with spaces
    .split(/\s+/)
    .filter(term => term.length > 2 && !stopWords.has(term))
    .slice(0, 10); // Limit to top 10 terms
}

/**
 * Generate a pattern signature for matching similar queries
 * @param {Array<string>} terms - Key terms from query
 * @param {string} queryType - Classified query type
 * @returns {string} Pattern signature hash
 */
export function generatePatternSignature(terms, queryType) {
  const normalizedTerms = terms.sort().join("|");
  const signature = `${queryType}:${normalizedTerms}`;
  return createHash("sha256").update(signature).digest("hex").substring(0, 16);
}

/**
 * Classify query for learning purposes
 * @param {string} query - Query to classify
 * @returns {string} Query classification
 */
export function classifyQueryForLearning(query) {
  // Ensure query is a string to prevent undefined errors
  const safeQuery = (query || "").toString();
  const lower = safeQuery.toLowerCase();
  
  // Strategic decision patterns
  if (lower.match(/(should\s+we\s+|priority|strategic|decision|roadmap|next\s+step)/i)) {
    return LEARNING_QUERY_TYPES.STRATEGIC;
  }
  
  // Implementation patterns
  if (lower.match(/(how\s+(do|can|to)\s+i?\s*|implement|build|create|add|setup|configure)/i)) {
    return LEARNING_QUERY_TYPES.IMPLEMENTATION;
  }
  
  // Comparative patterns
  if (lower.match(/(compare|versus|vs\.?|difference\s+between|better\s+than)/i)) {
    return LEARNING_QUERY_TYPES.COMPARATIVE;
  }
  
  // Architectural patterns
  if (lower.match(/(best\s+(approach|practice|way)|recommended|architecture|pattern)/i)) {
    return LEARNING_QUERY_TYPES.ARCHITECTURAL;
  }
  
  // Discovery patterns
  if (lower.match(/(what\s+(are|options|choices)|show\s+me|list\s+all)/i)) {
    return LEARNING_QUERY_TYPES.DISCOVERY;
  }
  
  // Default to factual
  return LEARNING_QUERY_TYPES.FACTUAL;
}

/**
 * Extract successful sources from retrieval results
 * @param {Array} retrievalResults - Results from retrieval
 * @param {number} minRelevance - Minimum relevance threshold
 * @returns {Array} High-performing sources
 */
export function extractSuccessfulSources(retrievalResults, minRelevance = 0.7) {
  return retrievalResults
    .filter(result => result.relevance >= minRelevance)
    .map(result => ({
      source: result.source,
      relevance: result.relevance,
      content: result.content?.substring(0, 200), // First 200 chars for pattern matching
      domain: extractDomainFromSource(result.source)
    }))
    .slice(0, 5); // Top 5 sources
}

/**
 * Extract domain from source path
 * @param {string} source - Source file path
 * @returns {string} Domain category
 */
function extractDomainFromSource(source) {
  if (!source) return "unknown";
  
  // Ensure source is a string to prevent undefined errors
  const safeSource = (source || "").toString();
  const path = safeSource.toLowerCase();
  
  if (path.includes("design") || path.includes("component")) return "design-system";
  if (path.includes("cli") || path.includes("command")) return "cli";
  if (path.includes("template")) return "templates";
  if (path.includes("docs")) return "documentation";
  if (path.includes("how-to")) return "guides";
  if (path.includes("deploy")) return "deployment";
  if (path.includes("build") || path.includes("dev")) return "development";
  
  return "general";
}

/**
 * Analyze query success and extract learning data
 * @param {string} query - Original query
 * @param {Array} retrievalResults - Results from retrieval
 * @param {number} confidenceScore - Response confidence (0-1)
 * @param {Object} userFeedback - Optional user feedback
 * @returns {Object} Learning pattern data
 */
export function analyzeQuerySuccess(query, retrievalResults, confidenceScore, userFeedback = null) {
  const terms = extractKeyTerms(query);
  const queryType = classifyQueryForLearning(query);
  const signature = generatePatternSignature(terms, queryType);
  const successfulSources = extractSuccessfulSources(retrievalResults);
  
  const pattern = {
    id: signature,
    query: {
      original: query,
      terms,
      type: queryType,
      length: query.length,
      complexity: terms.length
    },
    results: {
      confidence: confidenceScore,
      sourceCount: retrievalResults.length,
      successfulSources,
      domains: [...new Set(successfulSources.map(s => s.domain))]
    },
    performance: {
      success: confidenceScore >= LEARNING_CONFIG.MIN_LEARNING_CONFIDENCE,
      timestamp: Date.now(),
      userFeedback: userFeedback
    },
    metadata: {
      signature,
      version: "1.0"
    }
  };
  
  return pattern;
}

/**
 * Calculate pattern similarity between queries
 * @param {Object} pattern1 - First pattern
 * @param {Object} pattern2 - Second pattern  
 * @returns {number} Similarity score (0-1)
 */
export function calculatePatternSimilarity(pattern1, pattern2) {
  // Type similarity (exact match = 0.3 points)
  const typeSimilarity = pattern1.query.type === pattern2.query.type ? 0.3 : 0;
  
  // Term overlap similarity (up to 0.5 points)
  const terms1 = new Set(pattern1.query.terms);
  const terms2 = new Set(pattern2.query.terms);
  const intersection = new Set([...terms1].filter(t => terms2.has(t)));
  const union = new Set([...terms1, ...terms2]);
  const termSimilarity = union.size > 0 ? (intersection.size / union.size) * 0.5 : 0;
  
  // Domain overlap similarity (up to 0.2 points)
  const domains1 = new Set(pattern1.results.domains);
  const domains2 = new Set(pattern2.results.domains);
  const domainIntersection = new Set([...domains1].filter(d => domains2.has(d)));
  const domainUnion = new Set([...domains1, ...domains2]);
  const domainSimilarity = domainUnion.size > 0 ? (domainIntersection.size / domainUnion.size) * 0.2 : 0;
  
  return typeSimilarity + termSimilarity + domainSimilarity;
}

/**
 * Find similar patterns for a given query
 * @param {string} query - Query to find patterns for
 * @param {Array} existingPatterns - Previously learned patterns
 * @param {number} minSimilarity - Minimum similarity threshold
 * @returns {Array} Similar patterns sorted by similarity
 */
export function findSimilarPatterns(query, existingPatterns, minSimilarity = 0.5) {
  const queryPattern = {
    query: {
      terms: extractKeyTerms(query),
      type: classifyQueryForLearning(query)
    },
    results: {
      domains: [] // Will be filled from similar patterns
    }
  };
  
  return existingPatterns
    .map(pattern => ({
      pattern,
      similarity: calculatePatternSimilarity(queryPattern, pattern)
    }))
    .filter(item => item.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5); // Top 5 similar patterns
}

/**
 * Generate query enhancement suggestions based on learned patterns
 * @param {string} query - Original query
 * @param {Array} similarPatterns - Similar successful patterns
 * @returns {Object} Enhancement suggestions
 */
export function generateQueryEnhancements(query, similarPatterns) {
  const safeQuery = query || "";
  
  if (!similarPatterns || similarPatterns.length === 0) {
    return {
      enhanced: safeQuery,
      suggestions: [],
      confidence: 0
    };
  }
  
  const allSuccessfulTerms = new Set();
  const allSuccessfulDomains = new Set();
  let totalConfidence = 0;
  
  // Collect successful terms and domains from similar patterns
  similarPatterns.forEach(({ pattern, similarity }) => {
    if (pattern.performance.success) {
      pattern.query.terms.forEach(term => allSuccessfulTerms.add(term));
      pattern.results.domains.forEach(domain => allSuccessfulDomains.add(domain));
      totalConfidence += pattern.results.confidence * similarity;
    }
  });
  
  const currentTerms = new Set(extractKeyTerms(safeQuery));
  const suggestedTerms = [...allSuccessfulTerms]
    .filter(term => !currentTerms.has(term))
    .slice(0, 3); // Top 3 suggestions
  
  const enhancedQuery = suggestedTerms.length > 0 
    ? `${safeQuery} ${suggestedTerms.join(" ")}` 
    : safeQuery;
  
  return {
    enhanced: enhancedQuery || safeQuery || "",
    suggestions: {
      terms: suggestedTerms,
      domains: [...allSuccessfulDomains],
      patterns: similarPatterns.length
    },
    confidence: totalConfidence / similarPatterns.length
  };
}

/**
 * Apply pattern decay to reduce relevance of old patterns
 * @param {Object} pattern - Pattern to apply decay to
 * @returns {Object} Pattern with updated scores
 */
export function applyPatternDecay(pattern) {
  const now = Date.now();
  const age = now - pattern.performance.timestamp;
  const weeksPassed = age / (7 * 24 * 60 * 60 * 1000);
  
  const decayFactor = Math.pow(LEARNING_CONFIG.PATTERN_DECAY_RATE, weeksPassed);
  
  return {
    ...pattern,
    results: {
      ...pattern.results,
      confidence: pattern.results.confidence * decayFactor
    },
    metadata: {
      ...pattern.metadata,
      decayFactor,
      effectiveConfidence: pattern.results.confidence * decayFactor
    }
  };
}

/**
 * Calculate learning system performance metrics
 * @param {Array} recentQueries - Recent query history with outcomes
 * @returns {Object} Performance metrics
 */
export function calculateLearningMetrics(recentQueries) {
  if (!recentQueries || recentQueries.length === 0) {
    return {
      totalQueries: 0,
      averageConfidence: 0,
      successRate: 0,
      improvementTrend: 0,
      patternUtilization: 0
    };
  }
  
  const totalQueries = recentQueries.length;
  const successfulQueries = recentQueries.filter(q => q.confidence >= 0.5);
  const enhancedQueries = recentQueries.filter(q => q.wasEnhanced);
  
  const averageConfidence = recentQueries.reduce((sum, q) => sum + q.confidence, 0) / totalQueries;
  const successRate = successfulQueries.length / totalQueries;
  const patternUtilization = enhancedQueries.length / totalQueries;
  
  // Calculate improvement trend (compare first half vs second half)
  const midpoint = Math.floor(totalQueries / 2);
  const firstHalf = recentQueries.slice(0, midpoint);
  const secondHalf = recentQueries.slice(midpoint);
  
  const firstHalfAvg = firstHalf.reduce((sum, q) => sum + q.confidence, 0) / firstHalf.length;
  const secondHalfAvg = secondHalf.reduce((sum, q) => sum + q.confidence, 0) / secondHalf.length;
  const improvementTrend = secondHalfAvg - firstHalfAvg;
  
  return {
    totalQueries,
    averageConfidence: Math.round(averageConfidence * 1000) / 1000,
    successRate: Math.round(successRate * 1000) / 1000,
    improvementTrend: Math.round(improvementTrend * 1000) / 1000,
    patternUtilization: Math.round(patternUtilization * 1000) / 1000,
    enhancedQueries: enhancedQueries.length,
    timeWindow: `${totalQueries} queries`
  };
}

/**
 * Cleanup old and low-performing patterns
 * @param {Array} patterns - Existing patterns to clean
 * @returns {Array} Cleaned patterns
 */
export function cleanupPatterns(patterns) {
  const now = Date.now();
  
  return patterns
    .map(applyPatternDecay)
    .filter(pattern => {
      // Remove patterns that are too old
      const age = now - pattern.performance.timestamp;
      if (age > LEARNING_CONFIG.PATTERN_FRESHNESS_WINDOW) {
        return false;
      }
      
      // Remove patterns with very low effective confidence
      const effectiveConfidence = pattern.metadata?.effectiveConfidence || pattern.results.confidence;
      if (effectiveConfidence < 0.1) {
        return false;
      }
      
      return true;
    })
    .sort((a, b) => {
      // Sort by effective confidence (higher first)
      const aConf = a.metadata?.effectiveConfidence || a.results.confidence;
      const bConf = b.metadata?.effectiveConfidence || b.results.confidence;
      return bConf - aConf;
    })
    .slice(0, LEARNING_CONFIG.MAX_PATTERNS_PER_TYPE);
}

/**
 * Export learning data for analysis or backup
 * @param {Object} learningData - Complete learning dataset
 * @returns {Object} Exportable learning summary
 */
export function exportLearningData(learningData) {
  const patterns = learningData.patterns || [];
  const metrics = calculateLearningMetrics(learningData.recentQueries || []);
  
  // Group patterns by type
  const patternsByType = patterns.reduce((groups, pattern) => {
    const type = pattern.query.type;
    if (!groups[type]) groups[type] = [];
    groups[type].push({
      terms: pattern.query.terms.slice(0, 5), // Limit for privacy
      confidence: pattern.results.confidence,
      domains: pattern.results.domains,
      timestamp: pattern.performance.timestamp,
      success: pattern.performance.success
    });
    return groups;
  }, {});
  
  return {
    summary: {
      totalPatterns: patterns.length,
      patternsByType: Object.keys(patternsByType).map(type => ({
        type,
        count: patternsByType[type].length,
        avgConfidence: patternsByType[type].reduce((sum, p) => sum + p.confidence, 0) / patternsByType[type].length
      })),
      performance: metrics,
      exportDate: new Date().toISOString()
    },
    patterns: patternsByType,
    config: LEARNING_CONFIG
  };
}
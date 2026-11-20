/**
 * Dendron Learning Integration
 * Captures learning patterns in human-readable Dendron documents
 */

import { writeFileSync, appendFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { retrieveWithRouting } from "../../src/router.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Get project slug from current directory
 */
function getProjectSlug() {
  try {
    const routekitConfig = join(process.cwd(), "routekit.json");
    if (existsSync(routekitConfig)) {
      const config = JSON.parse(readFileSync(routekitConfig, "utf8"));
      return config.slug;
    }
  } catch (error) {
    // Fallback to directory name
  }
  return "routekit-shell"; // Default for main project
}

/**
 * Get appropriate learning document path based on query type
 */
function getLearningDocPath(queryType, projectSlug) {
  const notesDir = join(process.cwd(), "notes");
  
  // For the main project, use clean namespace without project slug
  const prefix = projectSlug === "routekit-shell" ? "learning" : `${projectSlug}.learning`;
  
  switch (queryType) {
    case "implementation":
    case "comparative":
    case "architectural":
    case "discovery":
      return join(notesDir, `${prefix}.routing-patterns.md`);
    case "confidence_optimization":
      return join(notesDir, `${prefix}.confidence-optimization.md`);
    case "error_pattern":
      return join(notesDir, `${prefix}.error-patterns.md`);
    default:
      return join(notesDir, `${prefix}.routing-patterns.md`);
  }
}

/**
 * Format learning pattern for Dendron document
 */
function formatLearningPattern(queryResult) {
  const timestamp = new Date().toISOString();
  const date = new Date().toISOString().split('T')[0];
  
  return `
## ${queryResult.classification.type} Query Pattern (${date})

- **Query**: "${queryResult.query}"
- **Classification**: ${queryResult.classification.type}
- **Complexity**: ${queryResult.classification.complexity}
- **Route**: ${queryResult.routing.primary}
- **Confidence**: ${queryResult.confidence.toFixed(2)}
- **Success**: ${queryResult.success ? "✅" : "❌"}
- **Timestamp**: ${timestamp}

### Routing Decision
- **Primary Strategy**: ${queryResult.routing.primary}
- **Escalation**: ${queryResult.routing.escalation ? "Yes" : "No"}
- **Confidence Level**: ${getConfidenceLevel(queryResult.confidence)}

### Performance Metrics
- **Response Quality**: ${queryResult.responseQuality || "Unknown"}
- **Sources Found**: ${queryResult.sourcesCount || 0}
- **Processing Time**: ${queryResult.processingTime || "Unknown"}ms

### Learning Insights
${queryResult.learningInsights || "*Automated learning insights will be added here*"}

---
`;
}

/**
 * Format error pattern for learning capture
 */
function formatErrorPattern(error, context) {
  const timestamp = new Date().toISOString();
  
  return `
## Error Pattern: ${error.type} (${timestamp.split('T')[0]})

- **Error Type**: ${error.type}
- **Query**: "${context.query}"
- **Confidence**: ${context.confidence}
- **Route Attempted**: ${context.route}
- **Timestamp**: ${timestamp}

### Error Details
${error.message}

### Context
- **Classification**: ${context.classification}
- **Complexity**: ${context.complexity}
- **Sources Available**: ${context.sourcesCount || 0}

### Resolution Applied
${error.resolution || "*Resolution will be documented here*"}

### Prevention Strategy
${error.prevention || "*Prevention strategy will be added*"}

---
`;
}

/**
 * Append learning pattern to appropriate Dendron document
 */
export async function appendLearningPattern(queryResult) {
  try {
    const projectSlug = getProjectSlug();
    const docPath = getLearningDocPath(queryResult.classification.type, projectSlug);
    
    // Ensure document exists
    if (!existsSync(docPath)) {
      console.warn(`Learning document not found: ${docPath}`);
      return false;
    }
    
    const pattern = formatLearningPattern(queryResult);
    appendFileSync(docPath, pattern, "utf8");
    
    console.log(`✅ Learning pattern captured in ${docPath}`);
    return true;
    
  } catch (error) {
    console.error("Failed to capture learning pattern:", error);
    return false;
  }
}

/**
 * Capture error patterns for learning
 */
export async function captureErrorPattern(error, context) {
  try {
    const projectSlug = getProjectSlug();
    const docPath = getLearningDocPath("error_pattern", projectSlug);
    
    if (!existsSync(docPath)) {
      console.warn(`Error patterns document not found: ${docPath}`);
      return false;
    }
    
    const pattern = formatErrorPattern(error, context);
    appendFileSync(docPath, pattern, "utf8");
    
    console.log(`🔍 Error pattern captured in ${docPath}`);
    return true;
    
  } catch (error) {
    console.error("Failed to capture error pattern:", error);
    return false;
  }
}

/**
 * Helper function to get confidence level description
 */
function getConfidenceLevel(confidence) {
  if (confidence >= 0.8) return "High";
  if (confidence >= 0.5) return "Medium"; 
  if (confidence >= 0.3) return "Low";
  return "Very Low";
}

/**
 * Self-querying learning system - query our own patterns for routing optimization
 * @param {string} queryType - Type of query to analyze patterns for
 * @param {Object} routingConfig - Routing configuration
 * @param {Object} guardrailConfig - Guardrail configuration
 * @returns {Object} Learning insights from pattern analysis
 */
export async function queryLearningPatterns(queryType, routingConfig, guardrailConfig) {
  try {
    const projectSlug = getProjectSlug();
    
    // Construct pattern search query based on type
    const patternQuery = constructPatternQuery(queryType, projectSlug);
    
    console.log(`🧠 Self-querying learning patterns: "${patternQuery}"`);
    
    // Use RAG to query our own learning patterns
    const result = await retrieveWithRouting(patternQuery, routingConfig, guardrailConfig);
    
    if (!result.passages || result.passages.length === 0) {
      console.log(`📚 No learning patterns found for ${queryType}`);
      return {
        success: false,
        insights: [],
        recommendations: ["Continue building learning patterns for this query type"]
      };
    }
    
    // Analyze patterns and extract insights
    const insights = extractLearningInsights(result.passages, queryType);
    const recommendations = generateRoutingRecommendations(insights, queryType);
    
    console.log(`✅ Extracted ${insights.length} learning insights for ${queryType}`);
    
    return {
      success: true,
      queryType,
      insights,
      recommendations,
      sourcePatterns: result.passages.length,
      trace: result.TRACE
    };
    
  } catch (error) {
    console.error("Failed to query learning patterns:", error);
    return {
      success: false,
      error: error.message,
      queryType,
      insights: [],
      recommendations: []
    };
  }
}

/**
 * Construct RAG query to find relevant learning patterns
 * @param {string} queryType - Type of query to search patterns for
 * @param {string} projectSlug - Project slug for scoping
 * @returns {string} Constructed query for pattern search
 */
function constructPatternQuery(queryType, projectSlug) {
  // Use clean namespace for main project
  const prefix = projectSlug === "routekit-shell" ? "learning" : `${projectSlug} learning`;
  
  const baseQueries = {
    "implementation": `${prefix} routing patterns implementation queries successful`,
    "comparative": `${prefix} routing patterns comparative analysis vs queries`,
    "architectural": `${prefix} routing patterns best approach architectural`,
    "discovery": `${prefix} routing patterns discovery options available`,
    "confidence_optimization": `${prefix} confidence optimization high confidence patterns`,
    "error_pattern": `${prefix} error patterns routing failures resolution`
  };
  
  return baseQueries[queryType] || `${prefix} routing patterns ${queryType}`;
}

/**
 * Extract actionable insights from learning pattern documents
 * @param {Array} passages - Retrieved learning pattern passages
 * @param {string} queryType - Type of query being analyzed
 * @returns {Array} Extracted insights
 */
function extractLearningInsights(passages, queryType) {
  const insights = [];
  
  for (const passage of passages) {
    const content = passage.content || passage.text || "";
    
    // Extract successful routing patterns
    const successfulMatches = content.match(/Success: ✅[\s\S]*?(?=Success: |Error Pattern|##|$)/gi);
    if (successfulMatches) {
      for (const match of successfulMatches) {
        const confidence = extractConfidenceValue(match);
        const route = extractRouteValue(match);
        const queryPattern = extractQueryPattern(match);
        
        if (confidence >= 0.7 && route && queryPattern) {
          insights.push({
            type: "successful_pattern",
            queryPattern,
            route,
            confidence,
            source: passage.metadata?.title || "Learning Document"
          });
        }
      }
    }
    
    // Extract error patterns and resolutions
    const errorMatches = content.match(/Error Pattern[\s\S]*?(?=Error Pattern|##|$)/gi);
    if (errorMatches) {
      for (const match of errorMatches) {
        const resolution = extractResolution(match);
        const prevention = extractPrevention(match);
        
        if (resolution || prevention) {
          insights.push({
            type: "error_learning",
            resolution,
            prevention,
            source: passage.metadata?.title || "Learning Document"
          });
        }
      }
    }
    
    // Extract confidence calibration insights
    const confidenceMatches = content.match(/High Confidence Patterns[\s\S]*?(?=##|$)/gi);
    if (confidenceMatches && queryType === "confidence_optimization") {
      for (const match of confidenceMatches) {
        const pattern = extractSuccessfulPattern(match);
        if (pattern) {
          insights.push({
            type: "confidence_calibration",
            pattern,
            source: passage.metadata?.title || "Learning Document"
          });
        }
      }
    }
  }
  
  return insights;
}

/**
 * Generate routing recommendations based on learning insights
 * @param {Array} insights - Extracted learning insights
 * @param {string} queryType - Type of query being optimized
 * @returns {Array} Routing recommendations
 */
function generateRoutingRecommendations(insights, queryType) {
  const recommendations = [];
  const successfulPatterns = insights.filter(i => i.type === "successful_pattern");
  const errorLearnings = insights.filter(i => i.type === "error_learning");
  
  // Analyze successful patterns
  if (successfulPatterns.length > 0) {
    const highConfidenceRoutes = successfulPatterns
      .filter(p => p.confidence >= 0.8)
      .map(p => p.route)
      .reduce((acc, route) => {
        acc[route] = (acc[route] || 0) + 1;
        return acc;
      }, {});
    
    const bestRoute = Object.entries(highConfidenceRoutes)
      .sort(([,a], [,b]) => b - a)[0];
    
    if (bestRoute) {
      recommendations.push(
        `For ${queryType} queries, route '${bestRoute[0]}' shows highest success rate (${bestRoute[1]} successful patterns)`
      );
    }
  }
  
  // Analyze error patterns
  if (errorLearnings.length > 0) {
    const preventions = errorLearnings
      .map(e => e.prevention)
      .filter(Boolean)
      .slice(0, 3); // Top 3 preventions
    
    if (preventions.length > 0) {
      recommendations.push(
        `Error prevention strategies: ${preventions.join("; ")}`
      );
    }
  }
  
  // Default recommendations if no patterns found
  if (recommendations.length === 0) {
    recommendations.push(`Continue capturing ${queryType} patterns to improve routing accuracy`);
  }
  
  return recommendations;
}

// Helper functions for pattern extraction

function extractConfidenceValue(text) {
  const match = text.match(/Confidence.*?(\d+\.\d+)/i);
  return match ? parseFloat(match[1]) : 0;
}

function extractRouteValue(text) {
  const match = text.match(/Route.*?:\s*([^\n\r]+)/i);
  return match ? match[1].trim() : null;
}

function extractQueryPattern(text) {
  const match = text.match(/Query.*?"([^"]+)"/i);
  return match ? match[1].trim() : null;
}

function extractResolution(text) {
  const match = text.match(/Resolution Applied\s*([\s\S]*?)(?=###|Prevention|$)/i);
  return match ? match[1].trim().replace(/^[*\-\s]+/, "") : null;
}

function extractPrevention(text) {
  const match = text.match(/Prevention Strategy\s*([\s\S]*?)(?=###|---)/i);
  return match ? match[1].trim().replace(/^[*\-\s]+/, "") : null;
}

function extractSuccessfulPattern(text) {
  const match = text.match(/confidence.*?led to successful.*?([^\n\r]+)/i);
  return match ? match[1].trim() : null;
}
/**
 * Learning Storage System
 * 
 * Persistent storage and management for learning data including query patterns,
 * document performance metrics, and fallback strategy effectiveness.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "fs";
import { join, dirname } from "path";
import { createHash } from "crypto";
import { cleanupPatterns, LEARNING_CONFIG } from "./learning-engine.mjs";

/**
 * Storage paths and configuration
 */
const STORAGE_CONFIG = {
  baseDir: join(process.cwd(), ".routekit", "learning"),
  patternsFile: "query-patterns.json",
  documentsFile: "document-performance.json", 
  fallbacksFile: "fallback-strategies.json",
  metricsFile: "learning-metrics.json",
  errorsFile: "orchestration-errors.json",
  
  // Backup configuration
  maxBackups: 5,
  backupInterval: 7 * 24 * 60 * 60 * 1000, // 7 days
  
  // Data validation
  maxFileSize: 10 * 1024 * 1024, // 10MB per file
  maxPatterns: 5000,
  maxDocumentEntries: 1000,
  maxFallbackEntries: 100
};

/**
 * Ensure storage directory exists
 * @param {string} dirPath - Directory path to create
 */
function ensureDirectory(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Create backup of existing file
 * @param {string} filePath - File to backup
 */
function createBackup(filePath) {
  if (!existsSync(filePath)) return;
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.backup.${timestamp}`;
  
  try {
    const data = readFileSync(filePath);
    writeFileSync(backupPath, data);
    
    // Clean old backups
    cleanOldBackups(dirname(filePath), `${basename(filePath)}.backup.`);
  } catch (error) {
    console.error(`Failed to create backup: ${error.message}`);
  }
}

/**
 * Clean old backup files
 * @param {string} dirPath - Directory containing backups
 * @param {string} prefix - Backup file prefix
 */
async function cleanOldBackups(dirPath, prefix) {
  try {
    const { readdirSync, unlinkSync } = await import("fs");
    const files = readdirSync(dirPath)
      .filter(f => f.startsWith(prefix))
      .map(f => ({
        name: f,
        path: join(dirPath, f),
        mtime: statSync(join(dirPath, f)).mtime
      }))
      .sort((a, b) => b.mtime - a.mtime);
    
    // Remove excess backups
    files.slice(STORAGE_CONFIG.maxBackups).forEach(file => {
      try {
        unlinkSync(file.path);
      } catch (error) {
        console.error(`Failed to delete old backup ${file.name}: ${error.message}`);
      }
    });
  } catch (error) {
    console.error(`Failed to clean old backups: ${error.message}`);
  }
}

/**
 * Safely read JSON file with error handling
 * @param {string} filePath - Path to JSON file
 * @param {*} defaultValue - Default value if file doesn't exist
 * @returns {*} Parsed JSON data or default
 */
function safeReadJSON(filePath, defaultValue = null) {
  try {
    if (!existsSync(filePath)) {
      return defaultValue;
    }
    
    const stats = statSync(filePath);
    if (stats.size > STORAGE_CONFIG.maxFileSize) {
      console.warn(`Learning file ${filePath} exceeds size limit, returning default`);
      return defaultValue;
    }
    
    const data = readFileSync(filePath, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error(`Failed to read ${filePath}: ${error.message}`);
    return defaultValue;
  }
}

/**
 * Safely write JSON file with backup and validation
 * @param {string} filePath - Path to write to
 * @param {*} data - Data to write
 * @returns {boolean} Success status
 */
function safeWriteJSON(filePath, data) {
  try {
    // Validate data size
    const jsonString = JSON.stringify(data, null, 2);
    if (jsonString.length > STORAGE_CONFIG.maxFileSize) {
      console.error(`Data too large to write to ${filePath}`);
      return false;
    }
    
    // Create backup of existing file
    if (existsSync(filePath)) {
      createBackup(filePath);
    }
    
    // Ensure directory exists
    ensureDirectory(dirname(filePath));
    
    // Write new data
    writeFileSync(filePath, jsonString, "utf8");
    return true;
  } catch (error) {
    console.error(`Failed to write ${filePath}: ${error.message}`);
    return false;
  }
}

/**
 * Initialize learning storage system
 * @returns {Object} Initialization result
 */
export function initializeLearningStorage() {
  const baseDir = STORAGE_CONFIG.baseDir;
  
  try {
    ensureDirectory(baseDir);
    
    // Initialize empty files if they don't exist
    const files = [
      { name: STORAGE_CONFIG.patternsFile, default: { patterns: [], metadata: { version: "1.0", created: Date.now() } } },
      { name: STORAGE_CONFIG.documentsFile, default: { documents: {}, metadata: { version: "1.0", created: Date.now() } } },
      { name: STORAGE_CONFIG.fallbacksFile, default: { strategies: {}, metadata: { version: "1.0", created: Date.now() } } },
      { name: STORAGE_CONFIG.metricsFile, default: { metrics: { queries: [], sessions: [] }, metadata: { version: "1.0", created: Date.now() } } },
      { name: STORAGE_CONFIG.errorsFile, default: { errors: [], patterns: {}, metadata: { version: "1.0", created: Date.now() } } }
    ];
    
    files.forEach(({ name, default: defaultData }) => {
      const filePath = join(baseDir, name);
      if (!existsSync(filePath)) {
        safeWriteJSON(filePath, defaultData);
      }
    });
    
    return {
      success: true,
      baseDir,
      message: "Learning storage initialized successfully"
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Load query patterns from storage
 * @returns {Object} Patterns data with metadata
 */
export function loadQueryPatterns() {
  const filePath = join(STORAGE_CONFIG.baseDir, STORAGE_CONFIG.patternsFile);
  const data = safeReadJSON(filePath, { patterns: [], metadata: {} });
  
  // Apply cleanup to loaded patterns
  const cleanedPatterns = cleanupPatterns(data.patterns || []);
  
  return {
    patterns: cleanedPatterns,
    metadata: {
      ...data.metadata,
      loadTime: Date.now(),
      totalPatterns: cleanedPatterns.length,
      cleanedCount: (data.patterns?.length || 0) - cleanedPatterns.length
    }
  };
}

/**
 * Save query patterns to storage
 * @param {Array} patterns - Patterns to save
 * @returns {boolean} Success status
 */
export function saveQueryPatterns(patterns) {
  const filePath = join(STORAGE_CONFIG.baseDir, STORAGE_CONFIG.patternsFile);
  
  // Validate pattern count
  if (patterns.length > STORAGE_CONFIG.maxPatterns) {
    console.warn(`Too many patterns (${patterns.length}), trimming to ${STORAGE_CONFIG.maxPatterns}`);
    patterns = patterns.slice(0, STORAGE_CONFIG.maxPatterns);
  }
  
  const data = {
    patterns,
    metadata: {
      version: "1.0",
      updated: Date.now(),
      count: patterns.length
    }
  };
  
  return safeWriteJSON(filePath, data);
}

/**
 * Add new query pattern to storage
 * @param {Object} pattern - Pattern to add
 * @returns {boolean} Success status
 */
export function addQueryPattern(pattern) {
  const { patterns } = loadQueryPatterns();
  
  // Check if pattern already exists (update instead of duplicate)
  const existingIndex = patterns.findIndex(p => p.id === pattern.id);
  
  if (existingIndex >= 0) {
    // Update existing pattern
    patterns[existingIndex] = {
      ...patterns[existingIndex],
      ...pattern,
      metadata: {
        ...pattern.metadata,
        updated: Date.now(),
        updateCount: (patterns[existingIndex].metadata?.updateCount || 0) + 1
      }
    };
  } else {
    // Add new pattern
    patterns.push({
      ...pattern,
      metadata: {
        ...pattern.metadata,
        created: Date.now(),
        updateCount: 0
      }
    });
  }
  
  return saveQueryPatterns(patterns);
}

/**
 * Load document performance data
 * @returns {Object} Document performance data
 */
export function loadDocumentPerformance() {
  const filePath = join(STORAGE_CONFIG.baseDir, STORAGE_CONFIG.documentsFile);
  const data = safeReadJSON(filePath, { documents: {}, metadata: {} });
  
  return {
    documents: data.documents || {},
    metadata: {
      ...data.metadata,
      loadTime: Date.now(),
      documentCount: Object.keys(data.documents || {}).length
    }
  };
}

/**
 * Save document performance data
 * @param {Object} documents - Document performance data
 * @returns {boolean} Success status
 */
export function saveDocumentPerformance(documents) {
  const filePath = join(STORAGE_CONFIG.baseDir, STORAGE_CONFIG.documentsFile);
  
  // Validate document count
  const docKeys = Object.keys(documents);
  if (docKeys.length > STORAGE_CONFIG.maxDocumentEntries) {
    console.warn(`Too many document entries (${docKeys.length}), trimming to ${STORAGE_CONFIG.maxDocumentEntries}`);
    
    // Keep only the most recently updated documents
    const sortedEntries = docKeys
      .map(key => ({ key, lastUpdated: documents[key].lastUpdated || 0 }))
      .sort((a, b) => b.lastUpdated - a.lastUpdated)
      .slice(0, STORAGE_CONFIG.maxDocumentEntries);
    
    const trimmedDocuments = {};
    sortedEntries.forEach(({ key }) => {
      trimmedDocuments[key] = documents[key];
    });
    documents = trimmedDocuments;
  }
  
  const data = {
    documents,
    metadata: {
      version: "1.0",
      updated: Date.now(),
      count: Object.keys(documents).length
    }
  };
  
  return safeWriteJSON(filePath, data);
}

/**
 * Update document performance metrics
 * @param {string} documentId - Document identifier
 * @param {Object} performance - Performance metrics
 * @returns {boolean} Success status
 */
export function updateDocumentPerformance(documentId, performance) {
  const { documents } = loadDocumentPerformance();
  
  const existing = documents[documentId] || {
    totalQueries: 0,
    successfulCitations: 0,
    avgRelevance: 0,
    queryTypes: {},
    created: Date.now()
  };
  
  // Update metrics
  const updated = {
    ...existing,
    totalQueries: existing.totalQueries + 1,
    successfulCitations: existing.successfulCitations + (performance.success ? 1 : 0),
    avgRelevance: ((existing.avgRelevance * existing.totalQueries) + performance.relevance) / (existing.totalQueries + 1),
    lastUpdated: Date.now()
  };
  
  // Update query type specific metrics
  const queryType = performance.queryType || "unknown";
  if (!updated.queryTypes[queryType]) {
    updated.queryTypes[queryType] = { count: 0, success: 0, avgRelevance: 0 };
  }
  
  const typeMetrics = updated.queryTypes[queryType];
  typeMetrics.count += 1;
  typeMetrics.success += performance.success ? 1 : 0;
  typeMetrics.avgRelevance = ((typeMetrics.avgRelevance * (typeMetrics.count - 1)) + performance.relevance) / typeMetrics.count;
  
  documents[documentId] = updated;
  return saveDocumentPerformance(documents);
}

/**
 * Load fallback strategy performance data
 * @returns {Object} Fallback strategy data
 */
export function loadFallbackPerformance() {
  const filePath = join(STORAGE_CONFIG.baseDir, STORAGE_CONFIG.fallbacksFile);
  const data = safeReadJSON(filePath, { strategies: {}, metadata: {} });
  
  return {
    strategies: data.strategies || {},
    metadata: {
      ...data.metadata,
      loadTime: Date.now(),
      strategyCount: Object.keys(data.strategies || {}).length
    }
  };
}

/**
 * Update fallback strategy performance
 * @param {string} strategy - Strategy name
 * @param {Object} performance - Performance data
 * @returns {boolean} Success status
 */
export function updateFallbackPerformance(strategy, performance) {
  const { strategies } = loadFallbackPerformance();
  
  const existing = strategies[strategy] || {
    totalAttempts: 0,
    successfulImprovements: 0,
    avgImprovement: 0,
    bestQueryTypes: [],
    created: Date.now()
  };
  
  // Update metrics
  const updated = {
    ...existing,
    totalAttempts: existing.totalAttempts + 1,
    successfulImprovements: existing.successfulImprovements + (performance.success ? 1 : 0),
    avgImprovement: ((existing.avgImprovement * existing.totalAttempts) + performance.improvement) / (existing.totalAttempts + 1),
    lastUpdated: Date.now()
  };
  
  // Update best query types
  if (performance.success && performance.queryType) {
    const queryTypes = updated.bestQueryTypes || [];
    if (!queryTypes.includes(performance.queryType)) {
      queryTypes.push(performance.queryType);
      updated.bestQueryTypes = queryTypes.slice(-10); // Keep last 10 successful types
    }
  }
  
  strategies[strategy] = updated;
  
  const data = {
    strategies,
    metadata: {
      version: "1.0",
      updated: Date.now(),
      count: Object.keys(strategies).length
    }
  };
  
  const filePath = join(STORAGE_CONFIG.baseDir, STORAGE_CONFIG.fallbacksFile);
  return safeWriteJSON(filePath, data);
}

/**
 * Record learning metrics for analysis
 * @param {Object} metrics - Metrics to record
 * @returns {boolean} Success status
 */
export function recordLearningMetrics(metrics) {
  const filePath = join(STORAGE_CONFIG.baseDir, STORAGE_CONFIG.metricsFile);
  const data = safeReadJSON(filePath, { metrics: { queries: [], sessions: [] }, metadata: {} });
  
  // Add to queries array
  data.metrics.queries.push({
    ...metrics,
    timestamp: Date.now()
  });
  
  // Keep only recent queries (limit storage growth)
  data.metrics.queries = data.metrics.queries
    .slice(-LEARNING_CONFIG.PERFORMANCE_WINDOW);
  
  // Update metadata
  data.metadata = {
    version: "1.0",
    updated: Date.now(),
    queryCount: data.metrics.queries.length
  };
  
  return safeWriteJSON(filePath, data);
}

/**
 * Get learning metrics for analysis
 * @returns {Object} Learning metrics
 */
export function getLearningMetrics() {
  const filePath = join(STORAGE_CONFIG.baseDir, STORAGE_CONFIG.metricsFile);
  const data = safeReadJSON(filePath, { metrics: { queries: [], sessions: [] }, metadata: {} });
  
  return {
    queries: data.metrics.queries || [],
    sessions: data.metrics.sessions || [],
    metadata: data.metadata || {}
  };
}

/**
 * Export all learning data for backup or analysis
 * @returns {Object} Complete learning data export
 */
export function exportLearningData() {
  try {
    const patterns = loadQueryPatterns();
    const documents = loadDocumentPerformance();
    const fallbacks = loadFallbackPerformance();
    const metrics = getLearningMetrics();
    
    return {
      success: true,
      data: {
        patterns,
        documents,
        fallbacks,
        metrics,
        export: {
          timestamp: Date.now(),
          version: "1.0",
          config: STORAGE_CONFIG
        }
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Clear all learning data (with confirmation)
 * @param {boolean} confirm - Confirmation flag
 * @returns {Object} Operation result
 */
export function clearLearningData(confirm = false) {
  if (!confirm) {
    return {
      success: false,
      error: "Confirmation required to clear learning data"
    };
  }
  
  try {
    // Create backup before clearing
    const backup = exportLearningData();
    if (backup.success) {
      const backupPath = join(STORAGE_CONFIG.baseDir, `full-backup-${Date.now()}.json`);
      safeWriteJSON(backupPath, backup.data);
    }
    
    // Clear all files
    const files = [
      STORAGE_CONFIG.patternsFile,
      STORAGE_CONFIG.documentsFile,
      STORAGE_CONFIG.fallbacksFile,
      STORAGE_CONFIG.metricsFile
    ];
    
    files.forEach(filename => {
      const filePath = join(STORAGE_CONFIG.baseDir, filename);
      if (existsSync(filePath)) {
        const fs = require("fs");
        fs.unlinkSync(filePath);
      }
    });
    
    // Reinitialize
    initializeLearningStorage();
    
    return {
      success: true,
      message: "Learning data cleared successfully",
      backupCreated: backup.success
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// Helper function for basename (since path.basename might not be available)
function basename(filePath) {
  return filePath.split(/[\\/]/).pop();
}

/**
 * Record orchestration error for pattern analysis
 * @param {Object} errorData - Error details including query, error message, stack trace
 * @returns {Promise<boolean>} Success status
 */
export async function recordOrchestrationError(errorData) {
  try {
    const filePath = join(STORAGE_CONFIG.baseDir, STORAGE_CONFIG.errorsFile);
    const data = safeReadJSON(filePath, { errors: [], patterns: {}, metadata: {} });
    
    const errorRecord = {
      id: createHash('md5').update(`${errorData.query}-${errorData.error}-${Date.now()}`).digest('hex').substring(0, 8),
      timestamp: Date.now(),
      query: errorData.query || '',
      complexity: errorData.complexity || 'unknown',
      context: errorData.context || '',
      error: errorData.error || '',
      stackTrace: errorData.stackTrace || '',
      orchestrationStep: errorData.orchestrationStep || 'unknown',
      previouslyWorked: errorData.previouslyWorked || false
    };
    
    // Add to errors array (keep last 500)
    data.errors = data.errors || [];
    data.errors.push(errorRecord);
    if (data.errors.length > 500) {
      data.errors = data.errors.slice(-500);
    }
    
    // Update error patterns
    const errorPattern = extractErrorPattern(errorData.error);
    data.patterns = data.patterns || {};
    data.patterns[errorPattern] = data.patterns[errorPattern] || {
      count: 0,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      queries: [],
      complexities: {}
    };
    
    data.patterns[errorPattern].count++;
    data.patterns[errorPattern].lastSeen = Date.now();
    data.patterns[errorPattern].queries.push(errorData.query);
    data.patterns[errorPattern].complexities[errorData.complexity] = 
      (data.patterns[errorPattern].complexities[errorData.complexity] || 0) + 1;
    
    // Keep only last 10 queries per pattern
    if (data.patterns[errorPattern].queries.length > 10) {
      data.patterns[errorPattern].queries = data.patterns[errorPattern].queries.slice(-10);
    }
    
    data.metadata.lastUpdated = Date.now();
    data.metadata.totalErrors = data.errors.length;
    data.metadata.uniquePatterns = Object.keys(data.patterns).length;
    
    return safeWriteJSON(filePath, data);
  } catch (error) {
    console.error('Failed to record orchestration error:', error.message);
    return false;
  }
}

/**
 * Extract error pattern from error message
 * @param {string} errorMessage - Full error message
 * @returns {string} Normalized error pattern
 */
function extractErrorPattern(errorMessage) {
  // Extract key error patterns
  if (errorMessage.includes("Cannot read properties of undefined (reading 'toLowerCase')")) {
    return "toLowerCase_undefined";
  }
  if (errorMessage.includes("Cannot read properties of null")) {
    return "null_property_access";
  }
  if (errorMessage.includes("TypeError")) {
    return "type_error";
  }
  if (errorMessage.includes("ReferenceError")) {
    return "reference_error";
  }
  
  // Generic pattern extraction
  const match = errorMessage.match(/^(\w+Error): (.{0,50})/);
  if (match) {
    return `${match[1].toLowerCase()}_${match[2].toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')}`;
  }
  
  return "unknown_error";
}

/**
 * Get error analysis and patterns
 * @returns {Object} Error analysis data
 */
export function getErrorAnalysis() {
  try {
    const filePath = join(STORAGE_CONFIG.baseDir, STORAGE_CONFIG.errorsFile);
    const data = safeReadJSON(filePath, { errors: [], patterns: {}, metadata: {} });
    
    const analysis = {
      summary: {
        totalErrors: data.errors.length,
        uniquePatterns: Object.keys(data.patterns).length,
        timeRange: {
          first: data.errors.length > 0 ? Math.min(...data.errors.map(e => e.timestamp)) : null,
          last: data.errors.length > 0 ? Math.max(...data.errors.map(e => e.timestamp)) : null
        }
      },
      topPatterns: Object.entries(data.patterns)
        .sort(([,a], [,b]) => b.count - a.count)
        .slice(0, 10)
        .map(([pattern, data]) => ({ pattern, ...data })),
      recentErrors: data.errors.slice(-20),
      complexityBreakdown: {},
      recommendations: []
    };
    
    // Analyze complexity patterns
    data.errors.forEach(error => {
      analysis.complexityBreakdown[error.complexity] = 
        (analysis.complexityBreakdown[error.complexity] || 0) + 1;
    });
    
    // Generate recommendations
    if (data.patterns.toLowerCase_undefined?.count > 5) {
      analysis.recommendations.push({
        priority: "high",
        issue: "Frequent toLowerCase() undefined errors",
        suggestion: "Review parameter validation in orchestration engine",
        affectedComplexities: Object.keys(data.patterns.toLowerCase_undefined.complexities)
      });
    }
    
    return analysis;
  } catch (error) {
    console.error('Failed to analyze errors:', error.message);
    return { summary: {}, topPatterns: [], recentErrors: [], recommendations: [] };
  }
}
#!/usr/bin/env node
/**
 * Pattern Extraction Pipeline - Automatically discovers successful query→result patterns
 * from trading system usage to improve contextual intelligence
 */

import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';

class PatternExtractor {
  constructor(options = {}) {
    this.learningDataPath = options.learningDataPath || '.routekit/learning';
    this.patternsPath = path.join(this.learningDataPath, 'patterns.json');
    this.queryHistoryPath = path.join(this.learningDataPath, 'query-history.json');
    this.optimizationsPath = path.join(this.learningDataPath, 'optimizations.json');
    
    this.patterns = new Map();
    this.queryHistory = [];
    this.optimizations = new Map();
    
    this.initializeLearningSystem();
  }

  async initializeLearningSystem() {
    try {
      // Ensure learning directory exists
      await fs.mkdir(this.learningDataPath, { recursive: true });
      
      // Load existing patterns
      await this.loadPatterns();
      await this.loadQueryHistory();
      await this.loadOptimizations();
      
      console.log('✅ Pattern extraction system initialized');
    } catch (error) {
      console.error('❌ Failed to initialize pattern extraction:', error.message);
    }
  }

  async loadPatterns() {
    try {
      const data = await fs.readFile(this.patternsPath, 'utf-8');
      const patterns = JSON.parse(data);
      
      patterns.forEach(pattern => {
        // Convert object properties back to Maps if needed
        if (pattern.query_features && typeof pattern.query_features === 'object') {
          pattern.query_features = new Map(Object.entries(pattern.query_features));
        }
        if (pattern.optimal_routes && typeof pattern.optimal_routes === 'object') {
          pattern.optimal_routes = new Map(Object.entries(pattern.optimal_routes));
        }
        if (pattern.successful_query_types && typeof pattern.successful_query_types === 'object') {
          pattern.successful_query_types = new Map(Object.entries(pattern.successful_query_types));
        }
        if (pattern.successful_query_patterns && typeof pattern.successful_query_patterns === 'object') {
          pattern.successful_query_patterns = new Map(Object.entries(pattern.successful_query_patterns));
        }
        if (pattern.domain_affinity && typeof pattern.domain_affinity === 'object') {
          pattern.domain_affinity = new Map(Object.entries(pattern.domain_affinity));
        }
        
        this.patterns.set(pattern.id, pattern);
      });
      
      console.log(`📊 Loaded ${this.patterns.size} existing patterns`);
    } catch (error) {
      // File doesn't exist yet - start fresh
      console.log('🆕 Starting with fresh pattern database');
    }
  }

  async loadQueryHistory() {
    try {
      const data = await fs.readFile(this.queryHistoryPath, 'utf-8');
      this.queryHistory = JSON.parse(data);
      
      console.log(`📈 Loaded ${this.queryHistory.length} historical queries`);
    } catch (error) {
      console.log('🆕 Starting with fresh query history');
    }
  }

  async loadOptimizations() {
    try {
      const data = await fs.readFile(this.optimizationsPath, 'utf-8');
      const optimizations = JSON.parse(data);
      
      optimizations.forEach(opt => {
        this.optimizations.set(opt.id, opt);
      });
      
      console.log(`⚡ Loaded ${this.optimizations.size} optimizations`);
    } catch (error) {
      console.log('🆕 Starting with fresh optimizations');
    }
  }

  /**
   * Record a query execution for pattern learning
   */
  async recordQueryExecution(queryData) {
    const execution = {
      id: this.generateId(queryData.query + queryData.timestamp),
      timestamp: queryData.timestamp || new Date().toISOString(),
      query: queryData.query,
      domain_hint: queryData.domain_hint,
      search_depth: queryData.search_depth,
      classification: queryData.classification,
      results_count: queryData.results?.length || 0,
      execution_time: queryData.execution_time,
      success_score: this.calculateSuccessScore(queryData),
      result_types: this.extractResultTypes(queryData.results),
      escalation_triggered: queryData.escalation_triggered || false,
      contextual_warnings: queryData.contextual_warnings?.length || 0
    };
    
    this.queryHistory.push(execution);
    
    // Limit history size to prevent unbounded growth
    if (this.queryHistory.length > 10000) {
      this.queryHistory = this.queryHistory.slice(-8000); // Keep most recent 8000
    }
    
    await this.saveQueryHistory();
    
    // Extract patterns from this execution
    await this.extractPatternsFromExecution(execution);
    
    return execution;
  }

  calculateSuccessScore(queryData) {
    let score = 0;
    
    // Base score from result count (normalized)
    const resultCount = queryData.results?.length || 0;
    score += Math.min(resultCount / 5, 1.0) * 0.4; // Max 0.4 for having good results
    
    // Execution time penalty (faster is better)
    const executionTime = queryData.execution_time || 1000;
    const timeScore = Math.max(0, (500 - executionTime) / 500) * 0.2; // Max 0.2 for being fast
    score += timeScore;
    
    // Classification confidence bonus
    const confidence = queryData.classification?.confidence || 0.5;
    score += confidence * 0.2; // Max 0.2 for high confidence
    
    // Domain relevance bonus (if results match domain hint)
    if (queryData.domain_hint && queryData.results) {
      const domainMatches = queryData.results.filter(r => 
        (r.path || '').includes(queryData.domain_hint)
      ).length;
      const domainRelevance = domainMatches / Math.max(resultCount, 1);
      score += domainRelevance * 0.2; // Max 0.2 for domain relevance
    }
    
    return Math.min(score, 1.0);
  }

  extractResultTypes(results) {
    if (!results || results.length === 0) return [];
    
    const types = new Set();
    
    results.forEach(result => {
      const path = result.path || result.source || '';
      
      if (path.includes('.py')) types.add('python_code');
      if (path.includes('.js') || path.includes('.mjs')) types.add('javascript_code');
      if (path.includes('.md')) types.add('documentation');
      if (path.includes('.yaml') || path.includes('.yml')) types.add('configuration');
      if (path.includes('strategies.')) types.add('strategy_knowledge');
      if (path.includes('risk.')) types.add('risk_knowledge');
      if (path.includes('api.')) types.add('api_knowledge');
      if (path.includes('/src/')) types.add('source_code');
      if (path.includes('/notes/')) types.add('knowledge_base');
      if (path.includes('/tests/')) types.add('test_code');
    });
    
    return Array.from(types);
  }

  /**
   * Extract successful patterns from a query execution
   */
  async extractPatternsFromExecution(execution) {
    // Only learn from successful executions
    if (execution.success_score < 0.6) return;
    
    // Query classification patterns
    await this.recordClassificationPattern(execution);
    
    // Domain routing patterns
    await this.recordDomainPattern(execution);
    
    // Execution performance patterns
    await this.recordPerformancePattern(execution);
    
    // Result type patterns
    await this.recordResultTypePattern(execution);
  }

  async recordClassificationPattern(execution) {
    const patternId = `classification_${execution.classification?.route || 'unknown'}`;
    
    let pattern = this.patterns.get(patternId) || {
      id: patternId,
      type: 'classification',
      route: execution.classification?.route || 'unknown',
      successful_queries: [],
      query_features: new Map(),
      average_success: 0,
      total_executions: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    // Extract query features
    const queryFeatures = this.extractQueryFeatures(execution.query);
    queryFeatures.forEach(feature => {
      const currentCount = pattern.query_features.get(feature) || 0;
      pattern.query_features.set(feature, currentCount + 1);
    });
    
    pattern.successful_queries.push({
      query: execution.query,
      success_score: execution.success_score,
      timestamp: execution.timestamp
    });
    
    // Keep only recent successful queries
    pattern.successful_queries = pattern.successful_queries
      .slice(-50) // Keep last 50 successful queries
      .filter(q => q.success_score >= 0.6);
    
    pattern.total_executions++;
    pattern.average_success = pattern.successful_queries.reduce((sum, q) => sum + q.success_score, 0) / pattern.successful_queries.length;
    pattern.updated_at = new Date().toISOString();
    
    // Convert Map to Object for JSON serialization
    pattern.query_features = Object.fromEntries(pattern.query_features);
    
    this.patterns.set(patternId, pattern);
    await this.savePatterns();
  }

  async recordDomainPattern(execution) {
    if (!execution.domain_hint) return;
    
    const patternId = `domain_${execution.domain_hint}`;
    
    let pattern = this.patterns.get(patternId) || {
      id: patternId,
      type: 'domain',
      domain: execution.domain_hint,
      optimal_routes: new Map(),
      successful_query_types: new Map(),
      average_execution_time: 0,
      total_executions: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    // Track which routes work best for this domain
    const route = execution.classification?.route || 'unknown';
    const currentRouteData = pattern.optimal_routes.get(route) || { count: 0, avg_success: 0, total_success: 0 };
    currentRouteData.count++;
    currentRouteData.total_success += execution.success_score;
    currentRouteData.avg_success = currentRouteData.total_success / currentRouteData.count;
    pattern.optimal_routes.set(route, currentRouteData);
    
    // Track successful query types for this domain
    const queryType = this.classifyQueryType(execution.query);
    const currentTypeData = pattern.successful_query_types.get(queryType) || { count: 0, avg_success: 0, total_success: 0 };
    currentTypeData.count++;
    currentTypeData.total_success += execution.success_score;
    currentTypeData.avg_success = currentTypeData.total_success / currentTypeData.count;
    pattern.successful_query_types.set(queryType, currentTypeData);
    
    pattern.total_executions++;
    pattern.average_execution_time = ((pattern.average_execution_time * (pattern.total_executions - 1)) + execution.execution_time) / pattern.total_executions;
    pattern.updated_at = new Date().toISOString();
    
    // Convert Maps to Objects for JSON serialization
    pattern.optimal_routes = Object.fromEntries(pattern.optimal_routes);
    pattern.successful_query_types = Object.fromEntries(pattern.successful_query_types);
    
    this.patterns.set(patternId, pattern);
    await this.savePatterns();
  }

  async recordPerformancePattern(execution) {
    const patternId = `performance_${execution.search_depth || 'standard'}`;
    
    let pattern = this.patterns.get(patternId) || {
      id: patternId,
      type: 'performance',
      search_depth: execution.search_depth || 'standard',
      execution_time_buckets: { fast: 0, medium: 0, slow: 0 },
      success_by_time: { fast: [], medium: [], slow: [] },
      escalation_frequency: 0,
      total_executions: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    // Categorize execution time
    let timeBucket;
    if (execution.execution_time < 200) timeBucket = 'fast';
    else if (execution.execution_time < 800) timeBucket = 'medium';
    else timeBucket = 'slow';
    
    pattern.execution_time_buckets[timeBucket]++;
    pattern.success_by_time[timeBucket].push(execution.success_score);
    
    // Keep only recent scores for each bucket (limit memory usage)
    Object.keys(pattern.success_by_time).forEach(bucket => {
      pattern.success_by_time[bucket] = pattern.success_by_time[bucket].slice(-100);
    });
    
    if (execution.escalation_triggered) {
      pattern.escalation_frequency++;
    }
    
    pattern.total_executions++;
    pattern.updated_at = new Date().toISOString();
    
    this.patterns.set(patternId, pattern);
    await this.savePatterns();
  }

  async recordResultTypePattern(execution) {
    execution.result_types.forEach(async (resultType) => {
      const patternId = `result_type_${resultType}`;
      
      let pattern = this.patterns.get(patternId) || {
        id: patternId,
        type: 'result_type',
        result_type: resultType,
        successful_query_patterns: new Map(),
        domain_affinity: new Map(),
        total_executions: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      
      // Track which query patterns lead to this result type
      const queryFeatures = this.extractQueryFeatures(execution.query);
      queryFeatures.forEach(feature => {
        const currentCount = pattern.successful_query_patterns.get(feature) || 0;
        pattern.successful_query_patterns.set(feature, currentCount + 1);
      });
      
      // Track domain affinity
      if (execution.domain_hint) {
        const currentAffinity = pattern.domain_affinity.get(execution.domain_hint) || 0;
        pattern.domain_affinity.set(execution.domain_hint, currentAffinity + 1);
      }
      
      pattern.total_executions++;
      pattern.updated_at = new Date().toISOString();
      
      // Convert Maps to Objects for JSON serialization
      pattern.successful_query_patterns = Object.fromEntries(pattern.successful_query_patterns);
      pattern.domain_affinity = Object.fromEntries(pattern.domain_affinity);
      
      this.patterns.set(patternId, pattern);
    });
    
    await this.savePatterns();
  }

  extractQueryFeatures(query) {
    const features = new Set();
    const lowerQuery = query.toLowerCase();
    
    // Technical analysis terms
    if (lowerQuery.includes('rsi')) features.add('has_rsi');
    if (lowerQuery.includes('macd')) features.add('has_macd');
    if (lowerQuery.includes('bollinger')) features.add('has_bollinger');
    if (lowerQuery.includes('momentum')) features.add('has_momentum');
    if (lowerQuery.includes('strategy')) features.add('has_strategy');
    if (lowerQuery.includes('risk')) features.add('has_risk');
    if (lowerQuery.includes('position')) features.add('has_position');
    if (lowerQuery.includes('size') || lowerQuery.includes('sizing')) features.add('has_sizing');
    
    // Query structure
    if (query.split(' ').length <= 3) features.add('short_query');
    else if (query.split(' ').length > 8) features.add('long_query');
    else features.add('medium_query');
    
    if (query.includes('?')) features.add('question_query');
    if (query.includes('how')) features.add('how_query');
    if (query.includes('what')) features.add('what_query');
    if (query.includes('implement') || lowerQuery.includes('code')) features.add('implementation_query');
    
    // Domain-specific patterns
    if (lowerQuery.includes('robinhood') || lowerQuery.includes('tradier')) features.add('broker_query');
    if (lowerQuery.includes('crypto') || lowerQuery.includes('bitcoin')) features.add('crypto_query');
    if (lowerQuery.includes('options') || lowerQuery.includes('spread')) features.add('options_query');
    
    return Array.from(features);
  }

  classifyQueryType(query) {
    const lowerQuery = query.toLowerCase();
    
    if (lowerQuery.includes('implement') || lowerQuery.includes('code') || lowerQuery.includes('function')) {
      return 'implementation';
    }
    if (lowerQuery.includes('how') || lowerQuery.includes('tutorial')) {
      return 'how_to';
    }
    if (lowerQuery.includes('what') || lowerQuery.includes('explain')) {
      return 'explanation';
    }
    if (lowerQuery.includes('strategy') || lowerQuery.includes('approach')) {
      return 'strategy';
    }
    if (lowerQuery.includes('risk') || lowerQuery.includes('safety')) {
      return 'risk_management';
    }
    if (lowerQuery.includes('api') || lowerQuery.includes('integration')) {
      return 'api_integration';
    }
    
    return 'general';
  }

  /**
   * Generate optimization recommendations based on learned patterns
   */
  async generateOptimizations() {
    console.log('🧠 Analyzing patterns for optimization opportunities...');
    
    const optimizations = [];
    
    // Route optimization recommendations
    optimizations.push(...await this.analyzeRouteOptimizations());
    
    // Domain routing optimizations
    optimizations.push(...await this.analyzeDomainOptimizations());
    
    // Performance optimizations
    optimizations.push(...await this.analyzePerformanceOptimizations());
    
    // Store optimizations
    optimizations.forEach(opt => {
      this.optimizations.set(opt.id, opt);
    });
    
    await this.saveOptimizations();
    
    console.log(`💡 Generated ${optimizations.length} optimization recommendations`);
    return optimizations;
  }

  async analyzeRouteOptimizations() {
    const optimizations = [];
    
    // Find patterns where classification confidence is consistently low
    for (const [patternId, pattern] of this.patterns) {
      if (pattern.type === 'classification' && pattern.total_executions >= 10) {
        if (pattern.average_success < 0.7) {
          optimizations.push({
            id: `route_opt_${patternId}`,
            type: 'route_optimization',
            priority: 'high',
            description: `Classification route '${pattern.route}' has low success rate (${(pattern.average_success * 100).toFixed(1)}%)`,
            recommendation: `Consider adjusting triggers for ${pattern.route} or implementing hybrid approach`,
            pattern_id: patternId,
            confidence: 0.8,
            created_at: new Date().toISOString()
          });
        }
      }
    }
    
    return optimizations;
  }

  async analyzeDomainOptimizations() {
    const optimizations = [];
    
    // Find domains with suboptimal routing
    for (const [patternId, pattern] of this.patterns) {
      if (pattern.type === 'domain' && pattern.total_executions >= 5) {
        const routes = Object.entries(pattern.optimal_routes);
        
        if (routes.length > 1) {
          // Find the best performing route
          const bestRoute = routes.reduce((best, current) => 
            current[1].avg_success > best[1].avg_success ? current : best
          );
          
          // If there's a significantly better route, recommend switching
          const otherRoutes = routes.filter(r => r[0] !== bestRoute[0]);
          for (const [routeName, routeData] of otherRoutes) {
            if (bestRoute[1].avg_success - routeData.avg_success > 0.2) {
              optimizations.push({
                id: `domain_opt_${pattern.domain}_${routeName}`,
                type: 'domain_optimization',
                priority: 'medium',
                description: `Domain '${pattern.domain}' performs better with '${bestRoute[0]}' than '${routeName}'`,
                recommendation: `Bias domain '${pattern.domain}' towards route '${bestRoute[0]}'`,
                pattern_id: patternId,
                confidence: 0.7,
                created_at: new Date().toISOString()
              });
            }
          }
        }
      }
    }
    
    return optimizations;
  }

  async analyzePerformanceOptimizations() {
    const optimizations = [];
    
    // Find performance patterns that suggest configuration changes
    for (const [patternId, pattern] of this.patterns) {
      if (pattern.type === 'performance' && pattern.total_executions >= 10) {
        // Check escalation frequency
        const escalationRate = pattern.escalation_frequency / pattern.total_executions;
        
        if (escalationRate > 0.4) {
          optimizations.push({
            id: `perf_opt_escalation_${pattern.search_depth}`,
            type: 'performance_optimization',
            priority: 'high',
            description: `High escalation rate (${(escalationRate * 100).toFixed(1)}%) for search depth '${pattern.search_depth}'`,
            recommendation: `Consider adjusting quality thresholds or default to hybrid search for depth '${pattern.search_depth}'`,
            pattern_id: patternId,
            confidence: 0.8,
            created_at: new Date().toISOString()
          });
        }
        
        // Check if slow queries are more successful
        const fastAvg = pattern.success_by_time.fast.reduce((a, b) => a + b, 0) / pattern.success_by_time.fast.length || 0;
        const slowAvg = pattern.success_by_time.slow.reduce((a, b) => a + b, 0) / pattern.success_by_time.slow.length || 0;
        
        if (slowAvg > fastAvg + 0.2 && pattern.success_by_time.slow.length >= 5) {
          optimizations.push({
            id: `perf_opt_timeout_${pattern.search_depth}`,
            type: 'performance_optimization',
            priority: 'medium',
            description: `Slower queries show higher success rates for depth '${pattern.search_depth}'`,
            recommendation: `Consider increasing timeout for search depth '${pattern.search_depth}'`,
            pattern_id: patternId,
            confidence: 0.6,
            created_at: new Date().toISOString()
          });
        }
      }
    }
    
    return optimizations;
  }

  /**
   * Get learning insights and statistics
   */
  getLearningStats() {
    const stats = {
      total_patterns: this.patterns.size,
      total_query_history: this.queryHistory.length,
      total_optimizations: this.optimizations.size,
      patterns_by_type: {},
      recent_success_rate: 0,
      learning_coverage: {}
    };
    
    // Patterns by type
    for (const [_, pattern] of this.patterns) {
      stats.patterns_by_type[pattern.type] = (stats.patterns_by_type[pattern.type] || 0) + 1;
    }
    
    // Recent success rate (last 100 queries)
    const recentQueries = this.queryHistory.slice(-100);
    if (recentQueries.length > 0) {
      stats.recent_success_rate = recentQueries.reduce((sum, q) => sum + q.success_score, 0) / recentQueries.length;
    }
    
    // Learning coverage by domain
    const domainPatterns = Array.from(this.patterns.values()).filter(p => p.type === 'domain');
    domainPatterns.forEach(pattern => {
      stats.learning_coverage[pattern.domain] = {
        executions: pattern.total_executions,
        avg_execution_time: pattern.average_execution_time
      };
    });
    
    return stats;
  }

  generateId(input) {
    return createHash('sha256').update(input).digest('hex').substring(0, 12);
  }

  async savePatterns() {
    const patterns = Array.from(this.patterns.values());
    await fs.writeFile(this.patternsPath, JSON.stringify(patterns, null, 2));
  }

  async saveQueryHistory() {
    await fs.writeFile(this.queryHistoryPath, JSON.stringify(this.queryHistory, null, 2));
  }

  async saveOptimizations() {
    const optimizations = Array.from(this.optimizations.values());
    await fs.writeFile(this.optimizationsPath, JSON.stringify(optimizations, null, 2));
  }
}

export { PatternExtractor };

// CLI interface for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  const extractor = new PatternExtractor();
  
  const command = process.argv[2] || 'stats';
  
  switch (command) {
    case 'stats':
      const stats = extractor.getLearningStats();
      console.log('\n📊 Learning System Statistics:');
      console.log(JSON.stringify(stats, null, 2));
      break;
      
    case 'optimize':
      const optimizations = await extractor.generateOptimizations();
      console.log('\n💡 Generated Optimizations:');
      optimizations.forEach(opt => {
        console.log(`\n${opt.priority.toUpperCase()}: ${opt.description}`);
        console.log(`   → ${opt.recommendation}`);
        console.log(`   Confidence: ${(opt.confidence * 100).toFixed(0)}%`);
      });
      break;
      
    case 'test':
      // Test with sample data
      await extractor.recordQueryExecution({
        query: "RSI momentum strategy implementation",
        domain_hint: "strategies",
        search_depth: "standard",
        classification: { route: "rag_first", confidence: 0.7 },
        results: [
          { path: "notes/strategies.rsi-momentum.md", score: 0.85 },
          { path: "src/strategies/momentum_strategy.py", score: 0.92 }
        ],
        execution_time: 234,
        escalation_triggered: false,
        timestamp: new Date().toISOString()
      });
      
      console.log('✅ Test query recorded');
      const testStats = extractor.getLearningStats();
      console.log('📊 Updated stats:', testStats);
      break;
      
    default:
      console.log('Usage: node pattern-extractor.mjs [stats|optimize|test]');
  }
}
#!/usr/bin/env node
/**
 * Contextual Intelligence MCP Server - Enhanced multi-backend retrieval with trading context
 */

import fs from 'fs/promises';
import path from 'path';
import { HybridQueryRouter } from './hybrid-router.mjs';
import { PatternExtractor } from '../learning/pattern-extractor.mjs';
import { DynamicRouteOptimizer } from '../learning/route-optimizer.mjs';
import { AgentMemorySystem } from '../learning/agent-memory.mjs';

class ContextualIntelligenceServer {
  constructor() {
    this.router = new HybridQueryRouter();
    this.searchHistory = [];
    this.contextualMemory = new Map();
    this.ragEnabled = false;
    
    // Initialize learning systems
    this.patternExtractor = new PatternExtractor();
    this.routeOptimizer = new DynamicRouteOptimizer();
    this.agentMemory = new AgentMemorySystem();
    
    // Learning configuration
    this.learningEnabled = true;
    this.autoOptimizeEnabled = true;
    this.optimizationInterval = 24 * 60 * 60 * 1000; // 24 hours
    this.lastOptimization = null;
    
    this.initializeRAG();
    this.initializeLearning();
  }

  async initializeRAG() {
    try {
      // Check if RAG database exists (derived from project root, not a hardcoded path)
      const ragBase = process.env.ROUTEKIT_PROJECT_ROOT || process.cwd();
      const ragPath = path.join(ragBase, '.routekit', 'rag', 'index.lancedb');
      await fs.access(ragPath);
      this.ragEnabled = true;
      console.log('✅ RAG system initialized');
    } catch (error) {
      console.warn('⚠️ RAG database not found - using filesystem search only');
      this.ragEnabled = false;
    }
  }

  async initializeLearning() {
    try {
      console.log('🧠 Initializing self-bootstrap learning system...');
      
      // Check for last optimization timestamp
      this.lastOptimization = await this.loadLastOptimizationTime();
      
      // Schedule periodic optimization if enabled
      if (this.autoOptimizeEnabled) {
        this.schedulePeriodicOptimization();
      }
      
      console.log('✅ Self-bootstrap learning system initialized');
      console.log(`📊 Learning enabled: ${this.learningEnabled}`);
      console.log(`⚡ Auto-optimization: ${this.autoOptimizeEnabled}`);
      
    } catch (error) {
      console.error('❌ Failed to initialize learning system:', error.message);
      this.learningEnabled = false;
    }
  }

  async loadLastOptimizationTime() {
    try {
      const optimizationFile = '.routekit/learning/last-optimization.json';
      const data = await fs.readFile(optimizationFile, 'utf-8');
      const { timestamp } = JSON.parse(data);
      return new Date(timestamp);
    } catch (error) {
      return null;
    }
  }

  schedulePeriodicOptimization() {
    const checkInterval = 60 * 60 * 1000; // Check every hour
    
    setInterval(async () => {
      const now = Date.now();
      const lastOptTime = this.lastOptimization ? this.lastOptimization.getTime() : 0;
      
      if (now - lastOptTime >= this.optimizationInterval) {
        console.log('⏰ Triggering periodic route optimization...');
        await this.performAutoOptimization();
      }
    }, checkInterval);
  }

  /**
   * Main contextual query method - implements the contextual_query tool
   */
  async contextualQuery(query, options = {}) {
    const startTime = Date.now();
    
    // Extract options at function scope
    const {
      domain_hint = null,
      search_depth = 'standard',
      require_validation = true
    } = options;
    
    try {
      
      console.log(`🎯 Contextual query: "${query}" [${search_depth}]`);
      if (domain_hint) console.log(`🏷️ Domain hint: ${domain_hint}`);
      
      // Add domain context to search options
      const searchOptions = {
        domain_hint,
        search_depth,
        ...this.getDepthConfiguration(search_depth)
      };
      
      // Apply domain-specific routing adjustments
      if (domain_hint) {
        this.applyDomainContext(searchOptions, domain_hint);
      }
      
      // Execute search via hybrid router
      const searchResults = await this.router.search(query, searchOptions);
      
      // Apply contextual enhancements
      const enhancedResults = await this.applyContextualIntelligence(
        searchResults,
        query,
        domain_hint
      );
      
      // Apply validation if required
      if (require_validation) {
        enhancedResults.validation = await this.validateSources(
          enhancedResults.results.map(r => r.path).filter(Boolean)
        );
      }
      
      // Store in search history for learning
      this.updateSearchHistory(query, domain_hint, enhancedResults);
      
      const totalTime = Date.now() - startTime;
      
      // Record learning data if enabled
      if (this.learningEnabled) {
        await this.recordLearningData(query, options, enhancedResults, totalTime);
      }
      console.log(`✅ Contextual query completed in ${totalTime}ms`);
      
      const finalResults = {
        ...enhancedResults,
        query_metadata: {
          original_query: query,
          domain_hint,
          search_depth,
          total_execution_time: totalTime,
          validation_applied: require_validation,
          contextual_enhancements_applied: true,
          learning_recorded: this.learningEnabled
        }
      };
      
      return finalResults;
      
    } catch (error) {
      console.error('❌ Contextual query failed:', error);
      return {
        results: [],
        metadata: {
          search_type: 'failed',
          error: error.message,
          execution_time: Date.now() - startTime
        },
        query_metadata: {
          original_query: query,
          domain_hint,
          search_depth,
          error: error.message
        }
      };
    }
  }

  getDepthConfiguration(depth) {
    switch (depth) {
      case 'quick':
        return {
          max_results: 3,
          timeout_ms: 150,
          filesystem_weight: 0.8,
          vector_weight: 0.2
        };
      case 'comprehensive':
        return {
          max_results: 15,
          timeout_ms: 1000,
          filesystem_weight: 0.4,
          vector_weight: 0.6,
          include_context: true,
          cross_reference: true
        };
      case 'standard':
      default:
        return {
          max_results: 8,
          timeout_ms: 400,
          filesystem_weight: 0.5,
          vector_weight: 0.5
        };
    }
  }

  applyDomainContext(searchOptions, domain) {
    const domainConfigs = {
      strategies: {
        boost_patterns: ['RSI', 'momentum', 'signal', 'strategy'],
        prefer_sources: ['notes/strategies.*', 'src/strategy/*'],
        risk_awareness: 'high'
      },
      risk: {
        boost_patterns: ['position.siz', 'stop.loss', 'risk', 'drawdown'],
        prefer_sources: ['notes/risk.*', 'src/risk/*'],
        risk_awareness: 'critical',
        require_validation: true
      },
      api: {
        boost_patterns: ['robinhood', 'tradier', 'broker', 'api'],
        prefer_sources: ['notes/api.*', 'src/brokers/*', 'src/api_server.*'],
        risk_awareness: 'medium'
      },
      workflows: {
        boost_patterns: ['workflow', 'process', 'automation'],
        prefer_sources: ['notes/workflows.*', 'scripts/*'],
        risk_awareness: 'low'
      },
      analysis: {
        boost_patterns: ['analysis', 'technical', 'indicator', 'MACD', 'Bollinger'],
        prefer_sources: ['notes/analysis.*', 'src/analysis/*'],
        risk_awareness: 'medium'
      },
      portfolio: {
        boost_patterns: ['portfolio', 'allocation', 'diversification'],
        prefer_sources: ['notes/portfolio.*', 'src/portfolio/*'],
        risk_awareness: 'high'
      },
      options: {
        boost_patterns: ['options', 'spread', 'volatility', 'Greeks'],
        prefer_sources: ['notes/options.*', 'src/options/*'],
        risk_awareness: 'critical'
      }
    };

    if (domainConfigs[domain]) {
      const config = domainConfigs[domain];
      searchOptions.domain_boost_patterns = config.boost_patterns;
      searchOptions.prefer_sources = config.prefer_sources;
      searchOptions.risk_awareness_level = config.risk_awareness;
      
      if (config.require_validation) {
        searchOptions.force_validation = true;
      }
    }
  }

  async applyContextualIntelligence(searchResults, query, domainHint) {
    // Apply domain-specific scoring adjustments
    if (domainHint && searchResults.results) {
      searchResults.results = this.applyDomainScoring(
        searchResults.results,
        domainHint
      );
    }
    
    // Add cross-references and related concepts
    if (searchResults.results && searchResults.results.length > 0) {
      searchResults.cross_references = await this.findCrossReferences(
        searchResults.results,
        query
      );
    }
    
    // Add contextual warnings based on content
    searchResults.contextual_warnings = this.generateContextualWarnings(
      searchResults.results,
      query,
      domainHint
    );
    
    // Add learning signals for future improvements
    searchResults.learning_signals = this.extractLearningSignals(
      searchResults,
      query,
      domainHint
    );
    
    return searchResults;
  }

  applyDomainScoring(results, domain) {
    const domainWeights = {
      strategies: { 'strategies.': 0.3, 'risk.': 0.2, 'analysis.': 0.15 },
      risk: { 'risk.': 0.4, 'strategies.': 0.2, 'decisions.': 0.15 },
      api: { 'api.': 0.3, '/src/': 0.25, 'scripts/': 0.1 },
      analysis: { 'analysis.': 0.3, 'strategies.': 0.2, '/src/analysis': 0.25 }
    };

    if (!domainWeights[domain]) return results;

    return results.map(result => {
      let domainBoost = 0;
      const path = result.path || result.source || '';
      
      for (const [pattern, weight] of Object.entries(domainWeights[domain])) {
        if (path.includes(pattern)) {
          domainBoost += weight;
        }
      }
      
      return {
        ...result,
        score: Math.min((result.score || 0.5) + domainBoost, 1.0),
        domain_boost_applied: domainBoost > 0 ? domainBoost : undefined
      };
    }).sort((a, b) => b.score - a.score);
  }

  async findCrossReferences(results, query) {
    const crossRefs = [];
    
    // Find related concepts from different domains
    for (const result of results.slice(0, 3)) {
      const path = result.path || result.source || '';
      
      if (path.includes('strategies.') && !query.toLowerCase().includes('risk')) {
        crossRefs.push({
          type: 'risk_consideration',
          suggestion: 'Consider reviewing risk management for this strategy',
          domain: 'risk'
        });
      }
      
      if (path.includes('risk.') && !query.toLowerCase().includes('strategy')) {
        crossRefs.push({
          type: 'strategy_application',
          suggestion: 'Check how this applies to current strategies',
          domain: 'strategies'
        });
      }
      
      if (path.includes('api.') && !query.toLowerCase().includes('analysis')) {
        crossRefs.push({
          type: 'analysis_integration',
          suggestion: 'Consider technical analysis integration',
          domain: 'analysis'
        });
      }
    }
    
    return crossRefs.slice(0, 3); // Limit to prevent noise
  }

  generateContextualWarnings(results, query, domain) {
    const warnings = [];
    
    // Trading-specific warnings
    if (domain === 'strategies' || domain === 'risk') {
      warnings.push({
        type: 'trading_disclaimer',
        message: '⚠️ Trading strategies involve financial risk. Validate with paper trading first.',
        severity: 'high'
      });
    }
    
    if (domain === 'options') {
      warnings.push({
        type: 'leverage_warning',
        message: '⚡ Options involve leverage and can result in total loss of investment.',
        severity: 'critical'
      });
    }
    
    // Check for experimental content
    const hasExperimental = results.some(r => 
      (r.content || '').toLowerCase().includes('experimental') ||
      (r.content || '').toLowerCase().includes('untested')
    );
    
    if (hasExperimental) {
      warnings.push({
        type: 'experimental_content',
        message: '🧪 Results contain experimental content. Use with caution.',
        severity: 'medium'
      });
    }
    
    return warnings;
  }

  extractLearningSignals(searchResults, query, domain) {
    return {
      query_classification: searchResults.classification?.route || 'unknown',
      result_quality: this.assessResultQuality(searchResults.results),
      domain_coverage: domain || 'general',
      escalation_triggered: searchResults.metadata?.escalation_triggered || false,
      execution_time: searchResults.metadata?.execution_time || 0,
      timestamp: new Date().toISOString()
    };
  }

  assessResultQuality(results) {
    if (!results || results.length === 0) return 'no_results';
    
    const avgScore = results.reduce((sum, r) => sum + (r.score || 0), 0) / results.length;
    
    if (avgScore >= 0.8) return 'excellent';
    if (avgScore >= 0.6) return 'good';
    if (avgScore >= 0.4) return 'fair';
    return 'poor';
  }

  async validateSources(sources) {
    const validation = {
      validated_sources: 0,
      failed_sources: 0,
      warnings: []
    };
    
    for (const source of sources) {
      try {
        if (source.startsWith('notes/')) {
          // Check if Dendron note exists
          const fullPath = path.resolve(source);
          await fs.access(fullPath);
          validation.validated_sources++;
        } else if (source.startsWith('src/') || source.startsWith('scripts/')) {
          // Check if source file exists
          const fullPath = path.resolve(source);
          await fs.access(fullPath);
          validation.validated_sources++;
        } else {
          validation.warnings.push(`Unknown source type: ${source}`);
        }
      } catch (error) {
        validation.failed_sources++;
        validation.warnings.push(`Source not found: ${source}`);
      }
    }
    
    return validation;
  }

  async recordLearningData(query, options, results, executionTime) {
    try {
      // Prepare learning data structure
      const learningData = {
        query,
        domain_hint: options.domain_hint,
        search_depth: options.search_depth,
        classification: results.classification,
        results: results.results,
        execution_time: executionTime,
        escalation_triggered: results.metadata?.escalation_triggered || false,
        contextual_warnings: results.contextual_warnings || [],
        timestamp: new Date().toISOString()
      };
      
      // Record in pattern extractor
      await this.patternExtractor.recordQueryExecution(learningData);
      
      // Check if auto-optimization should trigger
      const shouldOptimize = await this.shouldTriggerOptimization();
      if (shouldOptimize) {
        console.log('🎯 Triggering learning-based optimization...');
        await this.performAutoOptimization();
      }
      
    } catch (error) {
      console.warn('⚠️ Failed to record learning data:', error.message);
    }
  }

  async shouldTriggerOptimization() {
    // Trigger optimization if:
    // 1. We have enough data (50+ queries)
    // 2. Recent success rate is declining
    // 3. Manual optimization hasn't been run recently
    
    if (this.searchHistory.length < 50) return false;
    
    const recentQueries = this.searchHistory.slice(-20);
    const olderQueries = this.searchHistory.slice(-40, -20);
    
    if (recentQueries.length < 10 || olderQueries.length < 10) return false;
    
    const recentSuccessRate = recentQueries.filter(q => q.quality === 'good' || q.quality === 'excellent').length / recentQueries.length;
    const olderSuccessRate = olderQueries.filter(q => q.quality === 'good' || q.quality === 'excellent').length / olderQueries.length;
    
    // If success rate dropped by more than 15%, trigger optimization
    return (olderSuccessRate - recentSuccessRate) > 0.15;
  }

  async performAutoOptimization() {
    try {
      console.log('🧠 Performing automatic system optimization...');
      
      const optimizationResults = await this.routeOptimizer.optimizeRouting();
      
      if (optimizationResults.applied > 0) {
        console.log(`✅ Applied ${optimizationResults.applied} optimizations`);
        
        // Reload router configuration
        await this.router.loadConfiguration();
        
        // Record optimization timestamp
        this.lastOptimization = new Date();
        await this.saveOptimizationTimestamp();
      }
      
    } catch (error) {
      console.error('❌ Auto-optimization failed:', error.message);
    }
  }

  async saveOptimizationTimestamp() {
    try {
      await fs.mkdir('.routekit/learning', { recursive: true });
      const optimizationFile = '.routekit/learning/last-optimization.json';
      await fs.writeFile(optimizationFile, JSON.stringify({ 
        timestamp: this.lastOptimization.toISOString() 
      }));
    } catch (error) {
      console.warn('⚠️ Failed to save optimization timestamp:', error.message);
    }
  }

  updateSearchHistory(query, domain, results) {
    const historyEntry = {
      query,
      domain,
      result_count: results.results?.length || 0,
      quality: this.assessResultQuality(results.results),
      timestamp: new Date().toISOString()
    };
    
    this.searchHistory.push(historyEntry);
    
    // Keep only last 100 queries
    if (this.searchHistory.length > 100) {
      this.searchHistory.shift();
    }
    
    // Update contextual memory for learning
    const contextKey = `${domain || 'general'}:${query.toLowerCase().substring(0, 50)}`;
    this.contextualMemory.set(contextKey, {
      success_rate: this.calculateSuccessRate(domain),
      last_query: new Date().toISOString(),
      result_patterns: this.extractResultPatterns(results.results)
    });
  }

  calculateSuccessRate(domain) {
    const domainQueries = this.searchHistory.filter(h => h.domain === domain);
    if (domainQueries.length === 0) return 0;
    
    const successful = domainQueries.filter(h => 
      h.result_count > 0 && ['good', 'excellent'].includes(h.quality)
    );
    
    return successful.length / domainQueries.length;
  }

  extractResultPatterns(results) {
    if (!results || results.length === 0) return [];
    
    const patterns = [];
    const sources = results.map(r => r.path || r.source || '').filter(Boolean);
    
    // Find common source patterns
    const sourceTypes = {};
    sources.forEach(source => {
      if (source.includes('strategies.')) sourceTypes.strategies = (sourceTypes.strategies || 0) + 1;
      if (source.includes('risk.')) sourceTypes.risk = (sourceTypes.risk || 0) + 1;
      if (source.includes('api.')) sourceTypes.api = (sourceTypes.api || 0) + 1;
      if (source.includes('/src/')) sourceTypes.code = (sourceTypes.code || 0) + 1;
    });
    
    return Object.entries(sourceTypes).map(([type, count]) => ({ type, count }));
  }

  /**
   * Get server status and statistics
   */
  getStatus() {
    const learningStats = this.learningEnabled ? this.patternExtractor.getLearningStats() : null;
    const memoryStats = this.learningEnabled ? this.agentMemory.getMemoryStats() : null;
    
    return {
      router_loaded: !!this.router,
      rag_enabled: this.ragEnabled,
      learning_enabled: this.learningEnabled,
      auto_optimization_enabled: this.autoOptimizeEnabled,
      search_history_size: this.searchHistory.length,
      contextual_memory_size: this.contextualMemory.size,
      last_query: this.searchHistory[this.searchHistory.length - 1]?.timestamp,
      last_optimization: this.lastOptimization?.toISOString() || null,
      success_rate: this.calculateOverallSuccessRate(),
      learning_system: learningStats ? {
        total_patterns: learningStats.total_patterns,
        recent_success_rate: learningStats.recent_success_rate,
        patterns_by_type: learningStats.patterns_by_type
      } : null,
      agent_memory: memoryStats ? {
        total_agents: memoryStats.total_agents,
        active_sessions: memoryStats.active_sessions,
        total_interactions: memoryStats.total_interactions
      } : null
    };
  }

  calculateOverallSuccessRate() {
    if (this.searchHistory.length === 0) return 0;
    
    const successful = this.searchHistory.filter(h => 
      h.result_count > 0 && ['good', 'excellent'].includes(h.quality)
    );
    
    return successful.length / this.searchHistory.length;
  }
}

// Export for MCP integration
export { ContextualIntelligenceServer };

// CLI interface for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new ContextualIntelligenceServer();
  
  const query = process.argv[2] || "RSI momentum strategy implementation";
  const domain = process.argv[3] || "strategies";
  
  console.log(`Testing contextual query: "${query}" [${domain}]`);
  
  try {
    const results = await server.contextualQuery(query, {
      domain_hint: domain,
      search_depth: 'standard',
      require_validation: true
    });
    
    console.log('\n📊 Results:');
    console.log(`Found ${results.results?.length || 0} results`);
    console.log(`Execution time: ${results.query_metadata?.total_execution_time}ms`);
    console.log(`Classification: ${results.classification?.route}`);
    
    if (results.results && results.results.length > 0) {
      console.log('\n🎯 Top Results:');
      results.results.slice(0, 3).forEach((result, i) => {
        console.log(`${i + 1}. ${result.path} (score: ${result.score?.toFixed(2)})`);
        console.log(`   ${result.content?.substring(0, 100)}...`);
      });
    }
    
    if (results.contextual_warnings?.length > 0) {
      console.log('\n⚠️ Warnings:');
      results.contextual_warnings.forEach(warning => {
        console.log(`   ${warning.message}`);
      });
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}
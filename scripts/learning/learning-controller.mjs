#!/usr/bin/env node
/**
 * Learning System Controller - Orchestrates the complete self-bootstrap learning system
 * for continuous improvement of the trading system intelligence
 */

import fs from 'fs/promises';
import path from 'path';
import { PatternExtractor } from './pattern-extractor.mjs';
import { DynamicRouteOptimizer } from './route-optimizer.mjs';
import { AgentMemorySystem } from './agent-memory.mjs';

class LearningController {
  constructor(options = {}) {
    this.configPath = options.configPath || '.routekit';
    this.learningPath = path.join(this.configPath, 'learning');
    
    // Initialize learning components
    this.patternExtractor = new PatternExtractor();
    this.routeOptimizer = new DynamicRouteOptimizer();
    this.agentMemory = new AgentMemorySystem();
    
    // Learning configuration
    this.config = {
      auto_learning: true,
      optimization_interval: 24 * 60 * 60 * 1000, // 24 hours
      pattern_extraction_threshold: 10, // Minimum queries before pattern extraction
      optimization_threshold: 0.15, // Performance decline threshold
      max_optimizations_per_day: 3,
      learning_retention_days: 30
    };
    
    this.initializeController();
  }

  async initializeController() {
    try {
      await fs.mkdir(this.learningPath, { recursive: true });
      
      // Load configuration
      await this.loadConfiguration();
      
      // Initialize monitoring
      this.startPerformanceMonitoring();
      
      console.log('✅ Learning system controller initialized');
      
    } catch (error) {
      console.error('❌ Failed to initialize learning controller:', error.message);
    }
  }

  async loadConfiguration() {
    try {
      const configFile = path.join(this.learningPath, 'learning-config.json');
      const data = await fs.readFile(configFile, 'utf-8');
      const loadedConfig = JSON.parse(data);
      
      // Merge with defaults
      this.config = { ...this.config, ...loadedConfig };
      
      console.log('📊 Learning configuration loaded');
    } catch (error) {
      // Use defaults
      console.log('🆕 Using default learning configuration');
      await this.saveConfiguration();
    }
  }

  async saveConfiguration() {
    const configFile = path.join(this.learningPath, 'learning-config.json');
    await fs.writeFile(configFile, JSON.stringify(this.config, null, 2));
  }

  /**
   * Record a complete trading system interaction for learning
   */
  async recordSystemInteraction(interactionData) {
    try {
      const {
        query,
        agent_id,
        domain,
        context,
        results,
        success,
        execution_time,
        learning_signals = {}
      } = interactionData;

      // Record query pattern learning
      if (query) {
        await this.patternExtractor.recordQueryExecution({
          query,
          domain_hint: domain,
          results: results?.results || results,
          classification: results?.classification,
          execution_time,
          escalation_triggered: results?.escalation_triggered || false,
          timestamp: new Date().toISOString()
        });
      }

      // Record agent memory if agent is specified
      if (agent_id) {
        let sessionId = await this.getOrCreateAgentSession(agent_id, domain);
        
        await this.agentMemory.recordInteraction(sessionId, {
          type: this.classifyInteractionType(query, context),
          domain,
          input: query || context?.task_description || 'Unknown task',
          output: this.formatOutput(results),
          success,
          execution_time,
          learning_signals,
          metadata: {
            context_used: context?.context_used || [],
            trading_warnings: results?.contextual_warnings || []
          }
        });
      }

      // Check if learning threshold is met
      await this.checkLearningThresholds();
      
    } catch (error) {
      console.warn('⚠️ Failed to record system interaction:', error.message);
    }
  }

  async getOrCreateAgentSession(agentId, domain) {
    // Check if agent has an active session
    const activeSessionId = this.findActiveSession(agentId);
    
    if (activeSessionId) {
      return activeSessionId;
    }
    
    // Create new session
    return await this.agentMemory.createSession(agentId, {
      domain,
      task_type: 'trading_assistance',
      initial_state: { created_via: 'learning_controller' }
    });
  }

  findActiveSession(agentId) {
    // In a real implementation, this would check active sessions
    // For now, we'll create a new session each time
    return null;
  }

  classifyInteractionType(query, context) {
    if (!query && !context) return 'general';
    
    const text = (query || context?.task_description || '').toLowerCase();
    
    if (text.includes('strategy') || text.includes('rsi') || text.includes('momentum')) {
      return 'strategy_query';
    }
    if (text.includes('risk') || text.includes('position') || text.includes('sizing')) {
      return 'risk_query';
    }
    if (text.includes('api') || text.includes('robinhood') || text.includes('tradier')) {
      return 'api_query';
    }
    if (text.includes('test') || text.includes('validate')) {
      return 'testing_query';
    }
    
    return 'general_query';
  }

  formatOutput(results) {
    if (!results) return 'No results';
    
    if (typeof results === 'string') return results;
    
    if (results.results && Array.isArray(results.results)) {
      return `Found ${results.results.length} results: ${results.results.slice(0, 3).map(r => r.path || r.source || 'Unknown').join(', ')}`;
    }
    
    return JSON.stringify(results).substring(0, 200);
  }

  async checkLearningThresholds() {
    const stats = this.patternExtractor.getLearningStats();
    
    // Check if we should trigger optimization
    if (stats.total_query_history >= this.config.pattern_extraction_threshold) {
      const shouldOptimize = await this.shouldTriggerLearningOptimization();
      
      if (shouldOptimize) {
        console.log('🎯 Learning threshold met - triggering optimization');
        await this.performLearningOptimization();
      }
    }
  }

  async shouldTriggerLearningOptimization() {
    const stats = this.patternExtractor.getLearningStats();
    
    // Don't optimize if success rate is already high
    if (stats.recent_success_rate >= 0.85) {
      console.log(`✅ Performance is good (${(stats.recent_success_rate * 100).toFixed(0)}%) - no optimization needed`);
      return false;
    }
    
    // Check optimization frequency limits
    const optimizationHistory = await this.getOptimizationHistory();
    const recentOptimizations = optimizationHistory.filter(opt => {
      const age = Date.now() - new Date(opt.timestamp).getTime();
      return age < 24 * 60 * 60 * 1000; // Last 24 hours
    });
    
    if (recentOptimizations.length >= this.config.max_optimizations_per_day) {
      console.log(`⏰ Already performed ${recentOptimizations.length} optimizations today - waiting`);
      return false;
    }
    
    // Trigger if performance is declining or below threshold
    return stats.recent_success_rate < 0.70;
  }

  async performLearningOptimization() {
    try {
      console.log('🧠 Performing comprehensive learning optimization...');
      
      const startTime = Date.now();
      
      // Generate and apply optimizations
      const optimizations = await this.patternExtractor.generateOptimizations();
      const routeResults = await this.routeOptimizer.optimizeRouting();
      
      // Record optimization
      const optimizationRecord = {
        timestamp: new Date().toISOString(),
        trigger: 'learning_threshold',
        patterns_analyzed: optimizations.length,
        route_optimizations_applied: routeResults.applied,
        execution_time: Date.now() - startTime,
        performance_before: this.patternExtractor.getLearningStats().recent_success_rate,
        recommendations: optimizations.map(opt => ({
          type: opt.type,
          priority: opt.priority,
          confidence: opt.confidence
        }))
      };
      
      await this.recordOptimization(optimizationRecord);
      
      console.log(`✅ Learning optimization complete: ${routeResults.applied} route changes applied`);
      
      return optimizationRecord;
      
    } catch (error) {
      console.error('❌ Learning optimization failed:', error.message);
      return null;
    }
  }

  async getOptimizationHistory() {
    try {
      const historyFile = path.join(this.learningPath, 'optimization-history.json');
      const data = await fs.readFile(historyFile, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      return [];
    }
  }

  async recordOptimization(record) {
    const history = await this.getOptimizationHistory();
    history.push(record);
    
    // Keep only recent optimizations
    const cutoffTime = Date.now() - (this.config.learning_retention_days * 24 * 60 * 60 * 1000);
    const filteredHistory = history.filter(opt => 
      new Date(opt.timestamp).getTime() > cutoffTime
    );
    
    const historyFile = path.join(this.learningPath, 'optimization-history.json');
    await fs.writeFile(historyFile, JSON.stringify(filteredHistory, null, 2));
  }

  startPerformanceMonitoring() {
    // Monitor every hour
    setInterval(async () => {
      await this.performPerformanceCheck();
    }, 60 * 60 * 1000);
    
    console.log('📊 Performance monitoring started');
  }

  async performPerformanceCheck() {
    try {
      const stats = this.patternExtractor.getLearningStats();
      const memoryStats = this.agentMemory.getMemoryStats();
      
      // Log performance metrics
      console.log(`📈 Performance Check - Success Rate: ${(stats.recent_success_rate * 100).toFixed(1)}%, Agents: ${memoryStats.total_agents}, Interactions: ${memoryStats.total_interactions}`);
      
      // Check for performance issues
      if (stats.recent_success_rate < 0.60) {
        console.warn('⚠️ Low success rate detected - may need manual intervention');
      }
      
      // Cleanup old data
      await this.cleanupOldLearningData();
      
    } catch (error) {
      console.warn('⚠️ Performance check failed:', error.message);
    }
  }

  async cleanupOldLearningData() {
    try {
      // This would clean up old pattern data, session files, etc.
      // Implementation depends on specific cleanup policies
      
      const cutoffTime = Date.now() - (this.config.learning_retention_days * 24 * 60 * 60 * 1000);
      
      // Cleanup would go here - for now just log
      console.log(`🧹 Cleanup check completed (retention: ${this.config.learning_retention_days} days)`);
      
    } catch (error) {
      console.warn('⚠️ Learning data cleanup failed:', error.message);
    }
  }

  /**
   * Get comprehensive learning system status
   */
  async getSystemStatus() {
    const patternStats = this.patternExtractor.getLearningStats();
    const memoryStats = this.agentMemory.getMemoryStats();
    const optimizationHistory = await this.getOptimizationHistory();
    
    const recentOptimizations = optimizationHistory.filter(opt => {
      const age = Date.now() - new Date(opt.timestamp).getTime();
      return age < 7 * 24 * 60 * 60 * 1000; // Last 7 days
    });
    
    return {
      status: 'operational',
      configuration: this.config,
      performance: {
        recent_success_rate: patternStats.recent_success_rate,
        total_patterns_learned: patternStats.total_patterns,
        total_query_history: patternStats.total_query_history,
        pattern_types: patternStats.patterns_by_type
      },
      agent_memory: {
        total_agents: memoryStats.total_agents,
        active_sessions: memoryStats.active_sessions,
        total_interactions: memoryStats.total_interactions
      },
      optimization_activity: {
        recent_optimizations: recentOptimizations.length,
        last_optimization: recentOptimizations[recentOptimizations.length - 1]?.timestamp || null,
        optimization_success_rate: recentOptimizations.filter(opt => opt.route_optimizations_applied > 0).length / Math.max(recentOptimizations.length, 1)
      },
      system_health: this.assessSystemHealth(patternStats, memoryStats, recentOptimizations)
    };
  }

  assessSystemHealth(patternStats, memoryStats, recentOptimizations) {
    const health = {
      overall: 'healthy',
      issues: [],
      recommendations: []
    };
    
    // Check success rate
    if (patternStats.recent_success_rate < 0.60) {
      health.overall = 'degraded';
      health.issues.push('Low query success rate');
      health.recommendations.push('Review query patterns and routing logic');
    } else if (patternStats.recent_success_rate < 0.75) {
      health.overall = 'monitoring';
      health.recommendations.push('Monitor query performance trends');
    }
    
    // Check learning data volume
    if (patternStats.total_query_history < 20) {
      health.recommendations.push('Increase usage to improve learning effectiveness');
    }
    
    // Check optimization effectiveness
    const successfulOptimizations = recentOptimizations.filter(opt => opt.route_optimizations_applied > 0);
    if (recentOptimizations.length > 3 && successfulOptimizations.length === 0) {
      health.issues.push('Recent optimizations had no effect');
      health.overall = 'monitoring';
    }
    
    return health;
  }

  /**
   * Force immediate system optimization
   */
  async forceOptimization(reason = 'manual_trigger') {
    console.log(`🔧 Force optimization triggered: ${reason}`);
    
    const result = await this.performLearningOptimization();
    
    if (result) {
      result.trigger = reason;
      await this.recordOptimization(result);
    }
    
    return result;
  }

  /**
   * Reset learning system (for testing or recovery)
   */
  async resetLearningSystem() {
    console.log('🔄 Resetting learning system...');
    
    try {
      // Backup current state
      const backupPath = path.join(this.learningPath, `backup-${Date.now()}`);
      await fs.mkdir(backupPath, { recursive: true });
      
      // Move current learning data to backup
      const files = await fs.readdir(this.learningPath);
      for (const file of files) {
        if (file.endsWith('.json') && !file.startsWith('backup-')) {
          await fs.rename(
            path.join(this.learningPath, file),
            path.join(backupPath, file)
          );
        }
      }
      
      console.log(`✅ Learning system reset - backup saved to ${backupPath}`);
      
    } catch (error) {
      console.error('❌ Failed to reset learning system:', error.message);
    }
  }
}

export { LearningController };

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const controller = new LearningController();
  
  const command = process.argv[2] || 'status';
  
  switch (command) {
    case 'status':
      const status = await controller.getSystemStatus();
      console.log('\n🧠 Learning System Status:');
      console.log(JSON.stringify(status, null, 2));
      break;
      
    case 'optimize':
      const result = await controller.forceOptimization('manual_cli');
      console.log('\n🎯 Optimization Result:');
      console.log(JSON.stringify(result, null, 2));
      break;
      
    case 'test':
      // Test system interaction recording
      await controller.recordSystemInteraction({
        query: 'RSI momentum strategy performance analysis',
        agent_id: 'test-trading-agent',
        domain: 'strategies',
        success: true,
        execution_time: 456,
        results: {
          results: [
            { path: 'notes/strategies.rsi-momentum.md', score: 0.89 },
            { path: 'src/strategies/momentum_strategy.py', score: 0.94 }
          ],
          classification: { route: 'hybrid', confidence: 0.82 }
        },
        learning_signals: {
          pattern_type: 'strategy_analysis',
          approach: 'multi_source_validation',
          success_factors: ['code_and_docs', 'high_confidence']
        }
      });
      
      console.log('✅ Test interaction recorded');
      
      const testStatus = await controller.getSystemStatus();
      console.log('\n📊 Updated System Status:');
      console.log(JSON.stringify(testStatus.performance, null, 2));
      break;
      
    case 'reset':
      await controller.resetLearningSystem();
      break;
      
    default:
      console.log('Usage: node learning-controller.mjs [status|optimize|test|reset]');
  }
}
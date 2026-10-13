#!/usr/bin/env node
/**
 * Dynamic Route Optimizer - Updates routing configurations based on learned patterns
 * to improve query classification and search performance
 */

import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import { PatternExtractor } from './pattern-extractor.mjs';

class DynamicRouteOptimizer {
  constructor(options = {}) {
    this.configPath = options.configPath || '.routekit';
    this.routerConfigPath = path.join(this.configPath, 'retrieval.router.yaml');
    this.policiesConfigPath = path.join(this.configPath, 'policy.guardrails.yaml');
    this.toolsConfigPath = path.join(this.configPath, 'tools.schema.yaml');
    this.backupPath = path.join(this.configPath, 'backups');
    
    this.patternExtractor = new PatternExtractor();
    this.optimizationHistory = [];
    
    this.initializeOptimizer();
  }

  async initializeOptimizer() {
    try {
      await fs.mkdir(this.backupPath, { recursive: true });
      console.log('✅ Route optimizer initialized');
    } catch (error) {
      console.error('❌ Failed to initialize route optimizer:', error.message);
    }
  }

  /**
   * Analyze patterns and apply optimizations to routing configuration
   */
  async optimizeRouting() {
    console.log('🧠 Starting dynamic route optimization...');
    
    // Generate optimizations from patterns
    const optimizations = await this.patternExtractor.generateOptimizations();
    
    if (optimizations.length === 0) {
      console.log('✅ No optimizations needed - system is performing well');
      return { applied: 0, skipped: 0, failed: 0 };
    }
    
    // Backup current configurations
    await this.backupConfigurations();
    
    const results = {
      applied: 0,
      skipped: 0,
      failed: 0,
      optimizations: []
    };
    
    // Apply optimizations by priority
    const sortedOptimizations = optimizations.sort((a, b) => {
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });
    
    for (const optimization of sortedOptimizations) {
      try {
        const applied = await this.applyOptimization(optimization);
        
        if (applied) {
          results.applied++;
          console.log(`✅ Applied: ${optimization.description}`);
        } else {
          results.skipped++;
          console.log(`⏭️ Skipped: ${optimization.description}`);
        }
        
        results.optimizations.push({
          ...optimization,
          applied,
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        results.failed++;
        console.error(`❌ Failed to apply: ${optimization.description}`, error.message);
        
        results.optimizations.push({
          ...optimization,
          applied: false,
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    }
    
    // Save optimization history
    await this.saveOptimizationHistory(results);
    
    console.log(`🎯 Optimization complete: ${results.applied} applied, ${results.skipped} skipped, ${results.failed} failed`);
    
    return results;
  }

  async applyOptimization(optimization) {
    switch (optimization.type) {
      case 'route_optimization':
        return await this.applyRouteOptimization(optimization);
      case 'domain_optimization':
        return await this.applyDomainOptimization(optimization);
      case 'performance_optimization':
        return await this.applyPerformanceOptimization(optimization);
      default:
        console.warn(`Unknown optimization type: ${optimization.type}`);
        return false;
    }
  }

  async applyRouteOptimization(optimization) {
    // Load current router configuration
    const routerConfig = await this.loadRouterConfig();
    
    // Extract route from pattern ID
    const routeMatch = optimization.pattern_id.match(/classification_(.+)/);
    if (!routeMatch) return false;
    
    const route = routeMatch[1];
    
    // Apply optimization based on the specific issue
    if (optimization.description.includes('low success rate')) {
      // Lower confidence thresholds or adjust triggers
      if (route === 'fs_first') {
        // Make filesystem triggers more specific
        const fsTriggers = routerConfig.routing.fs_triggers;
        
        // Add more specific patterns to reduce false positives
        fsTriggers.push({
          regex: '(class\\s+\\w+|def\\s+\\w+|import\\s+\\w+)\\s*\\(',
          confidence_boost: 0.1
        });
        
        // Add trading-specific code patterns
        fsTriggers.push({
          contains_any: ['_implementation', 'calculate_', 'execute_'],
          confidence_boost: 0.15
        });
        
      } else if (route === 'rag_first') {
        // Make RAG triggers more inclusive
        const ragTriggers = routerConfig.routing.rag_triggers;
        
        // Add more conceptual query patterns
        ragTriggers.push({
          contains_any: ['best practices', 'lessons learned', 'experience', 'advice'],
          confidence_boost: 0.1
        });
        
        // Lower minimum word count for complex queries
        const minWordsTrigger = ragTriggers.find(t => t.min_words);
        if (minWordsTrigger) {
          minWordsTrigger.min_words = Math.max(4, minWordsTrigger.min_words - 1);
        }
      }
      
      await this.saveRouterConfig(routerConfig);
      return true;
    }
    
    return false;
  }

  async applyDomainOptimization(optimization) {
    // Extract domain and route from optimization
    const domainMatch = optimization.id.match(/domain_opt_(.+)_(.+)/);
    if (!domainMatch) return false;
    
    const [, domain, suboptimalRoute] = domainMatch;
    const recommendedRoute = optimization.recommendation.match(/route '(.+)'/)?.[1];
    
    if (!recommendedRoute) return false;
    
    // Load tools configuration to update agent routing
    const toolsConfig = await this.loadToolsConfig();
    
    // Update agent routing rules based on domain performance
    if (toolsConfig.agent_routing && toolsConfig.agent_routing.patterns) {
      const domainPattern = this.findDomainPattern(toolsConfig.agent_routing.patterns, domain);
      
      if (domainPattern) {
        // Add route preference to domain pattern
        domainPattern.preferred_route = recommendedRoute;
        domainPattern.confidence_boost = 0.2;
        domainPattern.optimized_at = new Date().toISOString();
      }
    }
    
    // Update routing configuration
    const routerConfig = await this.loadRouterConfig();
    
    // Add domain-specific routing bias
    if (!routerConfig.domain_bias) {
      routerConfig.domain_bias = {};
    }
    
    routerConfig.domain_bias[domain] = {
      preferred_route: recommendedRoute,
      confidence_adjustment: 0.15,
      reason: `Learned from usage patterns - ${recommendedRoute} performs better`,
      optimized_at: new Date().toISOString()
    };
    
    await this.saveRouterConfig(routerConfig);
    await this.saveToolsConfig(toolsConfig);
    
    return true;
  }

  async applyPerformanceOptimization(optimization) {
    const routerConfig = await this.loadRouterConfig();
    
    if (optimization.description.includes('High escalation rate')) {
      const searchDepth = optimization.pattern_id.match(/performance_(.+)/)?.[1];
      if (!searchDepth) return false;
      
      // Adjust thresholds to reduce unnecessary escalations
      if (searchDepth === 'standard') {
        routerConfig.thresholds.escalate_if_fewer_than_hits = Math.max(2, routerConfig.thresholds.escalate_if_fewer_than_hits - 1);
        routerConfig.thresholds.lexical_score_min = Math.max(0.4, routerConfig.thresholds.lexical_score_min - 0.05);
        routerConfig.thresholds.semantic_score_min = Math.max(0.5, routerConfig.thresholds.semantic_score_min - 0.05);
      }
      
      // Add note about optimization
      if (!routerConfig.optimization_notes) {
        routerConfig.optimization_notes = [];
      }
      
      routerConfig.optimization_notes.push({
        timestamp: new Date().toISOString(),
        change: 'Reduced escalation sensitivity',
        reason: optimization.description,
        depth: searchDepth
      });
      
      await this.saveRouterConfig(routerConfig);
      return true;
    }
    
    if (optimization.description.includes('Slower queries show higher success')) {
      const searchDepth = optimization.pattern_id.match(/performance_(.+)/)?.[1];
      if (!searchDepth) return false;
      
      // Increase timeout for this search depth
      const budgetKey = searchDepth === 'quick' ? 'fs_first' : 
                        searchDepth === 'comprehensive' ? 'rag_first' : 'fs_first';
      
      if (routerConfig.budget[budgetKey]) {
        routerConfig.budget[budgetKey].time_ms = Math.min(
          routerConfig.budget[budgetKey].time_ms * 1.3, 
          2000
        );
      }
      
      if (!routerConfig.optimization_notes) {
        routerConfig.optimization_notes = [];
      }
      
      routerConfig.optimization_notes.push({
        timestamp: new Date().toISOString(),
        change: 'Increased timeout',
        reason: optimization.description,
        depth: searchDepth,
        new_timeout: routerConfig.budget[budgetKey]?.time_ms
      });
      
      await this.saveRouterConfig(routerConfig);
      return true;
    }
    
    return false;
  }

  findDomainPattern(patterns, domain) {
    const domainMappings = {
      strategies: ['strategy_queries', 'technical_analysis'],
      risk: ['risk_queries'],
      api: ['api_queries'],
      analysis: ['technical_analysis']
    };
    
    const possiblePatterns = domainMappings[domain] || [domain];
    
    for (const patternName of possiblePatterns) {
      if (patterns[patternName]) {
        return patterns[patternName];
      }
    }
    
    return null;
  }

  async backupConfigurations() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    try {
      // Backup router config
      const routerConfig = await fs.readFile(this.routerConfigPath, 'utf-8');
      await fs.writeFile(
        path.join(this.backupPath, `retrieval.router.${timestamp}.yaml`),
        routerConfig
      );
      
      // Backup policies config
      const policiesConfig = await fs.readFile(this.policiesConfigPath, 'utf-8');
      await fs.writeFile(
        path.join(this.backupPath, `policy.guardrails.${timestamp}.yaml`),
        policiesConfig
      );
      
      // Backup tools config
      const toolsConfig = await fs.readFile(this.toolsConfigPath, 'utf-8');
      await fs.writeFile(
        path.join(this.backupPath, `tools.schema.${timestamp}.yaml`),
        toolsConfig
      );
      
      console.log(`💾 Configurations backed up with timestamp: ${timestamp}`);
    } catch (error) {
      console.warn('⚠️ Failed to backup configurations:', error.message);
    }
  }

  async loadRouterConfig() {
    const data = await fs.readFile(this.routerConfigPath, 'utf-8');
    return yaml.load(data);
  }

  async saveRouterConfig(config) {
    const yamlData = yaml.dump(config, { 
      defaultFlowStyle: false, 
      quotingType: '"', 
      forceQuotes: false 
    });
    await fs.writeFile(this.routerConfigPath, yamlData);
  }

  async loadToolsConfig() {
    const data = await fs.readFile(this.toolsConfigPath, 'utf-8');
    return yaml.load(data);
  }

  async saveToolsConfig(config) {
    const yamlData = yaml.dump(config, { 
      defaultFlowStyle: false, 
      quotingType: '"', 
      forceQuotes: false 
    });
    await fs.writeFile(this.toolsConfigPath, yamlData);
  }

  async saveOptimizationHistory(results) {
    this.optimizationHistory.push({
      timestamp: new Date().toISOString(),
      ...results
    });
    
    // Keep only last 50 optimization runs
    if (this.optimizationHistory.length > 50) {
      this.optimizationHistory = this.optimizationHistory.slice(-50);
    }
    
    const historyPath = path.join(this.configPath, 'learning', 'optimization-history.json');
    await fs.writeFile(historyPath, JSON.stringify(this.optimizationHistory, null, 2));
  }

  /**
   * Revert the last set of optimizations if performance degraded
   */
  async revertLastOptimizations() {
    if (this.optimizationHistory.length === 0) {
      console.log('❌ No optimization history to revert');
      return false;
    }
    
    const lastOptimization = this.optimizationHistory[this.optimizationHistory.length - 1];
    const timestamp = lastOptimization.timestamp.replace(/[:.]/g, '-');
    
    try {
      // Restore from backups
      const routerBackup = path.join(this.backupPath, `retrieval.router.${timestamp}.yaml`);
      const policiesBackup = path.join(this.backupPath, `policy.guardrails.${timestamp}.yaml`);
      const toolsBackup = path.join(this.backupPath, `tools.schema.${timestamp}.yaml`);
      
      if (await this.fileExists(routerBackup)) {
        await fs.copyFile(routerBackup, this.routerConfigPath);
        console.log('✅ Reverted router configuration');
      }
      
      if (await this.fileExists(policiesBackup)) {
        await fs.copyFile(policiesBackup, this.policiesConfigPath);
        console.log('✅ Reverted policies configuration');
      }
      
      if (await this.fileExists(toolsBackup)) {
        await fs.copyFile(toolsBackup, this.toolsConfigPath);
        console.log('✅ Reverted tools configuration');
      }
      
      // Mark optimization as reverted
      lastOptimization.reverted_at = new Date().toISOString();
      await this.saveOptimizationHistory({ reverted: true });
      
      console.log(`🔄 Successfully reverted optimizations from ${lastOptimization.timestamp}`);
      return true;
      
    } catch (error) {
      console.error('❌ Failed to revert optimizations:', error.message);
      return false;
    }
  }

  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get optimization statistics and performance metrics
   */
  getOptimizationStats() {
    const stats = {
      total_optimizations_applied: 0,
      optimization_types: {},
      recent_performance: null,
      revert_count: 0
    };
    
    this.optimizationHistory.forEach(run => {
      stats.total_optimizations_applied += run.applied || 0;
      
      if (run.reverted) {
        stats.revert_count++;
      }
      
      if (run.optimizations) {
        run.optimizations.forEach(opt => {
          if (opt.applied) {
            stats.optimization_types[opt.type] = (stats.optimization_types[opt.type] || 0) + 1;
          }
        });
      }
    });
    
    // Get recent performance from pattern extractor
    stats.recent_performance = this.patternExtractor.getLearningStats();
    
    return stats;
  }
}

export { DynamicRouteOptimizer };

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const optimizer = new DynamicRouteOptimizer();
  
  const command = process.argv[2] || 'optimize';
  
  switch (command) {
    case 'optimize':
      const results = await optimizer.optimizeRouting();
      console.log('\n🎯 Optimization Results:');
      console.log(JSON.stringify(results, null, 2));
      break;
      
    case 'revert':
      const reverted = await optimizer.revertLastOptimizations();
      console.log(reverted ? '✅ Optimizations reverted' : '❌ Revert failed');
      break;
      
    case 'stats':
      const stats = optimizer.getOptimizationStats();
      console.log('\n📊 Optimization Statistics:');
      console.log(JSON.stringify(stats, null, 2));
      break;
      
    default:
      console.log('Usage: node route-optimizer.mjs [optimize|revert|stats]');
  }
}
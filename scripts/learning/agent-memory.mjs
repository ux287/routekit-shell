#!/usr/bin/env node
/**
 * Agent Memory Persistence System - Maintains agent context and learning across sessions
 * for improved trading decision-making and contextual understanding
 */

import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';

class AgentMemorySystem {
  constructor(options = {}) {
    this.memoryPath = options.memoryPath || '.routekit/learning/agent-memory';
    this.sessionPath = path.join(this.memoryPath, 'sessions');
    this.persistentPath = path.join(this.memoryPath, 'persistent');
    this.contextPath = path.join(this.memoryPath, 'context');
    
    this.activeSessions = new Map();
    this.persistentMemory = new Map();
    this.contextCache = new Map();
    
    this.maxSessionAge = 24 * 60 * 60 * 1000; // 24 hours
    this.maxContextSize = 100; // Max context entries per agent
    
    this.initializeMemorySystem();
  }

  async initializeMemorySystem() {
    try {
      // Create directory structure
      await fs.mkdir(this.sessionPath, { recursive: true });
      await fs.mkdir(this.persistentPath, { recursive: true });
      await fs.mkdir(this.contextPath, { recursive: true });
      
      // Load existing memory
      await this.loadPersistentMemory();
      await this.loadActiveSessions();
      await this.loadContextCache();
      
      // Clean up old sessions
      await this.cleanupOldSessions();
      
      console.log('✅ Agent memory system initialized');
      console.log(`📊 Loaded: ${this.persistentMemory.size} agents with persistent memory`);
      console.log(`🔄 Active sessions: ${this.activeSessions.size}`);
      
    } catch (error) {
      console.error('❌ Failed to initialize agent memory system:', error.message);
    }
  }

  /**
   * Create or resume an agent session with memory context
   */
  async createSession(agentId, sessionData = {}) {
    const sessionId = this.generateSessionId(agentId);
    
    // Load persistent memory for this agent
    const persistentData = this.persistentMemory.get(agentId) || {
      agent_id: agentId,
      learned_patterns: {},
      successful_strategies: [],
      common_contexts: {},
      performance_metrics: {
        total_tasks: 0,
        successful_tasks: 0,
        avg_execution_time: 0,
        domains_expertise: {}
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    const session = {
      session_id: sessionId,
      agent_id: agentId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      persistent_memory: persistentData,
      session_context: {
        current_domain: sessionData.domain || null,
        current_task_type: sessionData.task_type || null,
        recent_queries: [],
        successful_patterns: [],
        failed_attempts: [],
        learning_insights: []
      },
      temporary_state: sessionData.initial_state || {},
      interaction_history: [],
      performance_tracking: {
        start_time: Date.now(),
        tasks_completed: 0,
        success_rate: 0,
        domain_performance: {}
      }
    };
    
    this.activeSessions.set(sessionId, session);
    await this.saveSession(sessionId);
    
    console.log(`🧠 Created session ${sessionId} for agent ${agentId}`);
    return sessionId;
  }

  /**
   * Record an agent interaction for learning and context
   */
  async recordInteraction(sessionId, interaction) {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    
    const interactionRecord = {
      timestamp: new Date().toISOString(),
      type: interaction.type || 'general',
      domain: interaction.domain || session.session_context.current_domain,
      input: interaction.input,
      output: interaction.output,
      success: interaction.success !== undefined ? interaction.success : true,
      execution_time: interaction.execution_time || 0,
      context_used: interaction.context_used || [],
      learning_signals: interaction.learning_signals || {},
      metadata: interaction.metadata || {}
    };
    
    // Add to session history
    session.interaction_history.push(interactionRecord);
    
    // Update session context
    await this.updateSessionContext(session, interactionRecord);
    
    // Update performance tracking
    await this.updatePerformanceTracking(session, interactionRecord);
    
    // Learn from successful interactions
    if (interactionRecord.success) {
      await this.extractLearningFromInteraction(session, interactionRecord);
    }
    
    // Update session timestamp
    session.updated_at = new Date().toISOString();
    
    // Save session
    await this.saveSession(sessionId);
    
    return interactionRecord;
  }

  async updateSessionContext(session, interaction) {
    const context = session.session_context;
    
    // Update current domain if specified
    if (interaction.domain) {
      context.current_domain = interaction.domain;
    }
    
    // Track recent queries for pattern recognition
    if (interaction.type === 'query') {
      context.recent_queries.push({
        query: interaction.input,
        success: interaction.success,
        domain: interaction.domain,
        timestamp: interaction.timestamp
      });
      
      // Keep only recent queries
      context.recent_queries = context.recent_queries.slice(-20);
    }
    
    // Track successful patterns
    if (interaction.success && interaction.learning_signals.pattern_type) {
      context.successful_patterns.push({
        pattern_type: interaction.learning_signals.pattern_type,
        context: interaction.input,
        domain: interaction.domain,
        timestamp: interaction.timestamp
      });
      
      context.successful_patterns = context.successful_patterns.slice(-50);
    }
    
    // Track failed attempts for learning
    if (!interaction.success) {
      context.failed_attempts.push({
        type: interaction.type,
        input: interaction.input,
        domain: interaction.domain,
        error: interaction.metadata.error || 'Unknown error',
        timestamp: interaction.timestamp
      });
      
      context.failed_attempts = context.failed_attempts.slice(-20);
    }
    
    // Extract learning insights
    if (interaction.learning_signals.insight) {
      context.learning_insights.push({
        insight: interaction.learning_signals.insight,
        domain: interaction.domain,
        confidence: interaction.learning_signals.confidence || 0.5,
        timestamp: interaction.timestamp
      });
      
      context.learning_insights = context.learning_insights.slice(-30);
    }
  }

  async updatePerformanceTracking(session, interaction) {
    const tracking = session.performance_tracking;
    
    tracking.tasks_completed++;
    
    // Update success rate
    const successfulTasks = session.interaction_history.filter(i => i.success).length;
    tracking.success_rate = successfulTasks / session.interaction_history.length;
    
    // Update domain performance
    if (interaction.domain) {
      if (!tracking.domain_performance[interaction.domain]) {
        tracking.domain_performance[interaction.domain] = {
          tasks: 0,
          successes: 0,
          total_time: 0,
          avg_time: 0,
          success_rate: 0
        };
      }
      
      const domainStats = tracking.domain_performance[interaction.domain];
      domainStats.tasks++;
      domainStats.total_time += interaction.execution_time;
      domainStats.avg_time = domainStats.total_time / domainStats.tasks;
      
      if (interaction.success) {
        domainStats.successes++;
      }
      
      domainStats.success_rate = domainStats.successes / domainStats.tasks;
    }
  }

  async extractLearningFromInteraction(session, interaction) {
    const agentId = session.agent_id;
    let persistentData = this.persistentMemory.get(agentId);
    
    if (!persistentData) {
      persistentData = {
        agent_id: agentId,
        learned_patterns: {},
        successful_strategies: [],
        common_contexts: {},
        performance_metrics: {
          total_tasks: 0,
          successful_tasks: 0,
          avg_execution_time: 0,
          domains_expertise: {}
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
    }
    
    // Learn interaction patterns
    const patternKey = `${interaction.type}_${interaction.domain || 'general'}`;
    if (!persistentData.learned_patterns[patternKey]) {
      persistentData.learned_patterns[patternKey] = {
        pattern_type: interaction.type,
        domain: interaction.domain,
        success_count: 0,
        total_count: 0,
        avg_execution_time: 0,
        common_inputs: {},
        effective_approaches: []
      };
    }
    
    const pattern = persistentData.learned_patterns[patternKey];
    pattern.total_count++;
    pattern.success_count++;
    pattern.avg_execution_time = ((pattern.avg_execution_time * (pattern.total_count - 1)) + interaction.execution_time) / pattern.total_count;
    
    // Track common input patterns
    const inputHash = this.hashInput(interaction.input);
    pattern.common_inputs[inputHash] = (pattern.common_inputs[inputHash] || 0) + 1;
    
    // Track effective approaches
    if (interaction.learning_signals.approach) {
      const existingApproach = pattern.effective_approaches.find(a => a.approach === interaction.learning_signals.approach);
      
      if (existingApproach) {
        existingApproach.usage_count++;
        existingApproach.avg_success_rate = ((existingApproach.avg_success_rate * (existingApproach.usage_count - 1)) + 1) / existingApproach.usage_count;
      } else {
        pattern.effective_approaches.push({
          approach: interaction.learning_signals.approach,
          usage_count: 1,
          avg_success_rate: 1.0,
          first_used: interaction.timestamp
        });
      }
      
      // Keep only top 10 approaches
      pattern.effective_approaches = pattern.effective_approaches
        .sort((a, b) => b.avg_success_rate - a.avg_success_rate)
        .slice(0, 10);
    }
    
    // Update successful strategies
    if (interaction.learning_signals.strategy) {
      const strategy = {
        strategy: interaction.learning_signals.strategy,
        domain: interaction.domain,
        context: interaction.input.substring(0, 100), // First 100 chars
        success_factors: interaction.learning_signals.success_factors || [],
        timestamp: interaction.timestamp
      };
      
      persistentData.successful_strategies.push(strategy);
      persistentData.successful_strategies = persistentData.successful_strategies.slice(-100); // Keep last 100
    }
    
    // Update performance metrics
    const metrics = persistentData.performance_metrics;
    metrics.total_tasks++;
    metrics.successful_tasks++;
    metrics.avg_execution_time = ((metrics.avg_execution_time * (metrics.total_tasks - 1)) + interaction.execution_time) / metrics.total_tasks;
    
    // Update domain expertise
    if (interaction.domain) {
      if (!metrics.domains_expertise[interaction.domain]) {
        metrics.domains_expertise[interaction.domain] = {
          tasks: 0,
          successes: 0,
          expertise_level: 'novice',
          specializations: []
        };
      }
      
      const domainExpertise = metrics.domains_expertise[interaction.domain];
      domainExpertise.tasks++;
      domainExpertise.successes++;
      
      // Calculate expertise level
      const successRate = domainExpertise.successes / domainExpertise.tasks;
      const taskCount = domainExpertise.tasks;
      
      if (successRate >= 0.9 && taskCount >= 50) {
        domainExpertise.expertise_level = 'expert';
      } else if (successRate >= 0.8 && taskCount >= 20) {
        domainExpertise.expertise_level = 'advanced';
      } else if (successRate >= 0.7 && taskCount >= 10) {
        domainExpertise.expertise_level = 'intermediate';
      } else if (taskCount >= 5) {
        domainExpertise.expertise_level = 'beginner';
      }
      
      // Track specializations
      if (interaction.learning_signals.specialization) {
        if (!domainExpertise.specializations.includes(interaction.learning_signals.specialization)) {
          domainExpertise.specializations.push(interaction.learning_signals.specialization);
        }
      }
    }
    
    persistentData.updated_at = new Date().toISOString();
    this.persistentMemory.set(agentId, persistentData);
    
    await this.savePersistentMemory();
  }

  /**
   * Get contextual memory for an agent to inform current decisions
   */
  async getAgentContext(sessionId, contextType = 'full') {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    
    const context = {
      session_id: sessionId,
      agent_id: session.agent_id,
      current_domain: session.session_context.current_domain,
      expertise_level: this.getAgentExpertiseLevel(session.agent_id, session.session_context.current_domain),
      relevant_patterns: [],
      successful_strategies: [],
      recent_context: {},
      recommendations: []
    };
    
    const persistentData = session.persistent_memory;
    
    // Get relevant patterns for current context
    if (session.session_context.current_domain) {
      const domainPatterns = Object.values(persistentData.learned_patterns)
        .filter(p => p.domain === session.session_context.current_domain)
        .sort((a, b) => (b.success_count / b.total_count) - (a.success_count / a.total_count))
        .slice(0, 5);
      
      context.relevant_patterns = domainPatterns;
    }
    
    // Get successful strategies for current domain
    context.successful_strategies = persistentData.successful_strategies
      .filter(s => !session.session_context.current_domain || s.domain === session.session_context.current_domain)
      .slice(-10);
    
    // Get recent session context
    context.recent_context = {
      recent_queries: session.session_context.recent_queries.slice(-5),
      successful_patterns: session.session_context.successful_patterns.slice(-5),
      learning_insights: session.session_context.learning_insights.slice(-5)
    };
    
    // Generate recommendations based on memory
    context.recommendations = await this.generateRecommendations(session);
    
    if (contextType === 'summary') {
      // Return only essential context for quick decisions
      return {
        session_id: context.session_id,
        expertise_level: context.expertise_level,
        top_pattern: context.relevant_patterns[0] || null,
        best_strategy: context.successful_strategies[0] || null,
        key_recommendation: context.recommendations[0] || null
      };
    }
    
    return context;
  }

  async generateRecommendations(session) {
    const recommendations = [];
    const persistentData = session.persistent_memory;
    const currentDomain = session.session_context.current_domain;
    
    // Recommend best approaches for current domain
    if (currentDomain && persistentData.learned_patterns[`query_${currentDomain}`]) {
      const domainPattern = persistentData.learned_patterns[`query_${currentDomain}`];
      const bestApproach = domainPattern.effective_approaches[0];
      
      if (bestApproach) {
        recommendations.push({
          type: 'approach',
          priority: 'high',
          recommendation: `Use '${bestApproach.approach}' approach - ${(bestApproach.avg_success_rate * 100).toFixed(0)}% success rate`,
          confidence: bestApproach.avg_success_rate
        });
      }
    }
    
    // Recommend based on recent failures
    const recentFailures = session.session_context.failed_attempts.slice(-3);
    if (recentFailures.length >= 2) {
      const commonFailureTypes = {};
      recentFailures.forEach(f => {
        commonFailureTypes[f.type] = (commonFailureTypes[f.type] || 0) + 1;
      });
      
      const mostCommonFailure = Object.entries(commonFailureTypes)
        .sort(([,a], [,b]) => b - a)[0];
      
      if (mostCommonFailure && mostCommonFailure[1] >= 2) {
        recommendations.push({
          type: 'failure_mitigation',
          priority: 'medium',
          recommendation: `Recent failures in ${mostCommonFailure[0]} - consider alternative approach`,
          confidence: 0.7
        });
      }
    }
    
    // Recommend based on expertise gaps
    const domainExpertise = persistentData.performance_metrics.domains_expertise;
    const lowExpertiseDomains = Object.entries(domainExpertise)
      .filter(([, stats]) => stats.tasks < 10 || stats.successes / stats.tasks < 0.7)
      .map(([domain]) => domain);
    
    if (lowExpertiseDomains.length > 0 && currentDomain && lowExpertiseDomains.includes(currentDomain)) {
      recommendations.push({
        type: 'expertise_building',
        priority: 'low',
        recommendation: `Limited experience in ${currentDomain} - proceed carefully and learn from results`,
        confidence: 0.6
      });
    }
    
    return recommendations.sort((a, b) => {
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });
  }

  getAgentExpertiseLevel(agentId, domain) {
    const persistentData = this.persistentMemory.get(agentId);
    
    if (!persistentData || !domain) {
      return 'novice';
    }
    
    const domainExpertise = persistentData.performance_metrics.domains_expertise[domain];
    return domainExpertise?.expertise_level || 'novice';
  }

  /**
   * End a session and consolidate learnings
   */
  async endSession(sessionId, sessionSummary = {}) {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    
    // Calculate final session metrics
    const duration = Date.now() - session.performance_tracking.start_time;
    const finalMetrics = {
      duration_ms: duration,
      total_interactions: session.interaction_history.length,
      success_rate: session.performance_tracking.success_rate,
      tasks_completed: session.performance_tracking.tasks_completed,
      domains_worked: Object.keys(session.performance_tracking.domain_performance),
      final_summary: sessionSummary
    };
    
    session.ended_at = new Date().toISOString();
    session.final_metrics = finalMetrics;
    
    // Consolidate session learnings into persistent memory
    await this.consolidateSessionLearnings(session);
    
    // Save final session state
    await this.saveSession(sessionId);
    
    // Remove from active sessions
    this.activeSessions.delete(sessionId);
    
    console.log(`🏁 Ended session ${sessionId}: ${finalMetrics.tasks_completed} tasks, ${(finalMetrics.success_rate * 100).toFixed(0)}% success rate`);
    
    return finalMetrics;
  }

  async consolidateSessionLearnings(session) {
    // Extract high-level patterns from the entire session
    const sessionPatterns = this.extractSessionPatterns(session);
    
    // Update persistent memory with session insights
    const persistentData = this.persistentMemory.get(session.agent_id);
    
    if (sessionPatterns.length > 0) {
      sessionPatterns.forEach(pattern => {
        const key = `session_pattern_${pattern.type}_${pattern.domain || 'general'}`;
        if (!persistentData.learned_patterns[key]) {
          persistentData.learned_patterns[key] = {
            pattern_type: 'session_pattern',
            subtype: pattern.type,
            domain: pattern.domain,
            occurrences: 0,
            success_indicators: [],
            context_factors: {}
          };
        }
        
        const sessionPattern = persistentData.learned_patterns[key];
        sessionPattern.occurrences++;
        
        if (pattern.success_indicators) {
          sessionPattern.success_indicators.push(...pattern.success_indicators);
          sessionPattern.success_indicators = sessionPattern.success_indicators.slice(-20);
        }
        
        if (pattern.context_factors) {
          Object.entries(pattern.context_factors).forEach(([factor, importance]) => {
            sessionPattern.context_factors[factor] = (sessionPattern.context_factors[factor] || 0) + importance;
          });
        }
      });
    }
    
    await this.savePersistentMemory();
  }

  extractSessionPatterns(session) {
    const patterns = [];
    
    // Pattern: Domain switching frequency and success
    const domainSwitches = this.analyzeDomainSwitches(session.interaction_history);
    if (domainSwitches.frequency > 0) {
      patterns.push({
        type: 'domain_switching',
        frequency: domainSwitches.frequency,
        success_correlation: domainSwitches.success_correlation,
        success_indicators: ['multi_domain_capability'],
        context_factors: { domain_versatility: domainSwitches.frequency * 0.1 }
      });
    }
    
    // Pattern: Query complexity and success relationship
    const complexityPattern = this.analyzeComplexityPattern(session.interaction_history);
    if (complexityPattern.correlation !== null) {
      patterns.push({
        type: 'complexity_handling',
        correlation: complexityPattern.correlation,
        optimal_complexity: complexityPattern.optimal_complexity,
        success_indicators: complexityPattern.success_factors,
        context_factors: { complexity_preference: complexityPattern.correlation }
      });
    }
    
    return patterns;
  }

  analyzeDomainSwitches(history) {
    let switches = 0;
    let lastDomain = null;
    let successfulSwitches = 0;
    
    history.forEach(interaction => {
      if (interaction.domain && interaction.domain !== lastDomain) {
        switches++;
        if (interaction.success) {
          successfulSwitches++;
        }
        lastDomain = interaction.domain;
      }
    });
    
    return {
      frequency: switches,
      success_correlation: switches > 0 ? successfulSwitches / switches : 0
    };
  }

  analyzeComplexityPattern(history) {
    const queryInteractions = history.filter(i => i.type === 'query');
    
    if (queryInteractions.length < 5) {
      return { correlation: null };
    }
    
    const complexityData = queryInteractions.map(i => ({
      complexity: this.calculateQueryComplexity(i.input),
      success: i.success ? 1 : 0
    }));
    
    // Simple correlation calculation
    const avgComplexity = complexityData.reduce((sum, d) => sum + d.complexity, 0) / complexityData.length;
    const avgSuccess = complexityData.reduce((sum, d) => sum + d.success, 0) / complexityData.length;
    
    let correlation = 0;
    let numerator = 0;
    let denomComplexity = 0;
    let denomSuccess = 0;
    
    complexityData.forEach(d => {
      const complexityDiff = d.complexity - avgComplexity;
      const successDiff = d.success - avgSuccess;
      
      numerator += complexityDiff * successDiff;
      denomComplexity += complexityDiff * complexityDiff;
      denomSuccess += successDiff * successDiff;
    });
    
    if (denomComplexity > 0 && denomSuccess > 0) {
      correlation = numerator / Math.sqrt(denomComplexity * denomSuccess);
    }
    
    // Find optimal complexity range
    const successfulQueries = complexityData.filter(d => d.success);
    const optimalComplexity = successfulQueries.length > 0 
      ? successfulQueries.reduce((sum, d) => sum + d.complexity, 0) / successfulQueries.length
      : avgComplexity;
    
    return {
      correlation,
      optimal_complexity: optimalComplexity,
      success_factors: correlation > 0.3 ? ['complex_queries'] : ['simple_queries']
    };
  }

  calculateQueryComplexity(query) {
    const factors = {
      length: query.length / 100, // Normalize length
      words: query.split(' ').length / 10, // Normalize word count
      technical_terms: (query.match(/\b(implement|calculate|analyze|optimize|strategy|algorithm)\b/gi) || []).length,
      questions: (query.match(/\?/g) || []).length,
      specificity: (query.match(/\b(specific|exactly|precisely|detailed)\b/gi) || []).length
    };
    
    return Math.min(
      factors.length + factors.words + factors.technical_terms + factors.questions + factors.specificity,
      10
    ); // Cap at 10
  }

  async cleanupOldSessions() {
    try {
      const sessionFiles = await fs.readdir(this.sessionPath);
      const now = Date.now();
      
      for (const file of sessionFiles) {
        if (file.endsWith('.json')) {
          const filePath = path.join(this.sessionPath, file);
          const stats = await fs.stat(filePath);
          
          if (now - stats.mtime.getTime() > this.maxSessionAge) {
            await fs.unlink(filePath);
            console.log(`🧹 Cleaned up old session: ${file}`);
          }
        }
      }
    } catch (error) {
      console.warn('⚠️ Failed to cleanup old sessions:', error.message);
    }
  }

  hashInput(input) {
    return createHash('sha256').update(input.substring(0, 200)).digest('hex').substring(0, 8);
  }

  async loadPersistentMemory() {
    try {
      const files = await fs.readdir(this.persistentPath);
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          const agentId = file.replace('.json', '');
          const data = await fs.readFile(path.join(this.persistentPath, file), 'utf-8');
          const memoryData = JSON.parse(data);
          
          this.persistentMemory.set(agentId, memoryData);
        }
      }
    } catch (error) {
      // Directory doesn't exist yet
    }
  }

  async savePersistentMemory() {
    for (const [agentId, memoryData] of this.persistentMemory) {
      const filePath = path.join(this.persistentPath, `${agentId}.json`);
      await fs.writeFile(filePath, JSON.stringify(memoryData, null, 2));
    }
  }

  async loadActiveSessions() {
    try {
      const files = await fs.readdir(this.sessionPath);
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          const sessionId = file.replace('.json', '');
          const data = await fs.readFile(path.join(this.sessionPath, file), 'utf-8');
          const sessionData = JSON.parse(data);
          
          // Only load sessions from the last 24 hours
          const sessionAge = Date.now() - new Date(sessionData.created_at).getTime();
          if (sessionAge < this.maxSessionAge) {
            this.activeSessions.set(sessionId, sessionData);
          }
        }
      }
    } catch (error) {
      // Directory doesn't exist yet
    }
  }

  async saveSession(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      const filePath = path.join(this.sessionPath, `${sessionId}.json`);
      await fs.writeFile(filePath, JSON.stringify(session, null, 2));
    }
  }

  async loadContextCache() {
    // Context cache is kept in memory for this session
    // Could be extended to persist frequently used contexts
  }

  generateSessionId(agentId) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `${agentId}_${timestamp}_${random}`;
  }

  /**
   * Get memory statistics across all agents
   */
  getMemoryStats() {
    const stats = {
      total_agents: this.persistentMemory.size,
      active_sessions: this.activeSessions.size,
      total_interactions: 0,
      avg_expertise_levels: {},
      memory_usage: {
        persistent_memory_mb: 0,
        active_sessions_mb: 0
      }
    };
    
    // Calculate total interactions and expertise levels
    for (const [agentId, memory] of this.persistentMemory) {
      stats.total_interactions += memory.performance_metrics.total_tasks;
      
      Object.entries(memory.performance_metrics.domains_expertise).forEach(([domain, expertise]) => {
        if (!stats.avg_expertise_levels[domain]) {
          stats.avg_expertise_levels[domain] = { total: 0, count: 0 };
        }
        
        const expertiseScore = this.getExpertiseScore(expertise.expertise_level);
        stats.avg_expertise_levels[domain].total += expertiseScore;
        stats.avg_expertise_levels[domain].count += 1;
      });
    }
    
    // Calculate average expertise levels
    Object.keys(stats.avg_expertise_levels).forEach(domain => {
      const data = stats.avg_expertise_levels[domain];
      stats.avg_expertise_levels[domain] = this.getExpertiseLevelFromScore(data.total / data.count);
    });
    
    return stats;
  }

  getExpertiseScore(level) {
    const scores = { novice: 1, beginner: 2, intermediate: 3, advanced: 4, expert: 5 };
    return scores[level] || 1;
  }

  getExpertiseLevelFromScore(score) {
    if (score >= 4.5) return 'expert';
    if (score >= 3.5) return 'advanced';
    if (score >= 2.5) return 'intermediate';
    if (score >= 1.5) return 'beginner';
    return 'novice';
  }
}

export { AgentMemorySystem };

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const memorySystem = new AgentMemorySystem();
  
  const command = process.argv[2] || 'stats';
  
  switch (command) {
    case 'stats':
      const stats = memorySystem.getMemoryStats();
      console.log('\n🧠 Agent Memory Statistics:');
      console.log(JSON.stringify(stats, null, 2));
      break;
      
    case 'test':
      // Test agent memory system
      const sessionId = await memorySystem.createSession('test-trader-agent', {
        domain: 'strategies',
        task_type: 'strategy_optimization'
      });
      
      await memorySystem.recordInteraction(sessionId, {
        type: 'query',
        domain: 'strategies',
        input: 'RSI momentum strategy implementation',
        output: 'Successfully implemented RSI strategy with 85% accuracy',
        success: true,
        execution_time: 234,
        learning_signals: {
          pattern_type: 'technical_analysis',
          approach: 'iterative_optimization',
          strategy: 'momentum_based_rsi',
          confidence: 0.85
        }
      });
      
      const context = await memorySystem.getAgentContext(sessionId);
      console.log('\n🧠 Agent Context:', JSON.stringify(context, null, 2));
      
      await memorySystem.endSession(sessionId, { 
        summary: 'Successful RSI strategy implementation session' 
      });
      
      console.log('✅ Test completed');
      break;
      
    default:
      console.log('Usage: node agent-memory.mjs [stats|test]');
  }
}
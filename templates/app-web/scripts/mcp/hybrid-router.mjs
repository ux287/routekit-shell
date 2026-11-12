#!/usr/bin/env node
/**
 * Hybrid Query Router - Core routing engine for intelligent query classification and routing
 */

import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import { spawn } from 'child_process';
import { promisify } from 'util';

class HybridQueryRouter {
  constructor() {
    this.config = null;
    this.policies = null;
    this.initPromise = this.loadConfiguration();
  }

  async loadConfiguration() {
    try {
      // Load routing configuration
      const routerConfigPath = path.resolve('.routekit/retrieval.router.yaml');
      const routerConfig = await fs.readFile(routerConfigPath, 'utf-8');
      this.config = yaml.load(routerConfig);

      // Load guardrail policies
      const policiesPath = path.resolve('.routekit/policy.guardrails.yaml');
      const policiesConfig = await fs.readFile(policiesPath, 'utf-8');
      this.policies = yaml.load(policiesConfig);

      console.log('✅ Router configuration loaded');
    } catch (error) {
      console.error('❌ Failed to load router configuration:', error.message);
      process.exit(1);
    }
  }

  /**
   * Main routing function - decides between filesystem and vector search
   */
  async classifyQuery(query) {
    // Ensure configuration is loaded
    await this.initPromise;
    
    const classification = {
      route: 'rag_first', // default
      confidence: 0.5,
      reasoning: [],
      triggered_patterns: []
    };

    // Check filesystem triggers first (code-related queries)
    const fsTriggered = await this.checkFilesystemTriggers(query);
    if (fsTriggered.triggered) {
      classification.route = 'fs_first';
      classification.confidence = fsTriggered.confidence;
      classification.reasoning.push('Filesystem triggers matched');
      classification.triggered_patterns.push(...fsTriggered.patterns);
    }

    // Check RAG triggers (conceptual queries)
    const ragTriggered = await this.checkRAGTriggers(query);
    if (ragTriggered.triggered && !fsTriggered.triggered) {
      classification.route = 'rag_first';
      classification.confidence = ragTriggered.confidence;
      classification.reasoning.push('RAG triggers matched');
      classification.triggered_patterns.push(...ragTriggered.patterns);
    }

    // Special case: both triggered - use confidence scores
    if (fsTriggered.triggered && ragTriggered.triggered) {
      if (fsTriggered.confidence > ragTriggered.confidence) {
        classification.route = 'fs_first';
        classification.confidence = fsTriggered.confidence;
        classification.reasoning.push('FS confidence higher than RAG');
      } else {
        classification.route = 'rag_first';
        classification.confidence = ragTriggered.confidence;
        classification.reasoning.push('RAG confidence higher than FS');
      }
    }

    return classification;
  }

  async checkFilesystemTriggers(query) {
    const triggers = this.config.routing.fs_triggers;
    let triggered = false;
    let confidence = 0;
    let patterns = [];

    for (const trigger of triggers) {
      if (trigger.regex) {
        const regex = new RegExp(trigger.regex, 'i');
        if (regex.test(query)) {
          triggered = true;
          confidence += 0.3;
          patterns.push(`regex: ${trigger.regex}`);
        }
      }

      if (trigger.contains_any) {
        const matches = trigger.contains_any.filter(term => 
          query.toLowerCase().includes(term.toLowerCase())
        );
        if (matches.length > 0) {
          triggered = true;
          confidence += matches.length * 0.2;
          patterns.push(`contains: ${matches.join(', ')}`);
        }
      }
    }

    return {
      triggered,
      confidence: Math.min(confidence, 1.0),
      patterns
    };
  }

  async checkRAGTriggers(query) {
    const triggers = this.config.routing.rag_triggers;
    let triggered = false;
    let confidence = 0;
    let patterns = [];

    for (const trigger of triggers) {
      if (trigger.contains_any) {
        const matches = trigger.contains_any.filter(term => 
          query.toLowerCase().includes(term.toLowerCase())
        );
        if (matches.length > 0) {
          triggered = true;
          confidence += matches.length * 0.25;
          patterns.push(`contains: ${matches.join(', ')}`);
        }
      }

      if (trigger.min_words) {
        const wordCount = query.split(/\s+/).length;
        if (wordCount >= trigger.min_words) {
          triggered = true;
          confidence += 0.2;
          patterns.push(`word_count: ${wordCount} >= ${trigger.min_words}`);
        }
      }

      if (trigger.regex) {
        const regex = new RegExp(trigger.regex, 'i');
        if (regex.test(query)) {
          triggered = true;
          confidence += 0.3;
          patterns.push(`regex: ${trigger.regex}`);
        }
      }
    }

    return {
      triggered,
      confidence: Math.min(confidence, 1.0),
      patterns
    };
  }

  /**
   * Execute filesystem search using ripgrep
   */
  async filesystemSearch(query, options = {}) {
    const startTime = Date.now();
    
    try {
      // Extract search patterns from query
      const searchTerms = this.extractSearchTerms(query);
      
      // Build ripgrep command
      const rgArgs = [
        '--json',
        '--smart-case',
        '--context', '3',
        '--max-count', '10',
        ...this.buildRipgrepArgs(searchTerms, options)
      ];

      // Execute ripgrep
      const results = await this.executeRipgrep(rgArgs);
      
      // Process and score results
      const processedResults = await this.processFilesystemResults(results, query);
      
      const executionTime = Date.now() - startTime;
      
      return {
        results: processedResults,
        metadata: {
          search_type: 'filesystem',
          execution_time: executionTime,
          total_results: processedResults.length,
          search_terms: searchTerms
        }
      };

    } catch (error) {
      console.error('Filesystem search error:', error);
      return {
        results: [],
        metadata: {
          search_type: 'filesystem',
          execution_time: Date.now() - startTime,
          error: error.message
        }
      };
    }
  }

  buildRipgrepArgs(searchTerms, options) {
    const args = [];
    
    // File type restrictions for trading system
    args.push('--type', 'py');
    args.push('--type', 'js');
    args.push('--type', 'md');
    args.push('--type', 'yaml');
    
    // Search pattern (combine terms with OR) - put pattern before paths
    const pattern = searchTerms.length > 0 ? searchTerms.join('|') : 'strategy';
    args.push(pattern);
    
    // Search paths - add after pattern
    args.push('./src');
    args.push('./notes');
    args.push('./scripts');
    args.push('./tests');
    
    return args;
  }

  async executeRipgrep(args) {
    return new Promise((resolve, reject) => {
      const rg = spawn('rg', args);
      let stdout = '';
      let stderr = '';
      
      rg.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      rg.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      rg.on('close', (code) => {
        if (code === 0) {
          // Parse JSON lines
          const lines = stdout.trim().split('\n').filter(line => line);
          const results = lines.map(line => {
            try {
              return JSON.parse(line);
            } catch (e) {
              return null;
            }
          }).filter(r => r && r.type === 'match');
          
          resolve(results);
        } else if (code === 1) {
          // No matches found - not an error
          resolve([]);
        } else {
          reject(new Error(`ripgrep failed with code ${code}: ${stderr}`));
        }
      });
    });
  }

  async processFilesystemResults(rgResults, query) {
    const processed = [];
    
    for (const result of rgResults) {
      if (result.type === 'match') {
        const score = this.calculateFilesystemScore(result, query);
        
        processed.push({
          path: result.data.path.text,
          line_number: result.data.line_number,
          content: result.data.lines.text,
          context_before: result.data.submatches?.[0]?.start || 0,
          context_after: result.data.submatches?.[0]?.end || result.data.lines.text.length,
          score: score,
          source_type: 'filesystem',
          relevance_factors: this.getRelevanceFactors(result, query)
        });
      }
    }
    
    // Sort by score and apply canonical boosting
    return processed
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.budget.fs_first.k);
  }

  calculateFilesystemScore(result, query) {
    let score = 0.5; // base score
    
    // Boost based on file type and location
    const filePath = result.data.path.text;
    
    if (filePath.includes('/src/')) score += 0.2;
    if (filePath.includes('strategy') || filePath.includes('risk')) score += 0.15;
    if (filePath.includes('api_server') || filePath.includes('robinhood') || filePath.includes('tradier')) score += 0.1;
    
    // Boost based on match quality
    const matchText = result.data.lines.text.toLowerCase();
    const queryTerms = query.toLowerCase().split(/\s+/);
    
    queryTerms.forEach(term => {
      if (matchText.includes(term)) {
        score += 0.1;
      }
    });
    
    return Math.min(score, 1.0);
  }

  extractSearchTerms(query) {
    // Extract meaningful search terms from query
    const terms = [];
    
    // Code patterns
    const codeMatches = query.match(/\b(class|def|import|function)\s+(\w+)/g);
    if (codeMatches) {
      terms.push(...codeMatches);
    }
    
    // File patterns
    const fileMatches = query.match(/\b\w+\.py\b/g);
    if (fileMatches) {
      terms.push(...fileMatches);
    }
    
    // Trading-specific terms
    const tradingTerms = ['RSI', 'MACD', 'position_size', 'stop_loss', 'robinhood', 'tradier', 'risk_manager'];
    tradingTerms.forEach(term => {
      if (query.toLowerCase().includes(term.toLowerCase())) {
        terms.push(term);
      }
    });
    
    // Fallback: use significant words
    if (terms.length === 0) {
      const words = query.split(/\s+/)
        .filter(word => word.length > 3)
        .filter(word => !['what', 'how', 'where', 'when', 'why', 'does', 'the', 'and', 'for'].includes(word.toLowerCase()));
      terms.push(...words.slice(0, 3));
    }
    
    return terms;
  }

  /**
   * Execute vector search using RAG MCP
   */
  async vectorSearch(query, options = {}) {
    const startTime = Date.now();
    
    try {
      // Use the RAG MCP server for vector search
      const k = options.k || this.config.budget.rag_first.k;
      
      // This would be called via MCP in actual implementation
      // For now, return structured format that matches expected interface
      const results = await this.executeRAGQuery(query, k);
      
      // Process and score results
      const processedResults = await this.processVectorResults(results, query);
      
      const executionTime = Date.now() - startTime;
      
      return {
        results: processedResults,
        metadata: {
          search_type: 'vector',
          execution_time: executionTime,
          total_results: processedResults.length,
          query: query,
          k: k
        }
      };
      
    } catch (error) {
      console.error('Vector search error:', error);
      return {
        results: [],
        metadata: {
          search_type: 'vector',
          execution_time: Date.now() - startTime,
          error: error.message
        }
      };
    }
  }

  async executeRAGQuery(query, k) {
    // In actual MCP integration, this would call:
    // mcp__routekit-rag-traders__rag_query
    
    // For now, simulate the expected structure
    return {
      results: [],
      metadata: {
        query: query,
        k: k,
        db_path: `${process.env.ROUTEKIT_PROJECT_ROOT || process.cwd()}/.routekit/rag/index.lancedb`
      }
    };
  }

  async processVectorResults(ragResults, query) {
    const processed = [];
    
    if (!ragResults.results || ragResults.results.length === 0) {
      return processed;
    }
    
    for (const result of ragResults.results) {
      const score = this.calculateVectorScore(result, query);
      
      processed.push({
        path: result.source || result.path,
        content: result.text || result.content,
        score: score,
        source_type: 'vector',
        metadata: result.metadata || {},
        relevance_factors: this.getVectorRelevanceFactors(result, query)
      });
    }
    
    // Sort by score and apply canonical boosting
    return processed
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.budget.rag_first.k);
  }

  calculateVectorScore(result, query) {
    // Use the similarity score from vector search as base
    let score = result.score || result.similarity || 0.5;
    
    // Boost based on source quality
    const source = result.source || result.path || '';
    
    if (source.includes('strategies.')) score += 0.15;
    if (source.includes('risk.')) score += 0.15;
    if (source.includes('decisions.')) score += 0.2;
    if (source.includes('api.')) score += 0.1;
    
    // Boost based on content relevance
    const content = (result.text || result.content || '').toLowerCase();
    const queryTerms = query.toLowerCase().split(/\s+/);
    
    queryTerms.forEach(term => {
      if (content.includes(term)) {
        score += 0.05;
      }
    });
    
    return Math.min(score, 1.0);
  }

  getVectorRelevanceFactors(result, query) {
    const factors = [];
    const source = result.source || result.path || '';
    
    if (source.includes('strategies.')) factors.push('strategy_knowledge');
    if (source.includes('risk.')) factors.push('risk_knowledge'); 
    if (source.includes('decisions.')) factors.push('decision_record');
    if (source.includes('api.')) factors.push('api_knowledge');
    if (source.includes('analysis.')) factors.push('analysis_knowledge');
    
    return factors;
  }

  /**
   * Hybrid search - execute both filesystem and vector search
   */
  async hybridSearch(query, options = {}) {
    const startTime = Date.now();
    
    try {
      // Execute both searches in parallel
      const [fsResults, vectorResults] = await Promise.all([
        this.filesystemSearch(query, options),
        this.vectorSearch(query, options)
      ]);
      
      // Merge results based on strategy
      const mergedResults = await this.mergeResults(
        fsResults.results,
        vectorResults.results,
        options.merge_strategy || 'score_based'
      );
      
      const executionTime = Date.now() - startTime;
      
      return {
        results: mergedResults,
        metadata: {
          search_type: 'hybrid',
          execution_time: executionTime,
          filesystem_results: fsResults.results.length,
          vector_results: vectorResults.results.length,
          total_results: mergedResults.length,
          merge_strategy: options.merge_strategy || 'score_based'
        }
      };
      
    } catch (error) {
      console.error('Hybrid search error:', error);
      return {
        results: [],
        metadata: {
          search_type: 'hybrid',
          execution_time: Date.now() - startTime,
          error: error.message
        }
      };
    }
  }

  async mergeResults(fsResults, vectorResults, strategy) {
    const allResults = [
      ...fsResults.map(r => ({ ...r, search_type: 'filesystem' })),
      ...vectorResults.map(r => ({ ...r, search_type: 'vector' }))
    ];
    
    switch (strategy) {
      case 'interleave':
        return this.interleaveResults(fsResults, vectorResults);
        
      case 'domain_based':
        return this.domainBasedMerge(fsResults, vectorResults);
        
      case 'score_based':
      default:
        // Sort all results by score and take top results
        return allResults
          .sort((a, b) => b.score - a.score)
          .slice(0, this.config.thresholds.max_total_passages);
    }
  }

  interleaveResults(fsResults, vectorResults) {
    const merged = [];
    const maxLength = Math.max(fsResults.length, vectorResults.length);
    
    for (let i = 0; i < maxLength; i++) {
      if (i < fsResults.length) {
        merged.push({ ...fsResults[i], search_type: 'filesystem' });
      }
      if (i < vectorResults.length) {
        merged.push({ ...vectorResults[i], search_type: 'vector' });
      }
    }
    
    return merged.slice(0, this.config.thresholds.max_total_passages);
  }

  domainBasedMerge(fsResults, vectorResults) {
    // Prefer filesystem results for code-related content
    // Prefer vector results for conceptual content
    const codeResults = fsResults.filter(r => 
      r.path.includes('/src/') || r.path.includes('.py') || r.path.includes('.js')
    );
    
    const conceptualResults = vectorResults.filter(r => 
      r.path && (r.path.includes('strategies.') || r.path.includes('risk.') || r.path.includes('decisions.'))
    );
    
    const otherResults = [
      ...fsResults.filter(r => !codeResults.includes(r)),
      ...vectorResults.filter(r => !conceptualResults.includes(r))
    ].sort((a, b) => b.score - a.score);
    
    return [
      ...codeResults.map(r => ({ ...r, search_type: 'filesystem' })),
      ...conceptualResults.map(r => ({ ...r, search_type: 'vector' })),
      ...otherResults.slice(0, 5).map(r => ({ ...r, search_type: r.source_type || 'unknown' }))
    ].slice(0, this.config.thresholds.max_total_passages);
  }

  /**
   * Main search orchestration method
   */
  async search(query, options = {}) {
    console.log(`🔍 Processing query: "${query}"`);
    
    // Classify query to determine routing strategy
    const classification = await this.classifyQuery(query);
    console.log(`📊 Classification: ${classification.route} (confidence: ${classification.confidence.toFixed(2)})`);
    
    let searchResults;
    
    // Execute search based on classification
    switch (classification.route) {
      case 'fs_first':
        searchResults = await this.filesystemSearch(query, options);
        
        // Escalate to vector search if results are insufficient
        if (await this.shouldEscalate(searchResults.results, 'filesystem')) {
          console.log('⬆️ Escalating to vector search');
          const vectorResults = await this.vectorSearch(query, options);
          searchResults = await this.combineEscalatedResults(searchResults, vectorResults);
        }
        break;
        
      case 'rag_first':
        searchResults = await this.vectorSearch(query, options);
        
        // Escalate to filesystem search if results are insufficient
        if (await this.shouldEscalate(searchResults.results, 'vector')) {
          console.log('⬆️ Escalating to filesystem search');
          const fsResults = await this.filesystemSearch(query, options);
          searchResults = await this.combineEscalatedResults(searchResults, fsResults);
        }
        break;
        
      case 'hybrid':
        searchResults = await this.hybridSearch(query, options);
        break;
        
      default:
        // Default to RAG-first
        searchResults = await this.vectorSearch(query, options);
    }
    
    // Apply post-processing
    searchResults.results = this.applyCanonicalBoosting(searchResults.results);
    searchResults.results = this.applyRiskWarnings(searchResults.results);
    
    // Add classification metadata
    searchResults.classification = classification;
    searchResults.timestamp = new Date().toISOString();
    
    console.log(`✅ Search completed: ${searchResults.results.length} results in ${searchResults.metadata.execution_time}ms`);
    
    return searchResults;
  }

  async combineEscalatedResults(primaryResults, escalatedResults) {
    const combined = [
      ...primaryResults.results,
      ...escalatedResults.results
    ];
    
    // Remove duplicates based on path/content similarity
    const unique = this.deduplicateResults(combined);
    
    return {
      results: unique.slice(0, this.config.thresholds.max_total_passages),
      metadata: {
        search_type: 'escalated',
        execution_time: primaryResults.metadata.execution_time + escalatedResults.metadata.execution_time,
        primary_results: primaryResults.results.length,
        escalated_results: escalatedResults.results.length,
        total_results: unique.length,
        escalation_triggered: true
      }
    };
  }

  deduplicateResults(results) {
    const seen = new Set();
    const unique = [];
    
    for (const result of results) {
      const key = `${result.path || ''}:${result.content?.substring(0, 100) || ''}`;
      
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(result);
      }
    }
    
    return unique.sort((a, b) => b.score - a.score);
  }

  getRelevanceFactors(result, query) {
    const factors = [];
    const filePath = result.data.path.text;
    
    if (filePath.includes('/src/')) factors.push('core_source');
    if (filePath.includes('strategy')) factors.push('strategy_related');
    if (filePath.includes('risk')) factors.push('risk_related');
    if (filePath.includes('api')) factors.push('api_related');
    
    return factors;
  }

  /**
   * Check if search results meet quality thresholds
   */
  async shouldEscalate(results, searchType) {
    // Ensure configuration is loaded
    await this.initPromise;
    
    if (!results || results.length === 0) {
      return true; // No results - definitely escalate
    }
    
    if (results.length < this.config.thresholds.escalate_if_fewer_than_hits) {
      return true; // Too few results
    }
    
    // Check result quality
    const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
    const minScore = searchType === 'filesystem' 
      ? this.config.thresholds.lexical_score_min 
      : this.config.thresholds.semantic_score_min;
    
    if (avgScore < minScore) {
      return true; // Quality too low
    }
    
    return false;
  }

  /**
   * Apply canonical source boosting
   */
  applyCanonicalBoosting(results) {
    return results.map(result => {
      let boost = 1.0;
      
      // Check canonical paths
      for (const canonicalPath of this.config.priority.canonical) {
        const pattern = canonicalPath.replace('*', '.*');
        const regex = new RegExp(pattern);
        
        if (regex.test(result.path || result.source)) {
          boost = 1.3;
          result.canonical_boost = true;
          break;
        }
      }
      
      // Check deprioritized paths
      for (const deprioritizedPath of this.config.priority.deprioritize) {
        const pattern = deprioritizedPath.replace('*', '.*');
        const regex = new RegExp(pattern);
        
        if (regex.test(result.path || result.source)) {
          boost = 0.7;
          result.deprioritized = true;
          break;
        }
      }
      
      result.score = Math.min(result.score * boost, 1.0);
      return result;
    });
  }

  /**
   * Apply risk warnings based on content
   */
  applyRiskWarnings(results) {
    if (!this.policies.risk_warnings) return results;
    
    return results.map(result => {
      const warnings = [];
      
      for (const warning of this.policies.risk_warnings.patterns) {
        const regex = new RegExp(warning.pattern, 'i');
        const content = result.content || result.text || '';
        
        if (regex.test(content)) {
          warnings.push({
            message: warning.warning,
            severity: warning.severity,
            pattern: warning.pattern
          });
        }
      }
      
      if (warnings.length > 0) {
        result.risk_warnings = warnings;
      }
      
      return result;
    });
  }
}

export { HybridQueryRouter };
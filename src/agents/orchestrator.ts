/**
 * Orchestration Agent Integration with Guardrailed Retriever Stack
 * 
 * Provides intelligent context retrieval capabilities for the general orchestration agent
 * using the hybrid FS/RAG routing system.
 */

import { retrieveWithRouting } from '../router.js';
import { loadConfig } from '../config.js';

// Load routing and guardrail configurations
const routingConfig = loadConfig('.routekit/retrieval.router.yaml');
const guardrailConfig = loadConfig('.routekit/policy.guardrails.yaml');

/**
 * Agent Context Retrieval Interface
 * 
 * Provides high-level context retrieval methods for the orchestration agent
 */
export class OrchestratorContext {
  
  /**
   * Gather contextual information for a user task or question
   * 
   * @param query - User query or task description
   * @param options - Retrieval options
   * @returns Contextual information with sources and confidence
   */
  async gatherContext(query: string, options: {
    maxResults?: number;
    includeTrace?: boolean;
    preferCanonical?: boolean;
  } = {}) {
    const {
      maxResults: _maxResults = 10,
      includeTrace = false,
      preferCanonical: _preferCanonical = true
    } = options;

    // Use the routing system to get contextual information
    const results = await retrieveWithRouting(
      query,
      routingConfig,
      guardrailConfig
    );

    // Format results for agent consumption
    const context = {
      query,
      totalHits: results.passages.length,
      confidence: this.calculateConfidence(results.passages),
      canonical: this.extractCanonicalSources(results.passages),
      sources: results.passages.map(passage => ({
        source: passage.source,
        path: passage.path,
        text: passage.text,
        score: passage.score,
        isCanonical: this.isCanonical(passage.path)
      })),
      ...(includeTrace && { trace: results.trace })
    };

    return context;
  }

  /**
   * Search for specific patterns in code or documentation
   * 
   * @param pattern - Search pattern (code, function names, etc.)
   * @param scope - Limit search to specific domains
   */
  async findPatterns(pattern: string, scope: 'code' | 'docs' | 'all' = 'all') {
    const scopedQuery = this.buildScopedQuery(pattern, scope);
    return this.gatherContext(scopedQuery, { 
      maxResults: 15, 
      preferCanonical: false 
    });
  }

  /**
   * Get architectural guidance for implementation decisions
   * 
   * @param domain - The domain area (cli, design-system, templates, etc.)
   * @param question - Specific architectural question
   */
  async getArchitecturalGuidance(domain: string, question: string) {
    const architecturalQuery = `${domain} architecture ${question} patterns best practices`;
    return this.gatherContext(architecturalQuery, {
      maxResults: 8,
      preferCanonical: true,
      includeTrace: true
    });
  }

  /**
   * Discover existing conventions and patterns
   * 
   * @param area - Area to explore (components, commands, templates, etc.)
   */
  async discoverConventions(area: string) {
    const conventionQueries = [
      `${area} patterns conventions structure`,
      `${area} examples implementation`,
      `how to ${area} guidelines`
    ];

    const results = await Promise.all(
      conventionQueries.map(query => this.gatherContext(query, { maxResults: 5 }))
    );

    // Merge and deduplicate results
    return this.mergeContextResults(results);
  }

  /**
   * Plan implementation approach based on existing patterns
   * 
   * @param feature - Feature description
   * @param requirements - Specific requirements or constraints
   */
  async planImplementation(feature: string, requirements: string[] = []) {
    const planningQuery = `implement ${feature} ${requirements.join(' ')} architecture approach`;
    
    const context = await this.gatherContext(planningQuery, {
      maxResults: 12,
      includeTrace: true,
      preferCanonical: true
    });

    // Additional context gathering for related patterns
    const relatedPatterns = await this.findPatterns(feature, 'all');
    
    return {
      ...context,
      relatedPatterns: relatedPatterns.sources,
      recommendations: this.generateRecommendations(context, relatedPatterns)
    };
  }

  // Helper methods

  private calculateConfidence(passages: any[]): 'high' | 'medium' | 'low' {
    if (passages.length === 0) return 'low';
    
    const avgScore = passages.reduce((sum, p) => sum + p.score, 0) / passages.length;
    const canonicalCount = passages.filter(p => this.isCanonical(p.path)).length;
    
    if (avgScore > 0.7 && canonicalCount > 0) return 'high';
    if (avgScore > 0.5 || canonicalCount > 0) return 'medium';
    return 'low';
  }

  private extractCanonicalSources(passages: any[]) {
    return passages
      .filter(p => this.isCanonical(p.path))
      .map(p => ({ path: p.path, score: p.score }));
  }

  private isCanonical(path: string): boolean {
    return path.includes('notes/decisions.') || 
           path.includes('notes/specs.') ||
           path.includes('notes/docs.');
  }

  private buildScopedQuery(pattern: string, scope: 'code' | 'docs' | 'all'): string {
    const scopePrefix = {
      code: 'function class import export',
      docs: 'documentation guide how-to',
      all: ''
    };

    return `${scopePrefix[scope]} ${pattern}`.trim();
  }

  private mergeContextResults(results: any[]) {
    const allSources = results.flatMap(r => r.sources);
    const uniqueSources = this.deduplicateSources(allSources);
    
    return {
      query: 'convention discovery',
      totalHits: uniqueSources.length,
      confidence: results.some(r => r.confidence === 'high') ? 'high' : 'medium',
      sources: uniqueSources.slice(0, 20) // Limit merged results
    };
  }

  private deduplicateSources(sources: any[]) {
    const seen = new Set();
    return sources.filter(source => {
      const key = `${source.path}:${source.text.substring(0, 50)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private generateRecommendations(context: any, patterns: any) {
    const recommendations = [];

    if (context.canonical.length > 0) {
      recommendations.push('Follow established patterns from canonical documentation');
    }

    if (patterns.sources.some((s: any) => s.source === 'fs')) {
      recommendations.push('Existing code patterns found - consider extending rather than creating new');
    }

    if (context.confidence === 'low') {
      recommendations.push('Limited documentation found - consider creating decision document');
    }

    return recommendations;
  }
}

/**
 * Global orchestrator context instance for agent use
 */
export const orchestratorContext = new OrchestratorContext();

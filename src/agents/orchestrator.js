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
    async gatherContext(query, options = {}) {
        const { maxResults: _maxResults = 10, includeTrace = false, preferCanonical: _preferCanonical = true } = options;
        // Use the routing system to get contextual information
        const results = await retrieveWithRouting(query, routingConfig, guardrailConfig);
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
    async findPatterns(pattern, scope = 'all') {
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
    async getArchitecturalGuidance(domain, question) {
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
    async discoverConventions(area) {
        const conventionQueries = [
            `${area} patterns conventions structure`,
            `${area} examples implementation`,
            `how to ${area} guidelines`
        ];
        const results = await Promise.all(conventionQueries.map(query => this.gatherContext(query, { maxResults: 5 })));
        // Merge and deduplicate results
        return this.mergeContextResults(results);
    }
    /**
     * Plan implementation approach based on existing patterns
     *
     * @param feature - Feature description
     * @param requirements - Specific requirements or constraints
     */
    async planImplementation(feature, requirements = []) {
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
    calculateConfidence(passages) {
        if (passages.length === 0)
            return 'low';
        const avgScore = passages.reduce((sum, p) => sum + p.score, 0) / passages.length;
        const canonicalCount = passages.filter(p => this.isCanonical(p.path)).length;
        if (avgScore > 0.7 && canonicalCount > 0)
            return 'high';
        if (avgScore > 0.5 || canonicalCount > 0)
            return 'medium';
        return 'low';
    }
    extractCanonicalSources(passages) {
        return passages
            .filter(p => this.isCanonical(p.path))
            .map(p => ({ path: p.path, score: p.score }));
    }
    isCanonical(path) {
        return path.includes('notes/decisions.') ||
            path.includes('notes/specs.') ||
            path.includes('notes/docs.');
    }
    buildScopedQuery(pattern, scope) {
        const scopePrefix = {
            code: 'function class import export',
            docs: 'documentation guide how-to',
            all: ''
        };
        return `${scopePrefix[scope]} ${pattern}`.trim();
    }
    mergeContextResults(results) {
        const allSources = results.flatMap(r => r.sources);
        const uniqueSources = this.deduplicateSources(allSources);
        return {
            query: 'convention discovery',
            totalHits: uniqueSources.length,
            confidence: results.some(r => r.confidence === 'high') ? 'high' : 'medium',
            sources: uniqueSources.slice(0, 20) // Limit merged results
        };
    }
    deduplicateSources(sources) {
        const seen = new Set();
        return sources.filter(source => {
            const key = `${source.path}:${source.text.substring(0, 50)}`;
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        });
    }
    generateRecommendations(context, patterns) {
        const recommendations = [];
        if (context.canonical.length > 0) {
            recommendations.push('Follow established patterns from canonical documentation');
        }
        if (patterns.sources.some((s) => s.source === 'fs')) {
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

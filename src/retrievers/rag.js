// RAG adapter using existing LanceDB infrastructure.
// Expected to return the same shape as fsSearch but with similarity score in [0,1].
import { query } from '../../scripts/rag/query.mjs';
import { getProjectContext } from '../../scripts/rag/utils.mjs';
import { loadDocumentPerformance } from '../../scripts/mcp/learning-storage.mjs';
import { classifyQueryForLearning } from '../../scripts/mcp/learning-engine.mjs';

/**
 * Phase 2: Strategic Document Routing Patterns
 */
const strategicPatterns = [
    /roadmap|priority|strategic|decision/i,
    /should\s+we\s+(prioritize|implement|continue)/i,
    /next\s+step|move\s+forward/i
];

/**
 * Phase 2: Meta-System Query Routing Patterns  
 */
const metaSystemPatterns = [
    /use\s+the\s+system|preface\s+prompts/i,
    /how\s+(does|do)\s+(rag|orchestrator|system)\s+work/i,
    /interact\s+with|command/i
];

/**
 * Phase 4: Load adaptive document scoring based on learned performance
 * @param {string} queryString - Current query
 * @returns {Object} Document performance boosts
 */
function getAdaptiveDocumentBoosts(queryString) {
    try {
        const queryType = classifyQueryForLearning(queryString);
        const { documents } = loadDocumentPerformance();
        
        const adaptiveBoosts = {};
        
        // Calculate boosts based on document performance for this query type
        Object.entries(documents).forEach(([docId, performance]) => {
            const typeMetrics = performance.queryTypes?.[queryType];
            
            if (typeMetrics && typeMetrics.count >= 3) { // Minimum usage threshold
                const successRate = typeMetrics.success / typeMetrics.count;
                const avgRelevance = typeMetrics.avgRelevance;
                
                // Calculate boost: high success rate + high relevance = higher boost
                const boost = 1.0 + (successRate * 0.5) + (avgRelevance * 0.3);
                
                if (boost > 1.1) { // Only boost if significantly better than baseline
                    adaptiveBoosts[docId] = Math.min(boost, 2.5); // Cap boost at 2.5x
                }
            }
        });
        
        // Log adaptive boosts for debugging
        if (Object.keys(adaptiveBoosts).length > 0) {
            console.error(`🧠 Adaptive boosts for ${queryType}:`, Object.keys(adaptiveBoosts).length, 'documents');
        }
        
        return adaptiveBoosts;
    } catch (error) {
        console.error('Failed to load adaptive boosts:', error.message);
        return {};
    }
}

/**
 * Phase 4: Apply learned document scoring to matches
 * @param {Array} matches - Search results
 * @param {Object} staticBoosts - Phase 2 static boosts
 * @param {Object} adaptiveBoosts - Phase 4 learned boosts
 * @returns {Array} Matches with adaptive scoring applied
 */
function applyAdaptiveScoring(matches, staticBoosts, adaptiveBoosts) {
    return matches.map(match => {
        let boostedScore = match.score;
        let appliedBoosts = [];
        
        // Apply Phase 2 static boosts first
        for (const [pattern, boost] of Object.entries(staticBoosts)) {
            if (match.path.includes(pattern)) {
                boostedScore = Math.min(1.0, boostedScore * boost);
                appliedBoosts.push(`static:${boost}`);
                break;
            }
        }
        
        // Apply Phase 4 adaptive boosts
        for (const [docId, boost] of Object.entries(adaptiveBoosts)) {
            if (match.path.includes(docId) || docId.includes(match.path)) {
                const originalScore = boostedScore;
                boostedScore = Math.min(1.0, boostedScore * boost);
                appliedBoosts.push(`adaptive:${boost.toFixed(2)}`);
                
                console.error(`🧠 Adaptive boost ${match.path}: ${originalScore.toFixed(3)} → ${boostedScore.toFixed(3)} (${boost.toFixed(2)}x)`);
                break;
            }
        }
        
        return {
            ...match,
            score: boostedScore,
            boosts: appliedBoosts.length > 0 ? appliedBoosts : undefined
        };
    });
}

/**
 * Enhanced RAG search with Phase 2 routing improvements and Phase 4 adaptive learning
 */
export async function ragSearch(queryString, opts) {
    try {
        const defaultContext = getProjectContext();
        const context = { ...defaultContext, ...opts?.context };
        const ragDbPath = opts?.db || context.ragDbPath;
        const sourceLabel = opts?.source || "rag";
        
        if (!ragDbPath) {
            return [];
        }
        
        // Phase 2.1: Strategic Document Routing
        let enhancedQuery = queryString;
        let staticBoosts = {};
        
        if (strategicPatterns.some(pattern => pattern.test(queryString))) {
            console.error('🎯 Strategic query detected - enhancing search');
            enhancedQuery += ' notes/decisions/ roadmap implementation priority';
            staticBoosts = {
                'notes/decisions/': 2.0,
                'docs.roadmap': 1.5,
                'how-to.implementation': 1.5,
                'enforcement': 1.3,
                'phase': 1.3
            };
        }
        
        // Phase 2.2: Meta-System Query Handling
        else if (metaSystemPatterns.some(pattern => pattern.test(queryString))) {
            console.error('🔧 Meta-system query detected - enhancing search');
            enhancedQuery += ' docs.rag-system docs.mcp-integration orchestrator';
            staticBoosts = {
                'docs.rag-system': 2.0,
                'docs.mcp-integration': 1.5,
                'orchestrator-engine': 1.5,
                'mcp': 1.3,
                'rag': 1.3
            };
        }
        
        // Phase 4: Load adaptive document boosts based on learning data
        const adaptiveBoosts = getAdaptiveDocumentBoosts(queryString);
        
        const result = await query({
            db: ragDbPath,
            q: enhancedQuery,
            k: opts.k,
            projectSlug: context.projectSlug
        });
        
        if (!result.ok) {
            console.error('RAG search failed:', result.error);
            return [];
        }
        
        // Transform results
        let matches = result.matches.map(match => ({
            source: sourceLabel,
            path: match.path,
            text: match.text,
            score: match.score,
            ts: match.updatedAt,
            relevance: match.score // For learning system compatibility
        }));
        
        // Phase 4: Apply both static and adaptive document scoring
        const totalBoosts = { ...staticBoosts, ...adaptiveBoosts };
        if (Object.keys(totalBoosts).length > 0) {
            matches = applyAdaptiveScoring(matches, staticBoosts, adaptiveBoosts);
            
            // Re-sort by final boosted scores
            matches.sort((a, b) => b.score - a.score);
        }
        
        return matches;
        
    }
    catch (error) {
        console.error('RAG search error:', error.message);
        return [];
    }
}

/**
 * Phase 4: Record document performance for learning
 * @param {string} queryString - Original query
 * @param {Array} matches - Search results
 * @param {number} confidence - Response confidence
 * @param {Array} citations - Valid citations used
 */
export function recordDocumentPerformance(queryString, matches, confidence, citations = []) {
    try {
        const queryType = classifyQueryForLearning(queryString);
        
        // Record performance for each document that was returned
        matches.forEach(match => {
            const wasSuccessful = citations.some(citation => 
                citation.source.includes(match.path) || match.path.includes(citation.source)
            );
            
            const performance = {
                queryType,
                relevance: match.relevance || match.score,
                success: wasSuccessful && confidence >= 0.5,
                confidence
            };
            
            // Import and call updateDocumentPerformance asynchronously
            import('../../scripts/mcp/learning-storage.mjs')
                .then(({ updateDocumentPerformance }) => {
                    updateDocumentPerformance(match.path, performance);
                })
                .catch(error => {
                    console.error('Failed to record document performance:', error.message);
                });
        });
        
    } catch (error) {
        console.error('Error recording document performance:', error.message);
    }
}

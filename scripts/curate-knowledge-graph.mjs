#!/usr/bin/env node

/**
 * Contextual Knowledge Graph Curation Script
 * 
 * Uses RouteKit's retriever stack to identify documentation optimization opportunities:
 * - Detect content duplication across files
 * - Identify atomic component extraction candidates  
 * - Validate transclusion effectiveness
 * - Suggest knowledge graph improvements
 */

import { retrieveWithRouting } from '../src/router.js';
import { getProjectContext } from '../scripts/rag/utils.mjs';

class KnowledgeGraphCurator {
  constructor() {
    this.projectContext = getProjectContext();
    // Simplified routing config for curation
    this.cfg = {
      routing: {
        fs_triggers: [
          { regex: "\\.(js|ts|py|md):\\d+" },
          { regex: "error|fail|exception" },
          { contains_any: ["function", "class", "import", "TODO", "FIXME"] }
        ],
        rag_triggers: [
          { contains_any: ["pattern", "approach", "architecture", "design", "concept"] },
          { min_words: 6 }
        ]
      },
      budget: {
        fs_first: { k: 10, time_ms: 5000 },
        rag_first: { k: 10, time_ms: 10000 }
      },
      thresholds: {
        max_total_passages: 20,
        escalation_threshold: 0.1
      },
      canonical: {
        paths: ["decisions.**", "atoms.**"],
        boost: 0.2
      }
    };
  }

  /**
   * Identify content duplication patterns across documentation
   */
  async identifyDuplication(domain = '') {
    console.log(`🔍 Scanning for content duplication${domain ? ` in domain: ${domain}` : ''}...`);
    
    const queries = [
      'RAG system architecture components',
      'MCP integration patterns',
      'agent enhancement protocol',
      'template engine patterns',
      'project detection logic'
    ];

    const results = [];
    
    for (const query of queries) {
      const searchQuery = domain ? `${query} domain:${domain}` : query;
      const response = await retrieveWithRouting(searchQuery, this.cfg);
      const matches = response.passages || [];
      
      if (matches.length > 3) {
        results.push({
          concept: query,
          duplications: matches.length,
          files: matches.map(m => m.path),
          avgScore: matches.reduce((sum, m) => sum + m.score, 0) / matches.length
        });
      }
    }
    
    return results.sort((a, b) => b.duplications - a.duplications);
  }

  /**
   * Extract atomic component candidates from duplicated content
   */
  async extractAtomicCandidates(duplicationResults) {
    console.log('🧬 Identifying atomic component extraction opportunities...');
    
    const candidates = [];
    
    for (const dup of duplicationResults.slice(0, 5)) { // Top 5 duplications
      const atomicQuery = `core concepts reusable patterns ${dup.concept}`;
      const response = await retrieveWithRouting(atomicQuery, this.cfg);
      const matches = response.passages || [];
      
      candidates.push({
        proposedAtomId: `atoms.${dup.concept.toLowerCase().replace(/\\s+/g, '.')}.md`,
        concept: dup.concept,
        reusability: dup.duplications,
        sourceFiles: dup.files,
        coreContent: matches[0]?.text?.substring(0, 200) + '...'
      });
    }
    
    return candidates;
  }

  /**
   * Validate effectiveness of existing transclusion compositions
   */
  async validateTransclusion() {
    console.log('🔗 Validating transclusion effectiveness...');
    
    // Check for transclusion syntax in documentation
    const transclusionQuery = 'transclusion composition atomic ![[';
    const response = await retrieveWithRouting(transclusionQuery, this.cfg);
    const matches = response.passages || [];
    
    const validationResults = {
      transclusionFiles: matches.length,
      effectiveness: matches.length > 0 ? 'Active' : 'Not Implemented',
      opportunities: matches.length === 0 ? await this.identifyDuplication() : []
    };
    
    return validationResults;
  }

  /**
   * Find knowledge gaps and missing connections
   */
  async findKnowledgeGaps() {
    console.log('🕳️ Identifying knowledge gaps and missing connections...');
    
    const gapQueries = [
      'missing documentation incomplete patterns',
      'broken links undefined references', 
      'cross domain connections missing context',
      'template intelligence implementation gaps',
      'agent coordination missing protocols'
    ];
    
    const gaps = [];
    
    for (const query of gapQueries) {
      const response = await retrieveWithRouting(query, this.cfg);
      const matches = response.passages || [];
      
      if (matches.length < 2) { // Low result count suggests gap
        gaps.push({
          area: query,
          evidence: 'Low retrieval results',
          priority: 'Medium',
          suggestedAction: `Create documentation for: ${query}`
        });
      }
    }
    
    return gaps;
  }

  /**
   * Generate comprehensive curation report
   */
  async generateCurationReport() {
    console.log('📊 Generating comprehensive knowledge graph curation report...');
    
    const duplications = await this.identifyDuplication();
    const atomicCandidates = await this.extractAtomicCandidates(duplications);
    const transclusionValidation = await this.validateTransclusion();
    const knowledgeGaps = await this.findKnowledgeGaps();
    
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        totalDuplications: duplications.length,
        atomicOpportunities: atomicCandidates.length,
        transclusionStatus: transclusionValidation.effectiveness,
        identifiedGaps: knowledgeGaps.length
      },
      duplications,
      atomicCandidates,
      transclusionValidation,
      knowledgeGaps,
      recommendations: this.generateRecommendations(duplications, atomicCandidates, knowledgeGaps)
    };
    
    return report;
  }

  /**
   * Generate actionable recommendations
   */
  generateRecommendations(duplications, candidates, gaps) {
    const recommendations = [];
    
    // Duplication recommendations
    if (duplications.length > 0) {
      recommendations.push({
        priority: 'High',
        action: 'Extract Atomic Components',
        description: `Extract ${duplications.length} identified content duplications into atomic components`,
        impact: 'Reduce maintenance burden, improve consistency',
        effort: 'Medium'
      });
    }
    
    // Transclusion recommendations
    if (candidates.length > 0) {
      recommendations.push({
        priority: 'High',
        action: 'Implement Transclusion',
        description: `Convert ${candidates.length} documents to use transclusion-based composition`,
        impact: 'Achieve DRY documentation, better discoverability',
        effort: 'Low'
      });
    }
    
    // Gap filling recommendations  
    if (gaps.length > 0) {
      recommendations.push({
        priority: 'Medium',
        action: 'Fill Knowledge Gaps',
        description: `Create documentation for ${gaps.length} identified knowledge gaps`,
        impact: 'Improve completeness, enhance AI retrieval',
        effort: 'High'
      });
    }
    
    return recommendations;
  }
}

// CLI execution
async function main() {
  const curator = new KnowledgeGraphCurator();
  
  const action = process.argv[2] || 'report';
  
  switch (action) {
    case 'duplications':
      const dups = await curator.identifyDuplication(process.argv[3]);
      console.log(JSON.stringify(dups, null, 2));
      break;
      
    case 'atomic':
      const allDups = await curator.identifyDuplication();
      const candidates = await curator.extractAtomicCandidates(allDups);
      console.log(JSON.stringify(candidates, null, 2));
      break;
      
    case 'validate':
      const validation = await curator.validateTransclusion();
      console.log(JSON.stringify(validation, null, 2));
      break;
      
    case 'gaps':
      const gaps = await curator.findKnowledgeGaps();
      console.log(JSON.stringify(gaps, null, 2));
      break;
      
    case 'report':
    default:
      const report = await curator.generateCurationReport();
      console.log('\\n' + '='.repeat(80));
      console.log('📚 ROUTEKIT SHELL KNOWLEDGE GRAPH CURATION REPORT');
      console.log('='.repeat(80));
      console.log(`Generated: ${report.timestamp}`);
      console.log(`\\n📈 SUMMARY:`);
      console.log(`- Content Duplications Found: ${report.summary.totalDuplications}`);
      console.log(`- Atomic Opportunities: ${report.summary.atomicOpportunities}`);
      console.log(`- Transclusion Status: ${report.summary.transclusionStatus}`);
      console.log(`- Knowledge Gaps: ${report.summary.identifiedGaps}`);
      
      if (report.recommendations.length > 0) {
        console.log(`\\n🎯 TOP RECOMMENDATIONS:`);
        report.recommendations.forEach((rec, i) => {
          console.log(`${i + 1}. [${rec.priority}] ${rec.action}`);
          console.log(`   ${rec.description}`);
          console.log(`   Impact: ${rec.impact} | Effort: ${rec.effort}\\n`);
        });
      }
      
      console.log('='.repeat(80));
      console.log('Use --help for available commands');
      break;
      
    case '--help':
      console.log(`
RouteKit Shell Knowledge Graph Curator

Commands:
  report        Generate comprehensive curation report (default)  
  duplications [domain]  Find content duplication patterns
  atomic        Identify atomic component extraction candidates
  validate      Validate transclusion effectiveness
  gaps          Find knowledge gaps and missing connections

Examples:
  node scripts/curate-knowledge-graph.mjs
  node scripts/curate-knowledge-graph.mjs duplications rag
  node scripts/curate-knowledge-graph.mjs atomic
      `);
      break;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
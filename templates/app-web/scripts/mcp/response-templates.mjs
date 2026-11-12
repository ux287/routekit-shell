/**
 * Response Templates for Orchestrated Queries
 * Provides structured response formatting for different query types and formats
 */

import { formatRoutingResponse } from "./response-formatter.mjs";

/**
 * Template types matching orchestrator query formats
 */
export const TEMPLATES = {
  GUIDANCE: "guidance",
  COMPARISON: "comparison", 
  IMPLEMENTATION: "implementation",
  REFERENCE: "reference"
};

/**
 * Format orchestrated response using appropriate template
 * @param {Array} passages - Retrieved passages from orchestration
 * @param {string} trace - Combined trace information
 * @param {string} template - Template type to use
 * @param {Object} orchestrationData - Additional orchestration context
 * @returns {Object} Formatted response with orchestration enhancements
 */
export function formatOrchestrationResponse(passages, trace, template, orchestrationData = {}) {
  // Start with base formatted response
  const baseResponse = formatRoutingResponse(passages, trace);
  
  // Apply template-specific formatting
  switch (template) {
    case TEMPLATES.GUIDANCE:
      return formatGuidanceResponse(baseResponse, passages, orchestrationData);
    
    case TEMPLATES.COMPARISON:
      return formatComparisonResponse(baseResponse, passages, orchestrationData);
    
    case TEMPLATES.IMPLEMENTATION:
      return formatImplementationResponse(baseResponse, passages, orchestrationData);
    
    case TEMPLATES.REFERENCE:
      return formatReferenceResponse(baseResponse, passages, orchestrationData);
    
    default:
      return enhanceWithOrchestration(baseResponse, orchestrationData);
  }
}

/**
 * Format guidance-style response with step-by-step structure
 * @param {Object} baseResponse - Base formatted response
 * @param {Array} passages - Retrieved passages
 * @param {Object} orchestrationData - Orchestration context
 * @returns {Object} Enhanced guidance response
 */
function formatGuidanceResponse(baseResponse, passages, orchestrationData) {
  let enhanced = baseResponse.answer;
  
  // Add implementation approach section if we have pattern and implementation steps
  if (orchestrationData.steps && orchestrationData.steps.length > 1) {
    enhanced += `\n\n## Implementation Approach\n\n`;
    
    const patternSteps = orchestrationData.steps.filter(s => 
      s.type === 'pattern_search' || s.type === 'architecture_search'
    );
    const implementationSteps = orchestrationData.steps.filter(s => 
      s.type === 'implementation_search' || s.type === 'implementation_examples'
    );

    if (patternSteps.length > 0 && implementationSteps.length > 0) {
      enhanced += `1. **Follow Existing Patterns**: Based on the patterns found in your codebase\n`;
      enhanced += `2. **Implement Core Functionality**: Using the implementation guidance below\n`;
      enhanced += `3. **Integrate with System**: Ensure compatibility with existing architecture\n`;
      enhanced += `4. **Test and Validate**: Verify the implementation works as expected\n`;
    }
  }

  // Add next steps if we have actionable guidance
  if (hasActionableContent(passages)) {
    enhanced += `\n\n## Next Steps\n\n`;
    enhanced += generateNextSteps(passages, orchestrationData);
  }

  return {
    ...baseResponse,
    answer: enhanced,
    template: TEMPLATES.GUIDANCE,
    orchestration: generateOrchestrationSummary(orchestrationData)
  };
}

/**
 * Format comparison-style response with structured A vs B analysis
 * @param {Object} baseResponse - Base formatted response  
 * @param {Array} passages - Retrieved passages
 * @param {Object} orchestrationData - Orchestration context
 * @returns {Object} Enhanced comparison response
 */
function formatComparisonResponse(baseResponse, passages, orchestrationData) {
  let enhanced = baseResponse.answer;

  // Add comparison structure if we have parallel search results
  const parallelSteps = orchestrationData.steps?.filter(s => s.type === 'parallel_search') || [];
  
  if (parallelSteps.length > 0) {
    enhanced += `\n\n## Comparison Analysis\n\n`;
    
    // Group passages by source/topic for comparison
    const groupedPassages = groupPassagesForComparison(passages, orchestrationData);
    
    if (groupedPassages.length >= 2) {
      enhanced += `### Key Differences\n\n`;
      enhanced += generateComparisonTable(groupedPassages);
      
      enhanced += `\n### Recommendations\n\n`;
      enhanced += generateComparisonRecommendations(groupedPassages);
    }
  }

  return {
    ...baseResponse,
    answer: enhanced,
    template: TEMPLATES.COMPARISON,
    orchestration: generateOrchestrationSummary(orchestrationData)
  };
}

/**
 * Format implementation-style response with complete walkthrough
 * @param {Object} baseResponse - Base formatted response
 * @param {Array} passages - Retrieved passages  
 * @param {Object} orchestrationData - Orchestration context
 * @returns {Object} Enhanced implementation response
 */
function formatImplementationResponse(baseResponse, passages, orchestrationData) {
  let enhanced = baseResponse.answer;

  enhanced += `\n\n## Complete Implementation Guide\n\n`;

  // Add prerequisite section
  enhanced += `### Prerequisites\n\n`;
  enhanced += generatePrerequisites(passages);

  // Add step-by-step implementation
  enhanced += `\n### Implementation Steps\n\n`;
  enhanced += generateImplementationSteps(passages, orchestrationData);

  // Add integration notes
  enhanced += `\n### Integration Notes\n\n`;
  enhanced += generateIntegrationNotes(passages);

  // Add validation steps
  enhanced += `\n### Validation\n\n`;
  enhanced += generateValidationSteps(passages);

  return {
    ...baseResponse,
    answer: enhanced,
    template: TEMPLATES.IMPLEMENTATION,
    orchestration: generateOrchestrationSummary(orchestrationData)
  };
}

/**
 * Format reference-style response with comprehensive information
 * @param {Object} baseResponse - Base formatted response
 * @param {Array} passages - Retrieved passages
 * @param {Object} orchestrationData - Orchestration context  
 * @returns {Object} Enhanced reference response
 */
function formatReferenceResponse(baseResponse, passages, orchestrationData) {
  let enhanced = baseResponse.answer;

  enhanced += `\n\n## Comprehensive Reference\n\n`;

  // Categorize passages by domain/type
  const categorized = categorizePassages(passages);
  
  Object.entries(categorized).forEach(([category, categoryPassages]) => {
    if (categoryPassages.length > 0) {
      enhanced += `### ${category}\n\n`;
      enhanced += generateCategoryReference(categoryPassages);
      enhanced += `\n`;
    }
  });

  // Add cross-references
  enhanced += `## Related Topics\n\n`;
  enhanced += generateCrossReferences(passages);

  return {
    ...baseResponse,
    answer: enhanced,
    template: TEMPLATES.REFERENCE,
    orchestration: generateOrchestrationSummary(orchestrationData)
  };
}

/**
 * Enhance base response with orchestration information
 * @param {Object} baseResponse - Base formatted response
 * @param {Object} orchestrationData - Orchestration context
 * @returns {Object} Enhanced response
 */
function enhanceWithOrchestration(baseResponse, orchestrationData) {
  return {
    ...baseResponse,
    orchestration: generateOrchestrationSummary(orchestrationData)
  };
}

/**
 * Generate orchestration summary for response metadata
 * @param {Object} orchestrationData - Orchestration context
 * @returns {Object} Orchestration summary
 */
function generateOrchestrationSummary(orchestrationData) {
  const successful_steps = orchestrationData.steps?.filter(s => s.success).length || 0;
  const total_steps = orchestrationData.steps?.length || 0;
  
  return {
    steps: total_steps,
    successful_steps,
    queries: orchestrationData.totalQueries || 0,
    duration: orchestrationData.duration || 0,
    complexity: orchestrationData.complexity || 'simple'
  };
}

// Utility functions for response enhancement

function hasActionableContent(passages) {
  // Check if passages contain implementation steps, commands, or actionable guidance
  const actionableIndicators = [
    /npm\s+install|yarn\s+add/i,
    /create\s+.*file/i,
    /add\s+.*to/i,
    /configure|setup|install/i,
    /step\s+\d+|first.*second.*third/i
  ];

  return passages.some(passage => 
    actionableIndicators.some(indicator => indicator.test(passage.text))
  );
}

function generateNextSteps(passages, orchestrationData) {
  let steps = [];
  
  // Extract actionable items from passages
  passages.forEach(passage => {
    if (passage.text.match(/npm\s+install|yarn\s+add/i)) {
      steps.push("Install required dependencies");
    }
    if (passage.text.match(/create\s+.*file/i)) {
      steps.push("Create necessary files and directories");
    }
    if (passage.text.match(/configure|setup/i)) {
      steps.push("Configure the implementation");
    }
    if (passage.text.match(/test|validate/i)) {
      steps.push("Test the implementation");
    }
  });

  // Deduplicate and format
  steps = [...new Set(steps)];
  
  if (steps.length === 0) {
    steps = [
      "Review the implementation details above",
      "Adapt the approach to your specific use case",
      "Test the implementation thoroughly"
    ];
  }

  return steps.map((step, i) => `${i + 1}. ${step}`).join('\n');
}

function groupPassagesForComparison(passages, orchestrationData) {
  // Simple grouping by file path domains for comparison
  const groups = {};
  
  passages.forEach(passage => {
    let domain = 'general';
    
    if (passage.path.includes('cli')) domain = 'CLI';
    else if (passage.path.includes('design')) domain = 'Design System';
    else if (passage.path.includes('template')) domain = 'Templates';
    else if (passage.path.includes('backend')) domain = 'Backend';
    else if (passage.path.includes('frontend')) domain = 'Frontend';
    
    if (!groups[domain]) groups[domain] = [];
    groups[domain].push(passage);
  });

  return Object.entries(groups).filter(([_, passages]) => passages.length > 0);
}

function generateComparisonTable(groupedPassages) {
  if (groupedPassages.length < 2) return "Insufficient data for detailed comparison.\n";
  
  const domains = groupedPassages.map(([domain, _]) => domain);
  let table = `| Aspect | ${domains.join(' | ')} |\n`;
  table += `|${'-'.repeat(8)}|${domains.map(() => '-'.repeat(12)).join('|')}|\n`;
  
  // Add a simple comparison row
  const summaries = groupedPassages.map(([_, passages]) => {
    return passages[0]?.text.substring(0, 50) + "..." || "No data";
  });
  
  table += `| Overview | ${summaries.join(' | ')} |\n`;
  
  return table;
}

function generateComparisonRecommendations(groupedPassages) {
  // Simple recommendation based on available data
  const domains = groupedPassages.map(([domain, _]) => domain);
  
  return `Based on the comparison above, consider:\n\n` +
    `- Choose ${domains[0]} if you need specific functionality shown in the examples\n` +
    `- Consider ${domains[1] || 'alternative approaches'} for different use cases\n` +
    `- Review the specific implementations in the sources for detailed guidance\n`;
}

function generatePrerequisites(passages) {
  const prerequisites = [];
  
  // Extract prerequisites from passages
  passages.forEach(passage => {
    if (passage.text.match(/require|need|prerequisite|before/i)) {
      const lines = passage.text.split('\n');
      lines.forEach(line => {
        if (line.match(/npm|node|install|setup/i)) {
          prerequisites.push(line.trim());
        }
      });
    }
  });

  if (prerequisites.length === 0) {
    return "- Review existing project structure\n- Ensure development environment is set up\n";
  }

  return prerequisites.slice(0, 5).map(p => `- ${p}`).join('\n') + '\n';
}

function generateImplementationSteps(passages, orchestrationData) {
  // Extract step-like content from passages
  let steps = [];
  
  passages.forEach(passage => {
    const lines = passage.text.split('\n');
    lines.forEach(line => {
      if (line.match(/^\d+\.|^-\s|^Step\s+\d+/i)) {
        steps.push(line.trim());
      }
    });
  });

  if (steps.length === 0) {
    return "1. Set up the basic structure\n2. Implement core functionality\n3. Add configuration as needed\n4. Test the implementation\n";
  }

  return steps.slice(0, 8).join('\n') + '\n';
}

function generateIntegrationNotes(passages) {
  // Look for integration-related content
  const integrationContent = passages.filter(passage => 
    passage.text.match(/integrate|connect|configure|setup/i)
  );

  if (integrationContent.length === 0) {
    return "- Ensure compatibility with existing system architecture\n- Follow established patterns and conventions\n";
  }

  return integrationContent.slice(0, 3)
    .map(p => `- ${p.text.substring(0, 100)}...`)
    .join('\n') + '\n';
}

function generateValidationSteps(passages) {
  return "- Verify implementation works as expected\n" +
    "- Test with different scenarios\n" +
    "- Check for any errors or warnings\n" +
    "- Validate against requirements\n";
}

function categorizePassages(passages) {
  const categories = {
    'CLI Tools': [],
    'Design System': [],
    'Templates': [],
    'Configuration': [],
    'Implementation': [],
    'General': []
  };

  passages.forEach(passage => {
    if (passage.path.includes('cli')) {
      categories['CLI Tools'].push(passage);
    } else if (passage.path.includes('design')) {
      categories['Design System'].push(passage);
    } else if (passage.path.includes('template')) {
      categories['Templates'].push(passage);
    } else if (passage.path.includes('config') || passage.path.includes('setup')) {
      categories['Configuration'].push(passage);
    } else if (passage.text.match(/implement|function|class|method/i)) {
      categories['Implementation'].push(passage);
    } else {
      categories['General'].push(passage);
    }
  });

  // Remove empty categories
  Object.keys(categories).forEach(key => {
    if (categories[key].length === 0) {
      delete categories[key];
    }
  });

  return categories;
}

function generateCategoryReference(passages) {
  return passages.slice(0, 3)
    .map(passage => `- **${passage.path}**: ${passage.text.substring(0, 150)}...`)
    .join('\n') + '\n';
}

function generateCrossReferences(passages) {
  // Extract unique domains/topics for cross-referencing
  const domains = new Set();
  
  passages.forEach(passage => {
    if (passage.path.includes('cli')) domains.add('CLI Tools');
    if (passage.path.includes('design')) domains.add('Design System');  
    if (passage.path.includes('template')) domains.add('Templates');
    if (passage.path.includes('docs')) domains.add('Documentation');
  });

  return Array.from(domains)
    .map(domain => `- [[${domain}]] - Related ${domain.toLowerCase()} information`)
    .join('\n') + '\n';
}

/**
 * Combine multiple trace information from orchestrated queries
 * @param {Array} traces - Array of trace strings
 * @returns {string} Combined trace information
 */
export function combineTraces(traces) {
  if (!traces || traces.length === 0) {
    return "ORCHESTRATOR no_traces";
  }

  if (traces.length === 1) {
    return `ORCHESTRATOR single_query ${traces[0]}`;
  }

  return `ORCHESTRATOR multi_step queries=${traces.length} traces=[${traces.join('; ')}]`;
}


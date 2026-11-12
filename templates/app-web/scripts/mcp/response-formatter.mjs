/**
 * Response formatter for routing system output
 * Transforms raw passages and traces into structured, human-readable responses
 */

/**
 * Main formatting orchestrator
 * @param {Array} passages - Array of passage objects from router
 * @param {string} TRACE - Raw trace string from router
 * @returns {Object} Formatted response with answer, citations, and trace
 */
export function formatRoutingResponse(passages, TRACE) {
  if (!passages || passages.length === 0) {
    return {
      answer: "No relevant sources found for this query.",
      citations: "",
      trace: parseTrace(TRACE).readableFormat,
      confidence: 0.0
    };
  }

  const answer = synthesizeAnswer(passages);
  const citations = formatCitations(passages);
  const trace = parseTrace(TRACE).readableFormat;
  const confidence = calculateConfidence(passages, TRACE);

  return {
    answer,
    citations,
    trace,
    confidence
  };
}

/**
 * Combine multiple passages into a coherent response
 * @param {Array} passages - Array of passage objects
 * @returns {string} Synthesized answer
 */
export function synthesizeAnswer(passages) {
  if (!passages || passages.length === 0) {
    return "No relevant information found.";
  }

  // Deduplicate similar content and combine passages
  const uniquePassages = deduplicatePassages(passages);
  
  // Group passages by domain/source for better organization
  const groupedPassages = groupPassagesByDomain(uniquePassages);
  
  // Sort by relevance score (highest first) within each group
  Object.keys(groupedPassages).forEach(domain => {
    groupedPassages[domain].sort((a, b) => (b.score || 0) - (a.score || 0));
  });
  
  // Combine text content with domain awareness
  let combinedText = "";
  const domainKeys = Object.keys(groupedPassages);
  
  if (domainKeys.length > 1) {
    // Multi-domain response - organize by sections
    domainKeys.forEach(domain => {
      const domainPassages = groupedPassages[domain];
      const domainContent = domainPassages
        .map(p => p.text?.trim())
        .filter(text => text && text.length > 10)
        .join('\n\n');
      
      if (domainContent) {
        combinedText += `## ${formatDomainName(domain)}\n\n${domainContent}\n\n`;
      }
    });
  } else {
    // Single domain - simpler format
    const sortedPassages = uniquePassages.sort((a, b) => (b.score || 0) - (a.score || 0));
    combinedText = sortedPassages
      .map(p => p.text?.trim())
      .filter(text => text && text.length > 10)
      .join('\n\n');
  }

  return combinedText || "Unable to synthesize answer from available sources.";
}

/**
 * Group passages by domain based on source path
 * @param {Array} passages - Array of passage objects
 * @returns {Object} Passages grouped by domain
 */
function groupPassagesByDomain(passages) {
  const groups = {};
  
  passages.forEach(passage => {
    const domain = extractDomain(passage.path || passage.source || 'general');
    if (!groups[domain]) {
      groups[domain] = [];
    }
    groups[domain].push(passage);
  });
  
  return groups;
}

/**
 * Extract domain from path
 * @param {string} path - File path or source
 * @returns {string} Domain name
 */
function extractDomain(path) {
  if (path.includes('design')) return 'design';
  if (path.includes('docs')) return 'documentation';
  if (path.includes('how-to')) return 'guides';
  if (path.includes('cli')) return 'cli';
  if (path.includes('template')) return 'templates';
  if (path.includes('prototype')) return 'prototype';
  return 'general';
}

/**
 * Format domain name for display
 * @param {string} domain - Domain identifier
 * @returns {string} Formatted domain name
 */
function formatDomainName(domain) {
  const names = {
    'design': 'Design System',
    'documentation': 'Documentation',
    'guides': 'How-To Guides',
    'cli': 'CLI Tools',
    'templates': 'Templates',
    'prototype': 'Prototype',
    'general': 'General'
  };
  return names[domain] || domain;
}

/**
 * Generate structured source references
 * @param {Array} passages - Array of passage objects
 * @returns {string} Formatted citations
 */
export function formatCitations(passages) {
  if (!passages || passages.length === 0) {
    return "";
  }

  return passages
    .map(passage => {
      const { source, path, line_start, line_end, score } = passage;
      
      // Format citation based on source type
      let citation;
      if (source === 'fs' && line_start && line_end) {
        citation = `\`${path}#L${line_start}-L${line_end}\``;
      } else {
        citation = `\`${path}\``;
      }
      
      // Add relevance score
      const relevance = score ? `(relevance: ${score.toFixed(2)})` : '';
      
      return `- ${citation} ${relevance}`;
    })
    .join('\n');
}

/**
 * Convert trace string to readable format
 * @param {string} TRACE - Raw trace string
 * @returns {Object} Parsed trace information
 */
export function parseTrace(TRACE) {
  if (!TRACE || typeof TRACE !== 'string') {
    return {
      startMethod: 'unknown',
      fsResults: 0,
      ragResults: 0,
      escalated: false,
      readableFormat: 'Routing information unavailable'
    };
  }

  // Parse trace string: "ROUTER start=fs fs=5 rag=0 escalated=no"
  const startMatch = TRACE.match(/start=(\w+)/);
  const fsMatch = TRACE.match(/fs=(\d+)/);
  const ragMatch = TRACE.match(/rag=(\d+)/);
  const escalatedMatch = TRACE.match(/escalated=(\w+)/);

  const startMethod = startMatch ? startMatch[1] : 'unknown';
  const fsResults = fsMatch ? parseInt(fsMatch[1]) : 0;
  const ragResults = ragMatch ? parseInt(ragMatch[1]) : 0;
  const escalated = escalatedMatch ? escalatedMatch[1] === 'yes' : false;

  // Create readable format
  const primary = startMethod === 'fs' ? 'Filesystem search' : 'RAG search';
  const resultText = startMethod === 'fs' ? 
    `${fsResults} results` : 
    `${ragResults} results`;
  
  const escalationText = escalated ? 
    `Yes - also searched ${startMethod === 'fs' ? 'RAG' : 'filesystem'}` : 
    'No';

  const readableFormat = `**Primary**: ${primary} (${resultText})\n**Escalation**: ${escalationText}`;

  return {
    startMethod,
    fsResults,
    ragResults,
    escalated,
    readableFormat
  };
}

/**
 * Calculate confidence score based on passages and routing
 * @param {Array} passages - Array of passage objects
 * @param {string} TRACE - Raw trace string
 * @returns {number} Confidence score between 0 and 1
 */
export function calculateConfidence(passages, TRACE) {
  if (!passages || passages.length === 0) {
    return 0.0;
  }

  // Base score: average of all passage scores
  const scores = passages.map(p => p.score || 0);
  const baseScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;

  // Canonical boost: +0.1 for each decisions/** or specs/** source
  const canonicalCount = passages.filter(p => 
    p.path && (p.path.includes('decisions/') || p.path.includes('specs/'))
  ).length;
  const canonicalBoost = canonicalCount * 0.1;

  // Escalation penalty: -0.05 if escalation occurred with weak results
  const { escalated } = parseTrace(TRACE);
  const escalationPenalty = escalated && baseScore < 0.6 ? -0.05 : 0;

  // Final score clamped between 0 and 1
  const finalScore = Math.min(1.0, Math.max(0.0, baseScore + canonicalBoost + escalationPenalty));

  return Math.round(finalScore * 100) / 100; // Round to 2 decimal places
}

/**
 * Remove duplicate or very similar passages
 * @param {Array} passages - Array of passage objects
 * @returns {Array} Deduplicated passages
 */
function deduplicatePassages(passages) {
  if (!passages || passages.length <= 1) {
    return passages || [];
  }

  const unique = [];
  const seenTexts = new Set();

  for (const passage of passages) {
    if (!passage.text) continue;

    // Create a normalized version for comparison
    const normalized = (passage.text || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
    
    // Skip if we've seen very similar text (first 100 chars)
    const signature = normalized.substring(0, 100);
    
    if (!seenTexts.has(signature)) {
      seenTexts.add(signature);
      unique.push(passage);
    }
  }

  return unique;
}

/**
 * Get confidence level label
 * @param {number} score - Confidence score between 0 and 1
 * @returns {string} Confidence level (Low/Medium/High)
 */
export function getConfidenceLevel(score) {
  if (score >= 0.8) return 'High';
  if (score >= 0.5) return 'Medium';
  return 'Low';
}
/**
 * Response Validation System
 * 
 * Validates responses for citation accuracy and calculates confidence scores
 * to ensure responses are grounded in retrieved documentation.
 */

export const CONFIDENCE_THRESHOLDS = {
  HIGH: 0.7,    // Full response with strong citations
  MEDIUM: 0.4,  // Response with uncertainty indicators
  LOW: 0.25,    // Fallback search or uncertainty response
  CRITICAL: 0.1 // Error handling and user notification
};

/**
 * Extract citations from response text
 * Looks for patterns like (source.md:line), [source.md], source.md references
 */
export function extractCitations(responseText) {
  const citations = [];
  
  // Defensive programming - handle undefined responseText
  if (!responseText || typeof responseText !== 'string') {
    return citations;
  }
  
  // Pattern 1: (source.md:line) format
  const parenthesesPattern = /\(([^)]+\.md(?::\d+)?)\)/g;
  let match;
  while ((match = parenthesesPattern.exec(responseText)) !== null) {
    citations.push({
      source: match[1].split(':')[0], // Remove line number
      fullMatch: match[1],
      type: 'parentheses'
    });
  }
  
  // Pattern 2: [source.md] format
  const bracketsPattern = /\[([^]]+\.md)\]/g;
  while ((match = bracketsPattern.exec(responseText)) !== null) {
    citations.push({
      source: match[1],
      fullMatch: match[1],
      type: 'brackets'
    });
  }
  
  // Pattern 3: Direct source.md references (more liberal matching)
  const directPattern = /([a-zA-Z0-9-_.]+\.md)/g;
  while ((match = directPattern.exec(responseText)) !== null) {
    // Avoid duplicates from previous patterns
    const isDuplicate = citations.some(c => c.source === match[1]);
    if (!isDuplicate) {
      citations.push({
        source: match[1],
        fullMatch: match[1],
        type: 'direct'
      });
    }
  }
  
  return citations;
}

/**
 * Verify citations against retrieved documents
 */
export function verifyCitations(citations, retrievedDocuments) {
  const validCitations = [];
  const invalidCitations = [];
  
  // Defensive programming - handle undefined citations
  if (!citations || !Array.isArray(citations)) {
    return { validCitations, invalidCitations };
  }
  
  // Defensive programming - handle undefined retrievedDocuments  
  if (!retrievedDocuments || !Array.isArray(retrievedDocuments)) {
    // All citations are invalid if no documents to verify against
    return { validCitations, invalidCitations: [...citations] };
  }
  
  for (const citation of citations) {
    const isValid = retrievedDocuments.some(doc => {
      // Check if the document source contains the citation source
      return doc.source && (
        doc.source.includes(citation.source) ||
        citation.source.includes(doc.source.split('/').pop()) // Match filename
      );
    });
    
    if (isValid) {
      validCitations.push(citation);
    } else {
      invalidCitations.push(citation);
    }
  }
  
  return { validCitations, invalidCitations };
}

/**
 * Calculate content grounding score based on response relevance to sources
 */
export function calculateGroundingScore(responseText, retrievedDocuments) {
  if (!retrievedDocuments || retrievedDocuments.length === 0) {
    return 0.2; // Base confidence even without sources (may be from knowledge)
  }
  
  // Extract key terms from response (simplified approach)
  const responseWords = (responseText || '').toString().toLowerCase()
    .split(/\W+/)
    .filter(word => word.length > 3);
  
  let totalRelevanceScore = 0;
  let relevantDocuments = 0;
  
  for (const doc of retrievedDocuments) {
    // Check both content and text fields (passages may use either)
    const docText = doc.content || doc.text || '';
    if (!docText) continue;
    
    const docWords = docText.toString().toLowerCase()
      .split(/\W+/)
      .filter(word => word.length > 3);
    
    // Calculate word overlap
    const commonWords = responseWords.filter(word => 
      docWords.includes(word)
    );
    
    const overlapRatio = commonWords.length / Math.max(responseWords.length, 1);
    
    if (overlapRatio > 0.05) { // Lower threshold - 5% overlap
      totalRelevanceScore += overlapRatio;
      relevantDocuments++;
    }
  }
  
  // More generous scoring
  // Base score of 0.3 if we have documents, plus relevance bonus
  const baseScore = retrievedDocuments.length > 0 ? 0.3 : 0.2;
  const avgRelevance = relevantDocuments > 0 ? 
    totalRelevanceScore / relevantDocuments : 0;
  
  // More gradual scaling
  return Math.min(baseScore + (avgRelevance * 0.7), 1.0);
}

/**
 * Calculate overall confidence score
 */
export function calculateConfidence(citationAccuracy, groundingScore, responseLength = 100) {
  // Defensive programming - ensure all parameters are valid numbers
  const safeCitationAccuracy = typeof citationAccuracy === 'number' ? citationAccuracy : 0.0;
  const safeGroundingScore = typeof groundingScore === 'number' ? groundingScore : 0.0;
  const safeResponseLength = typeof responseLength === 'number' && responseLength > 0 ? responseLength : 100;
  
  // Base confidence from citations
  let confidence = safeCitationAccuracy * 0.6; // 60% weight to citations
  
  // Add grounding score
  confidence += safeGroundingScore * 0.3; // 30% weight to content relevance
  
  // Add length penalty for very short responses
  const lengthFactor = Math.min(safeResponseLength / 50, 1.0); // Penalty for < 50 chars
  confidence += lengthFactor * 0.1; // 10% weight to response completeness
  
  return Math.max(Math.min(confidence, 1.0), 0.0); // Clamp between 0 and 1
}

/**
 * Main validation function
 */
export function validateResponseGrounding(responseText, retrievedDocuments) {
  // Null safety check - prevent undefined/null responseText errors
  if (!responseText || typeof responseText !== 'string') {
    return {
      isValid: false,
      confidenceLevel: 'CRITICAL',
      confidence: 0.0,
      citationAccuracy: 0.0,
      groundingScore: 0.0,
      validCitations: [],
      invalidCitations: [],
      citations: { valid: 0, total: 0, invalid: 0 },
      retrievedDocCount: 0,
      responseLength: 0,
      issues: ['Response text is undefined or invalid']
    };
  }
  
  // Ensure retrievedDocuments is an array
  const safeRetrievedDocs = Array.isArray(retrievedDocuments) ? retrievedDocuments : [];
  
  const citations = extractCitations(responseText);
  const { validCitations, invalidCitations } = verifyCitations(citations, safeRetrievedDocs);
  
  const citationAccuracy = citations.length > 0 ? 
    validCitations.length / citations.length : 0.0;
  
  const groundingScore = calculateGroundingScore(responseText, safeRetrievedDocs);
  const confidence = calculateConfidence(citationAccuracy, groundingScore, responseText.length);
  
  // Determine confidence level
  let confidenceLevel = 'CRITICAL';
  if (confidence >= CONFIDENCE_THRESHOLDS.HIGH) {
    confidenceLevel = 'HIGH';
  } else if (confidence >= CONFIDENCE_THRESHOLDS.MEDIUM) {
    confidenceLevel = 'MEDIUM';
  } else if (confidence >= CONFIDENCE_THRESHOLDS.LOW) {
    confidenceLevel = 'LOW';
  }
  
  return {
    isValid: confidence >= CONFIDENCE_THRESHOLDS.LOW,
    citations: {
      total: citations.length,
      valid: validCitations.length,
      invalid: invalidCitations.length,
      details: { validCitations, invalidCitations }
    },
    citationAccuracy,
    groundingScore,
    confidence,
    confidenceLevel,
    retrievedDocCount: safeRetrievedDocs.length,
    responseLength: responseText.length,
    validCitations,
    invalidCitations
  };
}

/**
 * Create uncertainty response for low confidence scenarios
 */
export function createUncertaintyResponse(query, context = '') {
  return `## Response Uncertainty

I don't have reliable information to answer your question: "${query}"

${context ? `**Context**: ${context}` : ''}

**Why this happened:**
- Limited relevant documentation found
- Low confidence in available sources
- Query may be outside documented scope

**Suggestions:**
- Try rephrasing your question with more specific terms
- Check if documentation exists for this topic
- Consider if this is covered in a different section

**Available Resources:**
- Use \`npm run rag:query -- "your search terms" 5\` to explore documentation
- Check project documentation structure
- Review related topics that might contain the information

*This uncertainty response ensures accuracy over speculation.*`;
}

/**
 * Generate confidence report for debugging
 */
export function generateConfidenceReport(validation) {
  // Defensive programming - handle undefined validation
  if (!validation) {
    return {
      summary: "Confidence: 0.0% (CRITICAL)",
      details: {
        citations: "0/0 valid citations",
        grounding: "0.0% content relevance", 
        sources: "0 documents retrieved",
        length: "0 characters"
      },
      breakdown: {
        citationScore: "0.0% (60% weight)",
        groundingScore: "0.0% (30% weight)",
        lengthBonus: "0.0% (10% weight)"
      }
    };
  }

  // Ensure citations object exists with proper structure
  const citations = validation.citations || { valid: 0, total: 0 };
  // Ensure valid property exists even if citations is malformed
  const validCount = citations.valid ?? 0;
  const totalCount = citations.total ?? 0;
  
  // Ensure confidence and confidenceLevel exist
  const confidence = validation.confidence ?? 0.0;
  const confidenceLevel = validation.confidenceLevel ?? 'CRITICAL';
  
  return {
    summary: `Confidence: ${(confidence * 100).toFixed(1)}% (${confidenceLevel})`,
    details: {
      citations: `${validCount}/${totalCount} valid citations`,
      grounding: `${((validation.groundingScore || 0) * 100).toFixed(1)}% content relevance`,
      sources: `${validation.retrievedDocCount || 0} documents retrieved`,
      length: `${validation.responseLength || 0} characters`
    },
    breakdown: {
      citationScore: `${((validation.citationAccuracy || 0) * 60).toFixed(1)}% (60% weight)`,
      groundingScore: `${((validation.groundingScore || 0) * 30).toFixed(1)}% (30% weight)`,
      lengthBonus: `${((Math.min((validation.responseLength || 0) / 50, 1.0)) * 10).toFixed(1)}% (10% weight)`
    }
  };
}
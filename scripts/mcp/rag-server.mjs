#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { init as ragInit }  from "../rag/init.mjs";
import { embed as ragEmbed } from "../rag/embed.mjs";
import { query as ragQuery } from "../rag/query.mjs";
import { getDefaultRagConfig } from "../rag/utils.mjs";
import { homedir } from "os";
import { writeFileSync, appendFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { retrieveWithRouting } from "../../src/router.js";
import { load } from "js-yaml";
import { formatRoutingResponse, getConfidenceLevel } from "./response-formatter.mjs";
import { 
  analyzeQuery, 
  shouldOrchestrate, 
  executeOrchestration, 
  synthesizeResponse,
  synthesizeResponseWithValidation,
  COMPLEXITY_LEVELS,
  RESPONSE_FORMATS
} from "./orchestrator-engine.mjs";
import { 
  validateResponseGrounding,
  CONFIDENCE_THRESHOLDS,
  generateConfidenceReport
} from "./response-validator.mjs";
import {
  analyzeQuerySuccess,
  findSimilarPatterns,
  generateQueryEnhancements,
  calculateLearningMetrics
} from "./learning-engine.mjs";
import {
  initializeLearningStorage,
  addQueryPattern,
  loadQueryPatterns,
  recordLearningMetrics,
  recordOrchestrationError,
  getErrorAnalysis
} from "./learning-storage.mjs";
import { recordDocumentPerformance } from "../../src/retrievers/rag.js";
import { formatOrchestrationResponse, TEMPLATES } from "./response-templates.mjs";
import { addRagSourcedPath } from "../../packages/mcp-rks/src/shared/session-state.mjs";

// Log file for debugging
const LOG_FILE = join(homedir(), "Documents", "projects", ".routekit", "mcp-debug.log");

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `${timestamp} ${message}\n`;
  console.error(message);
  try {
    appendFileSync(LOG_FILE, logMessage);
  } catch (e) {
    // Ignore file write errors
  }
}

// Get project-specific defaults
const DEFAULTS = getDefaultRagConfig();

// Initialize learning system
let learningEnabled = false;
try {
  log("🧠 Attempting to initialize learning system...");
  const initResult = initializeLearningStorage();
  log(`🧠 Initialization result: ${JSON.stringify(initResult)}`);
  if (initResult.success) {
    learningEnabled = true;
    log("🧠 Learning system initialized successfully");
  } else {
    log(`⚠️ Learning system initialization failed: ${initResult.error}`);
  }
} catch (error) {
  log(`⚠️ Learning system initialization error: ${error.message}`);
  log(`⚠️ Error stack: ${error.stack}`);
}

// Load routing and guardrail configs
let routingConfig, guardrailConfig;
try {
  const routingConfigPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".routekit", "retrieval.router.yaml");
  const guardrailConfigPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".routekit", "policy.guardrails.yaml");
  
  routingConfig = load(readFileSync(routingConfigPath, 'utf8'));
  guardrailConfig = load(readFileSync(guardrailConfigPath, 'utf8'));
  
  log(`Loaded routing config from ${routingConfigPath}`);
  log(`Loaded guardrail config from ${guardrailConfigPath}`);
} catch (error) {
  log(`Warning: Could not load routing configs: ${error.message}`);
  // Fallback to null configs - router will handle gracefully
  routingConfig = null;
  guardrailConfig = null;
}

const server = new Server({
  name: `routekit-rag-${DEFAULTS.projectSlug || 'unknown'}`,
  version: "0.1.0",
}, {
  capabilities: {
    tools: {},
  },
});

// Tool schemas
const ragInitSchema = z.object({
  db: z.string().describe("Absolute path to DB").default(DEFAULTS.db)
});

const ragEmbedSchema = z.object({
  vault: z.string().describe("Absolute path to notes vault").default(DEFAULTS.vault),
  glob: z.string().describe("Glob filter like 'project-slug.*'").default(DEFAULTS.glob),
  db: z.string().describe("Absolute path to DB").default(DEFAULTS.db)
});

const ragQuerySchema = z.object({
  db: z.string().describe("Absolute path to DB").default(DEFAULTS.db),
  q: z.string().min(2).describe("User query / question"),
  k: z.number().int().min(1).max(20).default(DEFAULTS.k),
  raw: z.boolean().optional().describe("Return raw JSON format (for backward compatibility)")
});

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  log("📋 ListTools request received");
  const tools = [
    {
      name: "rag_init",
      description: "Initialize or open a local LanceDB for RAG.",
      inputSchema: {
        type: "object",
        properties: {
          db: {
            type: "string",
            description: "Absolute path to DB",
            default: DEFAULTS.db
          }
        },
        additionalProperties: false
      },
    },
    {
      name: "rag_embed", 
      description: "Embed notes from a Dendron vault into the local vector DB.",
      inputSchema: {
        type: "object",
        properties: {
          vault: {
            type: "string",
            description: "Absolute path to notes vault",
            default: DEFAULTS.vault
          },
          glob: {
            type: "string", 
            description: "Glob filter like 'project-slug.*'",
            default: DEFAULTS.glob
          },
          db: {
            type: "string",
            description: "Absolute path to DB", 
            default: DEFAULTS.db
          }
        },
        additionalProperties: false
      },
    },
    {
      name: "rag_query",
      description: "Similarity search over local RAG DB.",
      inputSchema: {
        type: "object",
        properties: {
          db: {
            type: "string",
            description: "Absolute path to DB",
            default: DEFAULTS.db
          },
          q: {
            type: "string",
            description: "User query / question",
            minLength: 2
          },
          k: {
            type: "integer",
            description: "Number of results to return",
            minimum: 1,
            maximum: 20,
            default: DEFAULTS.k
          },
          raw: {
            type: "boolean",
            description: "Return raw JSON format (for backward compatibility)",
            default: false
          }
        },
        required: ["q"],
        additionalProperties: false
      },
    },
    {
      name: "orchestrator_query",
      description: "Intelligent query orchestration with multi-step coordination and enhanced response synthesis.",
      inputSchema: {
        type: "object",
        properties: {
          q: {
            type: "string",
            description: "User query for intelligent orchestration",
            minLength: 2
          },
          context: {
            type: "string",
            description: "Additional context about current task/domain",
            default: ""
          },
          complexity: {
            type: "string",
            enum: ["simple", "multi-step", "comprehensive"],
            description: "Hint about expected query complexity",
            default: "simple"
          },
          format: {
            type: "string", 
            enum: ["guidance", "comparison", "implementation", "reference"],
            description: "Desired response format",
            default: "guidance"
          },
          raw: {
            type: "boolean",
            description: "Return raw JSON format",
            default: false
          }
        },
        required: ["q"],
        additionalProperties: false
      },
    },
    {
      name: "error_analysis",
      description: "Analyze orchestration error patterns to identify root causes and suggest fixes.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Specific error pattern to analyze (optional)",
            default: ""
          },
          limit: {
            type: "integer", 
            description: "Number of recent errors to analyze",
            default: 20,
            minimum: 1,
            maximum: 100
          }
        },
        additionalProperties: false
      },
    },
  ];
  log(`🔧 Returning ${tools.length} tools`);
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "rag_init": {
        const input = ragInitSchema.parse(args || {});
        const result = await ragInit(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "rag_embed": {
        const input = ragEmbedSchema.parse(args || {});
        const result = await ragEmbed(input);
        return {
          content: [
            {
              type: "text", 
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "rag_query": {
        const input = ragQuerySchema.parse(args || {});

        // Use the router instead of direct RAG
        const { passages, TRACE } = await retrieveWithRouting(input.q, routingConfig, guardrailConfig);

        // Track RAG-sourced paths in session state for provenance
        try {
          for (const p of passages) {
            let filePath = p?.path || p?.source || p?.file;
            if (filePath) {
              // RAG results use Dendron slug names without notes/ prefix
              if (!filePath.startsWith('notes/') && !filePath.startsWith('/') && filePath.endsWith('.md')) {
                filePath = 'notes/' + filePath;
              }
              addRagSourcedPath(filePath, input.q);
            }
          }
        } catch (e) {
          log(`[rag_query] session state tracking failed: ${e?.message}`);
        }

        // Check if raw format is requested (for backward compatibility)
        if (input.raw === true) {
          const result = {
            ok: true,
            matches: passages.slice(0, input.k),
            TRACE
          };
          
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }
        
        // Use formatter for structured response
        const limitedPassages = passages.slice(0, input.k);
        const formatted = formatRoutingResponse(limitedPassages, TRACE);
        const confidenceLevel = getConfidenceLevel(formatted.confidence);
        
        return {
          content: [
            {
              type: "text",
              text: `## Answer\n\n${formatted.answer}`,
            },
            {
              type: "text", 
              text: `\n## Sources\n\n${formatted.citations}`,
            },
            {
              type: "text",
              text: `\n## Routing Decision\n\n${formatted.trace}\n**Confidence**: ${confidenceLevel} (${formatted.confidence})`,
            },
          ],
        };
      }

      case "orchestrator_query": {
        const input = z.object({
          q: z.string().min(2),
          context: z.string().default(""),
          complexity: z.enum(["simple", "multi-step", "comprehensive"]).default("simple"),
          format: z.enum(["guidance", "comparison", "implementation", "reference"]).default("guidance"),
          raw: z.boolean().default(false)
        }).parse(args || {});

        try {
          const queryStartTime = Date.now();
          
          // Phase 4: Query learning and enhancement
          let learningContext = { wasEnhanced: false, similarPatterns: [], appliedEnhancements: [] };
          
          if (learningEnabled) {
            try {
              log(`🧠 Learning: Analyzing query for enhancements`);
              const { patterns } = loadQueryPatterns();
              const similarPatterns = findSimilarPatterns(input.q, patterns, 0.6);
              
              if (similarPatterns.length > 0) {
                const enhancements = generateQueryEnhancements(input.q, similarPatterns);
                if (enhancements.confidence > 0.3) {
                  log(`🧠 Learning: Query enhancement available (${enhancements.confidence.toFixed(2)} confidence)`);
                  learningContext = {
                    wasEnhanced: true,
                    similarPatterns: similarPatterns.length,
                    appliedEnhancements: enhancements.suggestions.terms,
                    originalQuery: input.q,
                    enhancedQuery: enhancements.enhanced
                  };
                }
              }
            } catch (error) {
              log(`⚠️ Learning enhancement error: ${error.message}`);
            }
          }
          
          // Check for explicit command prefixes
          let processedQuery = learningContext.enhancedQuery || input.q;
          let forceOrchestration = false;
          let commandDetected = "";
          
          const commandPatterns = [
            { pattern: /^use\s+the\s+system:\s*/i, name: "Use the system" },
            { pattern: /^query\s+rag:\s*/i, name: "Query RAG" },
            { pattern: /^use\s+orchestration:\s*/i, name: "Use orchestration" },
            { pattern: /^orchestrate:\s*/i, name: "Orchestrate" }
          ];
          
          for (const { pattern, name } of commandPatterns) {
            if (pattern.test(processedQuery)) {
              processedQuery = processedQuery.replace(pattern, "").trim();
              forceOrchestration = true;
              commandDetected = name;
              log(`🔧 Command detected: "${name}" - forcing orchestration`);
              break;
            }
          }
          
          // Ensure parameters are valid before analysis
          const safeProcessedQuery = processedQuery || input.q || "";
          const safeContext = input.context || "";
          
          // Analyze query to determine if orchestration is beneficial (enhanced with self-querying)
          const analysis = await analyzeQuery(safeProcessedQuery, safeContext, routingConfig, guardrailConfig);
          
          // Override complexity if user provided explicit hint
          if (input.complexity !== "simple") {
            analysis.classification.complexity = input.complexity;
            // Recalculate orchestration requirement based on new complexity
            analysis.orchestrationPlan.requiresOrchestration = (input.complexity !== "simple");
          }
          
          // Override format if user provided explicit preference
          if (input.format !== "guidance") {
            analysis.classification.format = input.format;
          }
          
          // Update the plan's query to use the processed query (without command prefix)
          if (forceOrchestration && analysis.orchestrationPlan.steps.length > 0) {
            analysis.orchestrationPlan.steps = analysis.orchestrationPlan.steps.map(step => ({
              ...step,
              query: step.query === input.q ? processedQuery : step.query
            }));
          }

          // Decide whether to use orchestration or direct routing
          // Multiple ways to force orchestration:
          // 1. Explicit command prefixes
          // 2. User-specified complexity parameters 
          // 3. Natural classification requiring orchestration
          const parameterForce = input.complexity === "multi-step" || input.complexity === "comprehensive";
          const shouldUseOrchestration = forceOrchestration || parameterForce || (analysis.orchestrationPlan.requiresOrchestration && shouldOrchestrate(processedQuery, input.context));
          
          log(`🎯 Query analysis: type=${analysis.classification.type}, complexity=${analysis.classification.complexity}, orchestration=${shouldUseOrchestration}, parameterForce=${parameterForce}${commandDetected ? `, command="${commandDetected}"` : ""}`);
          
          if (!shouldUseOrchestration) {
            log(`📍 Using direct routing for simple query`);
            // Fall back to direct routing for simple queries
            const { passages, TRACE } = await retrieveWithRouting(processedQuery, routingConfig, guardrailConfig);

            // Track RAG-sourced paths in session state for provenance
            try {
              for (const p of passages) {
                let filePath = p?.path || p?.source || p?.file;
                if (filePath) {
                  // RAG results use Dendron slug names without notes/ prefix
                  if (!filePath.startsWith('notes/') && !filePath.startsWith('/') && filePath.endsWith('.md')) {
                    filePath = 'notes/' + filePath;
                  }
                  addRagSourcedPath(filePath, input.q);
                }
              }
            } catch (e) {
              log(`[orchestrator_query] session state tracking failed: ${e?.message}`);
            }

            if (input.raw === true) {
              const result = {
                ok: true,
                matches: passages.slice(0, 5),
                TRACE,
                orchestration: {
                  used: false,
                  reason: "Query classified as simple, direct routing preferred"
                }
              };
              
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(result, null, 2),
                  },
                ],
              };
            }
            
            // Use orchestration response formatter even for direct routing
            const template = input.format || analysis.classification.format;
            const orchestrationData = {
              steps: [{ type: 'direct_retrieval', success: true }],
              totalQueries: 1,
              duration: 0,
              complexity: analysis.classification.complexity
            };
            
            const formattedResponse = formatOrchestrationResponse(
              passages, 
              TRACE, 
              template, 
              orchestrationData
            );
            
            return {
              content: [
                {
                  type: "text",
                  text: `## Answer\n\n${formattedResponse.answer}`,
                },
                {
                  type: "text",
                  text: `\n## Sources\n\n${formattedResponse.citations}`,
                },
                {
                  type: "text", 
                  text: `\n## Routing Decision\n\n${formattedResponse.trace}\n**Confidence**: ${getConfidenceLevel(formattedResponse.confidence)} (${formattedResponse.confidence})`,
                },
                {
                  type: "text",
                  text: `\n## Orchestration\n\n**Method**: Direct routing (simple query)\n**Steps**: 1\n**Template**: ${template}`
                }
              ],
            };
          }

          // Execute full orchestration
          log(`🚀 Executing full orchestration with ${analysis.orchestrationPlan.steps.length} steps`);
          const orchestrationResults = await executeOrchestration(
            analysis.orchestrationPlan,
            routingConfig,
            guardrailConfig
          );

          // Track RAG-sourced paths in session state for provenance
          try {
            for (const p of orchestrationResults.allPassages || []) {
              let filePath = p?.path || p?.source || p?.file;
              if (filePath) {
                // RAG results use Dendron slug names without notes/ prefix
                if (!filePath.startsWith('notes/') && !filePath.startsWith('/') && filePath.endsWith('.md')) {
                  filePath = 'notes/' + filePath;
                }
                addRagSourcedPath(filePath, input.q);
              }
            }
          } catch (e) {
            log(`[orchestrator_query] session state tracking failed: ${e?.message}`);
          }

          if (input.raw === true) {
            const result = {
              ok: true,
              matches: orchestrationResults.allPassages.slice(0, 10),
              TRACE: orchestrationResults.traces.join("; "),
              orchestration: {
                used: true,
                steps: orchestrationResults.steps.length,
                queries: orchestrationResults.metadata.totalQueries,
                duration: orchestrationResults.metadata.duration,
                plan: analysis.orchestrationPlan
              }
            };
            
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          // Phase 3: Synthesize enhanced response with validation
          log(`🔍 Applying Phase 3 validation and confidence system`);
          let validatedResponse;
          try {
            validatedResponse = await synthesizeResponseWithValidation(
              orchestrationResults,
              input.format || analysis.classification.format,
              analysis,
              routingConfig,
              guardrailConfig
            );
          } catch (error) {
            if (error.needsEscalation) {
              log(`🚨 Critical confidence failure - needs escalation to filesystem search`);
              // Return a special error that signals escalation is needed
              throw new Error(`ESCALATION_NEEDED: ${error.message}`);
            }
            throw error; // Re-throw other errors
          }

          // Check if fallback was applied
          if (validatedResponse.fallbackApplied) {
            log(`🔄 Fallback applied due to low confidence: ${validatedResponse.validation?.confidenceLevel || 'UNKNOWN'}`);
            
            return {
              content: [
                {
                  type: "text",
                  text: validatedResponse.content,
                },
                {
                  type: "text",
                  text: `\n## Confidence Report\n\n${generateConfidenceReport(validatedResponse.validation).summary}`,
                }
              ],
            };
          }

          // Normal high-confidence response path
          const template = input.format || analysis.classification.format;
          const orchestrationData = {
            steps: orchestrationResults.steps,
            totalQueries: orchestrationResults.metadata.totalQueries,
            duration: orchestrationResults.metadata.duration,
            complexity: analysis.classification.complexity
          };

          const enhancedResponse = formatOrchestrationResponse(
            orchestrationResults.allPassages,
            orchestrationResults.traces.join("; "),
            template,
            orchestrationData
          );

          // Add confidence indicators if available
          let confidenceSection = "";
          if (validatedResponse.confidenceIndicators) {
            const indicators = validatedResponse.confidenceIndicators;
            confidenceSection = `\n## Response Confidence\n\n**${indicators.indicator}** (${indicators.confidence}%)\n\n${indicators.explanation}\n\n**Validation Details**: ${indicators.citations.valid}/${indicators.citations.total} valid citations from ${indicators.sources} sources`;
          }

          log(`✅ Orchestration complete: ${orchestrationResults.steps.length} steps, ${orchestrationResults.metadata.totalQueries} queries, ${orchestrationResults.metadata.duration}ms`);
          log(`📊 Validation: ${((validatedResponse.validation?.confidence ?? 0) * 100).toFixed(1)}% confidence (${validatedResponse.validation?.confidenceLevel || 'UNKNOWN'})`);
          
          // Phase 4: Learn from this query and response
          if (learningEnabled) {
            const totalDuration = Date.now() - queryStartTime;
            
            // Async learning - don't block response
            setTimeout(async () => {
              try {
                // Analyze and store query pattern
                const queryPattern = analyzeQuerySuccess(
                  input.q,
                  orchestrationResults.allPassages,
                  validatedResponse.validation?.confidence ?? 0,
                  null // No explicit user feedback yet
                );
                
                await addQueryPattern(queryPattern);
                
                // Record document performance
                if (validatedResponse.validation?.citations?.valid > 0) {
                  recordDocumentPerformance(
                    input.q,
                    orchestrationResults.allPassages,
                    validatedResponse.validation?.confidence ?? 0,
                    validatedResponse.validation?.citations?.details?.validCitations || []
                  );
                }
                
                // Record learning metrics
                const metrics = {
                  query: input.q,
                  queryType: analysis.classification.type,
                  confidence: validatedResponse.validation?.confidence ?? 0,
                  confidenceLevel: validatedResponse.validation?.confidenceLevel || 'UNKNOWN',
                  wasEnhanced: learningContext.wasEnhanced,
                  similarPatterns: learningContext.similarPatterns,
                  orchestrationUsed: true,
                  fallbackApplied: !!validatedResponse.fallbackApplied,
                  duration: totalDuration
                };
                
                await recordLearningMetrics(metrics);
                
                log(`🧠 Learning: Recorded pattern and metrics for query`);
              } catch (error) {
                log(`⚠️ Learning: Failed to record query data: ${error.message}`);
              }
            }, 0);
          }

          const contentSections = [
            {
              type: "text",
              text: `## Answer\n\n${enhancedResponse.answer}`,
            },
            {
              type: "text",
              text: `\n## Sources\n\n${enhancedResponse.citations}`,
            },
            {
              type: "text",
              text: `\n## Routing Decision\n\n${enhancedResponse.trace}\n**Confidence**: ${getConfidenceLevel(enhancedResponse.confidence)} (${enhancedResponse.confidence})`,
            },
            {
              type: "text",
              text: `\n## Orchestration Summary\n\n**Query Type**: ${analysis.classification.type}\n**Template**: ${template}\n**Steps**: ${orchestrationResults.steps.length}\n**Queries**: ${orchestrationResults.metadata.totalQueries}\n**Duration**: ${orchestrationResults.metadata.duration}ms`
            }
          ];

          // Add confidence section if available
          if (confidenceSection) {
            contentSections.push({
              type: "text",
              text: confidenceSection
            });
          }

          return {
            content: contentSections,
          };
          
        } catch (error) {
          log(`❌ Orchestration error: ${error.message}`);
          
          // Check if this is an escalation signal
          const isEscalation = error.message && error.message.includes('ESCALATION_NEEDED');
          
          // Record error for pattern analysis (unless it's intentional escalation)
          if (learningEnabled && !isEscalation) {
            recordOrchestrationError({
              query: input.q,
              complexity: input.complexity,
              context: input.context,
              error: error.message,
              stackTrace: error.stack,
              orchestrationStep: 'orchestration_execution',
              previouslyWorked: false // Could be enhanced to check historical success
            }).catch(err => log(`Failed to record error: ${err.message}`));
          }
          
          // For escalation or other failures, try filesystem search via direct routing
          log(`🔄 ${isEscalation ? 'Escalating to filesystem search' : 'Falling back to direct routing'}`);
          const { passages, TRACE } = await retrieveWithRouting(input.q, routingConfig, guardrailConfig);

          // Track RAG-sourced paths in session state for provenance (even on fallback)
          try {
            for (const p of passages) {
              let filePath = p?.path || p?.source || p?.file;
              if (filePath) {
                // RAG results use Dendron slug names without notes/ prefix
                if (!filePath.startsWith('notes/') && !filePath.startsWith('/') && filePath.endsWith('.md')) {
                  filePath = 'notes/' + filePath;
                }
                addRagSourcedPath(filePath, input.q);
              }
            }
          } catch (e) {
            log(`[orchestrator_query:fallback] session state tracking failed: ${e?.message}`);
          }

          const formatted = formatRoutingResponse(passages.slice(0, 5), TRACE);
          
          return {
            content: [
              {
                type: "text",
                text: `## Answer\n\n${formatted.answer}`,
              },
              {
                type: "text",
                text: `\n## Sources\n\n${formatted.citations}`,
              },
              {
                type: "text",
                text: `\n## Routing Decision\n\n${formatted.trace}\n**Confidence**: ${getConfidenceLevel(formatted.confidence)} (${formatted.confidence})`,
              },
              {
                type: "text",
                text: `\n## Orchestration Note\n\nOrchestration failed (${error.message}), fell back to direct routing.`
              }
            ],
          };
        }
      }

      case "error_analysis": {
        const input = z.object({
          pattern: z.string().default(""),
          limit: z.number().int().min(1).max(100).default(20)
        }).parse(args || {});

        try {
          const analysis = getErrorAnalysis();
          
          // Filter by pattern if specified
          let filteredErrors = analysis.recentErrors;
          if (input.pattern) {
            filteredErrors = analysis.recentErrors.filter(error => 
              error.error.toLowerCase().includes(input.pattern.toLowerCase())
            );
          }
          
          // Limit results
          filteredErrors = filteredErrors.slice(-input.limit);
          
          return {
            content: [
              {
                type: "text",
                text: `# Orchestration Error Analysis\n\n## Summary\n\n- **Total Errors**: ${analysis.summary.totalErrors}\n- **Unique Patterns**: ${analysis.summary.uniquePatterns}\n- **Time Range**: ${analysis.summary.timeRange.first ? new Date(analysis.summary.timeRange.first).toISOString() : 'N/A'} to ${analysis.summary.timeRange.last ? new Date(analysis.summary.timeRange.last).toISOString() : 'N/A'}`
              },
              {
                type: "text", 
                text: `\n## Top Error Patterns\n\n${analysis.topPatterns.map((p, i) => 
                  `${i + 1}. **${p.pattern}**: ${p.count} occurrences\n   - First seen: ${new Date(p.firstSeen).toISOString()}\n   - Last seen: ${new Date(p.lastSeen).toISOString()}\n   - Affected complexities: ${Object.keys(p.complexities).join(', ')}`
                ).join('\n\n')}`
              },
              {
                type: "text",
                text: `\n## Complexity Breakdown\n\n${Object.entries(analysis.complexityBreakdown).map(([complexity, count]) => 
                  `- **${complexity}**: ${count} errors`
                ).join('\n')}`
              },
              {
                type: "text",
                text: `\n## Recent Errors (${filteredErrors.length})\n\n${filteredErrors.map((error, i) => 
                  `${i + 1}. **Query**: "${error.query}"\n   - **Complexity**: ${error.complexity}\n   - **Error**: ${error.error}\n   - **When**: ${new Date(error.timestamp).toISOString()}\n   - **Step**: ${error.orchestrationStep}`
                ).join('\n\n')}`
              },
              {
                type: "text",
                text: `\n## Recommendations\n\n${analysis.recommendations.length > 0 ? 
                  analysis.recommendations.map((rec, i) => 
                    `${i + 1}. **${rec.priority.toUpperCase()}**: ${rec.issue}\n   - **Suggestion**: ${rec.suggestion}\n   - **Affected**: ${rec.affectedComplexities?.join(', ') || 'Various'}`
                  ).join('\n\n') : 
                  'No specific recommendations available. Consider investigating patterns with high frequency.'}`
              }
            ]
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error analyzing orchestration errors: ${error.message}`
              }
            ]
          };
        }
      }

      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${name}`
        );
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${error.message}`
      );
    }
    throw error;
  }
});

// Start the server
async function main() {
  log("🚀 Starting RAG MCP Server...");
  const transport = new StdioServerTransport();
  log("📡 Created stdio transport");
  await server.connect(transport);
  log("✅ RAG MCP Server connected");
  log(`📍 Server name: routekit-rag-${DEFAULTS.projectSlug || 'unknown'}`);
  log("🔧 Available tools: rag_init, rag_embed, rag_query");
}

// Always start the server when this module is loaded
main().catch((error) => {
  console.error("❌ Server error:", error);
  process.exit(1);
});
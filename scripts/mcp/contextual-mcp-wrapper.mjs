#!/usr/bin/env node
/**
 * MCP Server Wrapper for Contextual Intelligence
 * Exposes the contextual query tools to Claude via MCP protocol
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ContextualIntelligenceServer } from './contextual-server.mjs';

class ContextualMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'contextual-intelligence',
        version: '1.0.0',
        description: 'Enhanced trading system intelligence with contextual query routing'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );
    
    this.contextualServer = new ContextualIntelligenceServer();
    this.setupTools();
    this.setupErrorHandling();
  }

  setupTools() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'contextual_query',
            description: 'Intelligent query routing with trading-specific context',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The query to search for'
                },
                domain_hint: {
                  type: 'string',
                  enum: ['strategies', 'risk', 'api', 'workflows', 'analysis', 'portfolio', 'options'],
                  description: 'Optional domain hint for better routing'
                },
                search_depth: {
                  type: 'string',
                  enum: ['quick', 'standard', 'comprehensive'],
                  description: 'Search thoroughness level'
                },
                require_validation: {
                  type: 'boolean',
                  description: 'Require source validation and risk warnings'
                }
              },
              required: ['query']
            }
          },
          {
            name: 'hybrid_search',
            description: 'Search using both filesystem and vector backends simultaneously',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The search query'
                },
                filesystem_weight: {
                  type: 'number',
                  minimum: 0,
                  maximum: 1,
                  description: 'Weight for filesystem results (0-1)'
                },
                vector_weight: {
                  type: 'number',
                  minimum: 0,
                  maximum: 1,
                  description: 'Weight for vector results (0-1)'
                },
                merge_strategy: {
                  type: 'string',
                  enum: ['interleave', 'score_based', 'domain_based'],
                  description: 'Strategy for merging results'
                }
              },
              required: ['query']
            }
          },
          {
            name: 'validate_sources',
            description: 'Validate reliability and freshness of search result sources',
            inputSchema: {
              type: 'object',
              properties: {
                sources: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of source paths to validate'
                },
                validation_level: {
                  type: 'string',
                  enum: ['basic', 'strict', 'trading_grade'],
                  description: 'Level of validation to apply'
                }
              },
              required: ['sources']
            }
          },
          {
            name: 'trading_context_search',
            description: 'Search with trading market context awareness',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The search query'
                },
                market_condition: {
                  type: 'string',
                  enum: ['bull', 'bear', 'sideways', 'volatile', 'crisis'],
                  description: 'Current market condition context'
                },
                risk_level: {
                  type: 'string',
                  enum: ['conservative', 'moderate', 'aggressive'],
                  description: 'Risk tolerance level'
                },
                time_horizon: {
                  type: 'string',
                  enum: ['intraday', 'swing', 'position', 'long_term'],
                  description: 'Trading time horizon'
                }
              },
              required: ['query']
            }
          },
          {
            name: 'get_server_status',
            description: 'Get contextual intelligence server status and statistics',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          }
        ]
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'contextual_query':
            return await this.handleContextualQuery(args);
            
          case 'hybrid_search':
            return await this.handleHybridSearch(args);
            
          case 'validate_sources':
            return await this.handleValidateSources(args);
            
          case 'trading_context_search':
            return await this.handleTradingContextSearch(args);
            
          case 'get_server_status':
            return await this.handleGetStatus();
            
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error executing ${name}: ${error.message}`
            }
          ],
          isError: true
        };
      }
    });
  }

  async handleContextualQuery(args) {
    const { query, domain_hint, search_depth = 'standard', require_validation = true } = args;
    
    const results = await this.contextualServer.contextualQuery(query, {
      domain_hint,
      search_depth,
      require_validation
    });
    
    return {
      content: [
        {
          type: 'text',
          text: this.formatSearchResults(results, 'Contextual Query Results')
        }
      ]
    };
  }

  async handleHybridSearch(args) {
    const { 
      query, 
      filesystem_weight = 0.5, 
      vector_weight = 0.5, 
      merge_strategy = 'score_based' 
    } = args;
    
    const searchOptions = {
      filesystem_weight,
      vector_weight,
      merge_strategy
    };
    
    const results = await this.contextualServer.router.hybridSearch(query, searchOptions);
    
    return {
      content: [
        {
          type: 'text',
          text: this.formatSearchResults(results, 'Hybrid Search Results')
        }
      ]
    };
  }

  async handleValidateSources(args) {
    const { sources, validation_level = 'trading_grade' } = args;
    
    const validation = await this.contextualServer.validateSources(sources);
    
    const report = [
      `# Source Validation Report (${validation_level})`,
      '',
      `✅ Validated: ${validation.validated_sources}`,
      `❌ Failed: ${validation.failed_sources}`,
      `⚠️ Warnings: ${validation.warnings.length}`,
      ''
    ];
    
    if (validation.warnings.length > 0) {
      report.push('## Warnings:');
      validation.warnings.forEach(warning => {
        report.push(`- ${warning}`);
      });
    }
    
    return {
      content: [
        {
          type: 'text',
          text: report.join('\n')
        }
      ]
    };
  }

  async handleTradingContextSearch(args) {
    const { 
      query, 
      market_condition, 
      risk_level = 'conservative', 
      time_horizon 
    } = args;
    
    // Enhance search options with trading context
    const contextualOptions = {
      search_depth: 'comprehensive',
      domain_hint: this.inferDomainFromContext(market_condition, risk_level, time_horizon),
      trading_context: {
        market_condition,
        risk_level,
        time_horizon
      }
    };
    
    const results = await this.contextualServer.contextualQuery(query, contextualOptions);
    
    // Add trading context warnings
    if (results.contextual_warnings) {
      results.contextual_warnings.push(
        ...this.generateTradingContextWarnings(market_condition, risk_level)
      );
    }
    
    return {
      content: [
        {
          type: 'text',
          text: this.formatTradingResults(results, market_condition, risk_level, time_horizon)
        }
      ]
    };
  }

  async handleGetStatus() {
    const status = this.contextualServer.getStatus();
    
    const report = [
      '# Contextual Intelligence Server Status',
      '',
      `🤖 Router: ${status.router_loaded ? '✅ Loaded' : '❌ Not loaded'}`,
      `🗄️ RAG Database: ${status.rag_enabled ? '✅ Connected' : '⚠️ Filesystem only'}`,
      `📊 Search History: ${status.search_history_size} queries`,
      `🧠 Contextual Memory: ${status.contextual_memory_size} patterns`,
      `📈 Success Rate: ${(status.success_rate * 100).toFixed(1)}%`,
      '',
      status.last_query ? `Last Query: ${status.last_query}` : 'No queries yet'
    ];
    
    return {
      content: [
        {
          type: 'text',
          text: report.join('\n')
        }
      ]
    };
  }

  inferDomainFromContext(market_condition, risk_level, time_horizon) {
    if (risk_level === 'aggressive' || market_condition === 'volatile') {
      return 'risk';
    }
    
    if (time_horizon === 'intraday' || time_horizon === 'swing') {
      return 'strategies';
    }
    
    if (market_condition === 'crisis') {
      return 'risk';
    }
    
    return 'strategies'; // default
  }

  generateTradingContextWarnings(market_condition, risk_level) {
    const warnings = [];
    
    if (market_condition === 'volatile' || market_condition === 'crisis') {
      warnings.push({
        type: 'market_volatility',
        message: '🌪️ High volatility markets require enhanced risk management',
        severity: 'high'
      });
    }
    
    if (risk_level === 'aggressive') {
      warnings.push({
        type: 'aggressive_risk',
        message: '⚠️ Aggressive risk level - ensure position sizing aligns with account limits',
        severity: 'high'
      });
    }
    
    if (market_condition === 'bear') {
      warnings.push({
        type: 'bear_market',
        message: '🐻 Bear market conditions - consider defensive strategies',
        severity: 'medium'
      });
    }
    
    return warnings;
  }

  formatSearchResults(results, title) {
    const lines = [
      `# ${title}`,
      '',
      `🎯 Query: "${results.query_metadata?.original_query || 'N/A'}"`,
      `📊 Classification: ${results.classification?.route || 'unknown'} (${(results.classification?.confidence || 0).toFixed(2)})`,
      `⏱️ Execution Time: ${results.query_metadata?.total_execution_time || results.metadata?.execution_time || 0}ms`,
      `📈 Results: ${results.results?.length || 0}`,
      ''
    ];
    
    if (results.contextual_warnings?.length > 0) {
      lines.push('## ⚠️ Contextual Warnings');
      results.contextual_warnings.forEach(warning => {
        lines.push(`- **${warning.severity?.toUpperCase() || 'INFO'}**: ${warning.message}`);
      });
      lines.push('');
    }
    
    if (results.results && results.results.length > 0) {
      lines.push('## 🎯 Results');
      
      results.results.slice(0, 8).forEach((result, i) => {
        const score = result.score ? ` (${result.score.toFixed(2)})` : '';
        const searchType = result.search_type ? ` [${result.search_type}]` : '';
        
        lines.push(`### ${i + 1}. ${result.path || 'Unknown source'}${score}${searchType}`);
        
        if (result.content) {
          const preview = result.content.length > 200 
            ? result.content.substring(0, 200) + '...'
            : result.content;
          lines.push(`\`\`\`\n${preview}\n\`\`\``);
        }
        
        if (result.relevance_factors?.length > 0) {
          lines.push(`**Relevance**: ${result.relevance_factors.join(', ')}`);
        }
        
        lines.push('');
      });
    }
    
    if (results.cross_references?.length > 0) {
      lines.push('## 🔗 Cross-References');
      results.cross_references.forEach(ref => {
        lines.push(`- **${ref.type}** (${ref.domain}): ${ref.suggestion}`);
      });
      lines.push('');
    }
    
    if (results.metadata?.error) {
      lines.push('## ❌ Error');
      lines.push(results.metadata.error);
      lines.push('');
    }
    
    return lines.join('\n');
  }

  formatTradingResults(results, market_condition, risk_level, time_horizon) {
    const contextHeader = [
      `# Trading Context Search Results`,
      '',
      `🏦 Market Condition: ${market_condition || 'N/A'}`,
      `⚖️ Risk Level: ${risk_level || 'N/A'}`,
      `⏰ Time Horizon: ${time_horizon || 'N/A'}`,
      ''
    ];
    
    const mainResults = this.formatSearchResults(results, '').split('\n').slice(2); // Remove title
    
    return [...contextHeader, ...mainResults].join('\n');
  }

  setupErrorHandling() {
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Contextual Intelligence MCP Server running on stdio');
  }
}

// Start the server
const server = new ContextualMCPServer();
server.run().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
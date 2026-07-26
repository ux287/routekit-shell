#!/usr/bin/env node

/**
 * Learning Dashboard Generator for Guardrailed Retriever Stack
 * 
 * Generates an HTML dashboard showing query patterns, tool usage,
 * and optimization opportunities from the learning system.
 */

import fs from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

// Learning system paths
const LEARNING_BASE_PATH = join(homedir(), '.routekit', 'learning');
const PATTERNS_PATH = join(LEARNING_BASE_PATH, 'patterns');
const REPORTS_PATH = join(LEARNING_BASE_PATH, 'reports');

async function loadPatterns() {
  try {
    const [toolSequences, routingRules, crossProject, recommendations] = await Promise.all([
      fs.readFile(join(PATTERNS_PATH, 'tool-sequences.json'), 'utf8').then(JSON.parse).catch(() => ({ sequences: [], transitions: [] })),
      fs.readFile(join(PATTERNS_PATH, 'routing-rules.json'), 'utf8').then(JSON.parse).catch(() => ({ routingReasons: [], queryTypes: [] })),
      fs.readFile(join(PATTERNS_PATH, 'cross-project-patterns.json'), 'utf8').then(JSON.parse).catch(() => []),
      fs.readFile(join(PATTERNS_PATH, 'optimization-recommendations.json'), 'utf8').then(JSON.parse).catch(() => [])
    ]);
    
    return { toolSequences, routingRules, crossProject, recommendations };
  } catch (error) {
    console.error('❌ Failed to load patterns:', error.message);
    return { toolSequences: { sequences: [], transitions: [] }, routingRules: { routingReasons: [], queryTypes: [] }, crossProject: [], recommendations: [] };
  }
}

function generateHTML(patterns) {
  const { toolSequences, routingRules, crossProject, recommendations } = patterns;
  
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Guardrailed Retriever Stack - Learning Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', roboto, sans-serif;
            line-height: 1.6; 
            color: #333; 
            background: #f5f7fa;
        }
        .container { 
            max-width: 1200px; 
            margin: 0 auto; 
            padding: 20px;
        }
        h1, h2 { color: #2c3e50; margin-bottom: 20px; }
        h1 { 
            text-align: center; 
            border-bottom: 3px solid #3498db; 
            padding-bottom: 10px;
            margin-bottom: 30px;
        }
        .dashboard-grid { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); 
            gap: 20px; 
            margin-bottom: 30px;
        }
        .card { 
            background: white; 
            border-radius: 8px; 
            padding: 20px; 
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            border-left: 4px solid #3498db;
        }
        .card h3 { 
            color: #2c3e50; 
            margin-bottom: 15px;
            display: flex;
            align-items: center;
        }
        .card h3::before {
            content: '';
            width: 8px;
            height: 8px;
            background: #3498db;
            border-radius: 50%;
            margin-right: 10px;
        }
        .metric { 
            display: flex; 
            justify-content: space-between; 
            margin-bottom: 10px; 
            padding: 8px 0;
            border-bottom: 1px solid #ecf0f1;
        }
        .metric:last-child { border-bottom: none; }
        .metric-label { font-weight: 500; }
        .metric-value { 
            font-weight: bold; 
            color: #27ae60;
        }
        .sequence-item, .recommendation-item {
            background: #f8f9fa;
            border-radius: 6px;
            padding: 12px;
            margin-bottom: 10px;
            border-left: 3px solid #3498db;
        }
        .sequence-item:last-child, .recommendation-item:last-child { 
            margin-bottom: 0; 
        }
        .sequence-tools { 
            font-family: 'Monaco', 'Consolas', monospace;
            font-size: 14px;
            color: #7f8c8d;
        }
        .quality-high { color: #27ae60; }
        .quality-medium { color: #f39c12; }
        .quality-low { color: #e74c3c; }
        .priority-high { border-left-color: #e74c3c; }
        .priority-medium { border-left-color: #f39c12; }
        .priority-low { border-left-color: #95a5a6; }
        .timestamp {
            text-align: center;
            color: #7f8c8d;
            margin-top: 30px;
            font-size: 14px;
        }
        .summary-stats {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border-radius: 12px;
            padding: 25px;
            margin-bottom: 30px;
            text-align: center;
        }
        .summary-stats h2 { color: white; margin-bottom: 15px; }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 20px;
            margin-top: 20px;
        }
        .stat-item {
            background: rgba(255,255,255,0.1);
            border-radius: 8px;
            padding: 15px;
        }
        .stat-number {
            font-size: 24px;
            font-weight: bold;
            display: block;
        }
        .stat-label {
            font-size: 14px;
            opacity: 0.9;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🧠 Guardrailed Retriever Stack Learning Dashboard</h1>
        
        <div class="summary-stats">
            <h2>Learning System Overview</h2>
            <div class="stats-grid">
                <div class="stat-item">
                    <span class="stat-number">${toolSequences.sequences.length + toolSequences.transitions.length}</span>
                    <span class="stat-label">Patterns Identified</span>
                </div>
                <div class="stat-item">
                    <span class="stat-number">${routingRules.routingReasons.length}</span>
                    <span class="stat-label">Query Types</span>
                </div>
                <div class="stat-item">
                    <span class="stat-number">${crossProject.length}</span>
                    <span class="stat-label">Projects Analyzed</span>
                </div>
                <div class="stat-item">
                    <span class="stat-number">${recommendations.length}</span>
                    <span class="stat-label">Optimizations Found</span>
                </div>
            </div>
        </div>

        <div class="dashboard-grid">
            <div class="card">
                <h3>🔧 Top Tool Sequences</h3>
                ${toolSequences.sequences.slice(0, 5).map(seq => `
                    <div class="sequence-item">
                        <div class="sequence-tools">${seq.sequence}</div>
                        <div class="metric">
                            <span class="metric-label">Usage Count</span>
                            <span class="metric-value">${seq.count}x</span>
                        </div>
                        <div class="metric">
                            <span class="metric-label">Avg Quality</span>
                            <span class="metric-value quality-${seq.avgQuality > 0.7 ? 'high' : seq.avgQuality > 0.4 ? 'medium' : 'low'}">
                                ${(seq.avgQuality * 100).toFixed(1)}%
                            </span>
                        </div>
                    </div>
                `).join('')}
                ${toolSequences.sequences.length === 0 ? '<p>No tool sequences recorded yet. Run some queries to see patterns!</p>' : ''}
            </div>

            <div class="card">
                <h3>🎯 Query Routing Patterns</h3>
                ${routingRules.routingReasons.slice(0, 5).map(reason => `
                    <div class="sequence-item">
                        <div class="metric">
                            <span class="metric-label">${reason.reason.replace(/_/g, ' ')}</span>
                            <span class="metric-value">${reason.count} queries</span>
                        </div>
                        <div class="metric">
                            <span class="metric-label">Success Rate</span>
                            <span class="metric-value quality-${reason.successRate > 0.7 ? 'high' : reason.successRate > 0.4 ? 'medium' : 'low'}">
                                ${(reason.successRate * 100).toFixed(1)}%
                            </span>
                        </div>
                        <div class="metric">
                            <span class="metric-label">Top Tools</span>
                            <span class="metric-value">${reason.topTools.map(t => t.tool).join(', ') || 'None'}</span>
                        </div>
                    </div>
                `).join('')}
                ${routingRules.routingReasons.length === 0 ? '<p>No routing patterns identified yet.</p>' : ''}
            </div>

            <div class="card">
                <h3>🌐 Cross-Project Usage</h3>
                ${crossProject.map(project => `
                    <div class="sequence-item">
                        <div class="metric">
                            <span class="metric-label">Project: ${project.project}</span>
                            <span class="metric-value">${project.count} queries</span>
                        </div>
                        <div class="metric">
                            <span class="metric-label">Avg Tools/Query</span>
                            <span class="metric-value">${project.avgToolsPerQuery}</span>
                        </div>
                        <div class="metric">
                            <span class="metric-label">Top Tools</span>
                            <span class="metric-value">${project.topTools.slice(0, 3).map(t => t.tool).join(', ')}</span>
                        </div>
                    </div>
                `).join('')}
                ${crossProject.length === 0 ? '<p>No cross-project patterns identified yet.</p>' : ''}
            </div>

            <div class="card">
                <h3>💡 Optimization Recommendations</h3>
                ${recommendations.slice(0, 5).map(rec => `
                    <div class="recommendation-item priority-${rec.priority}">
                        <div class="metric">
                            <span class="metric-label">${rec.description}</span>
                            <span class="metric-value">[${rec.priority.toUpperCase()}]</span>
                        </div>
                        <div style="font-size: 14px; color: #7f8c8d; margin-top: 8px;">
                            Type: ${rec.type.replace(/_/g, ' ')}
                        </div>
                    </div>
                `).join('')}
                ${recommendations.length === 0 ? '<p>Run more queries to generate optimization recommendations!</p>' : ''}
            </div>

            <div class="card">
                <h3>📊 Tool Transition Patterns</h3>
                ${toolSequences.transitions.slice(0, 8).map(transition => `
                    <div class="metric">
                        <span class="metric-label sequence-tools">${transition.transition}</span>
                        <span class="metric-value">${transition.count}x</span>
                    </div>
                `).join('')}
                ${toolSequences.transitions.length === 0 ? '<p>No tool transitions recorded yet.</p>' : ''}
            </div>

            <div class="card">
                <h3>📈 Query Type Distribution</h3>
                ${routingRules.queryTypes.slice(0, 6).map(type => `
                    <div class="metric">
                        <span class="metric-label">${type.type.replace(/_/g, ' ')}</span>
                        <span class="metric-value">${type.count}</span>
                    </div>
                `).join('')}
                ${routingRules.queryTypes.length === 0 ? '<p>No query types classified yet.</p>' : ''}
            </div>
        </div>

        <div class="timestamp">
            Dashboard generated: ${new Date().toLocaleString()}
            <br>
            Learning data: <code>~/.routekit/learning/</code>
        </div>
    </div>
</body>
</html>`;
}

async function generateDashboard() {
  try {
    // Ensure reports directory exists
    await fs.mkdir(REPORTS_PATH, { recursive: true });
    
    console.log('📊 Loading learning patterns...');
    const patterns = await loadPatterns();
    
    console.log('🎨 Generating dashboard HTML...');
    const html = generateHTML(patterns);
    
    const dashboardPath = join(REPORTS_PATH, 'retrieval-patterns.html');
    await fs.writeFile(dashboardPath, html, 'utf8');
    
    console.log(`✅ Dashboard generated: ${dashboardPath}`);
    console.log(`🌐 Open in browser: file://${dashboardPath}`);
    
    return dashboardPath;
    
  } catch (error) {
    console.error('❌ Failed to generate dashboard:', error.message);
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateDashboard();
}

export { generateDashboard };
# CLAUDE.md

This file provides essential guidance to Claude Code (claude.ai/code) when working with this **__title__** project. This is a **ROUTEKIT-POWERED APPLICATION** with integrated Guardrailed Retriever Stack that REQUIRES orchestrated query routing.

## 🚨 CRITICAL: MANDATORY ROUTEKIT INTELLIGENCE USAGE

### **ORCHESTRATION-FIRST PROJECT DEVELOPMENT**

**CLAUDE MUST USE `mcp__routekit-rag-__slug__` ORCHESTRATION FOR ALL PROJECT QUESTIONS**

This project has a **FULL GUARDRAILED RETRIEVER STACK** including:
- ✅ **Query Routing** (`src/router.js`)
- ✅ **Orchestration Engine** (`scripts/mcp/orchestrator-engine.mjs`) 
- ✅ **Self-Querying Learning** (`scripts/mcp/dendron-learning.mjs`)
- ✅ **Citation Validation** (`scripts/mcp/response-validator.mjs`)
- ✅ **Pattern Capture** (`notes/learning.*`)

### **MANDATORY QUERY ROUTING PATTERNS**

#### **IMPLEMENTATION QUERIES** → `orchestrator_query(format="implementation")`
- **Never guess how to implement features** - Query: `"How do I implement [feature] in this project?"`
- **Always search existing patterns** - Query: `"Show me examples of [pattern] in this codebase"`
- **Use project-specific guidance** - Query: `"What's the established pattern for [task]?"`

#### **COMPARATIVE QUERIES** → `orchestrator_query(format="comparison")`  
- **Compare approaches contextually** - Query: `"Compare [approach A] vs [approach B] for this project"`
- **Analyze trade-offs with project context** - Query: `"Pros and cons of [option] in this codebase"`

#### **ARCHITECTURAL QUERIES** → `orchestrator_query(format="guidance")`
- **Get project-specific best practices** - Query: `"What's the best approach for [task] in this project?"`
- **Follow established architecture** - Query: `"How should I structure [component] following project patterns?"`

#### **DISCOVERY QUERIES** → `orchestrator_query(format="reference")`
- **Find existing implementations** - Query: `"What [components/utilities/patterns] are available?"`
- **Explore project capabilities** - Query: `"Show me all [routing/styling/data] options in this project"`

### **MANDATORY CITATION ENFORCEMENT**

**ALL TECHNICAL RESPONSES MUST INCLUDE:**
```markdown
## Sources
- `file.ext` (relevance: X.XX)

## Routing Decision  
**Primary**: [routing_method] ([X] results)
**Confidence**: [High/Medium/Low] (X.XX)
```

**ZERO TOLERANCE FOR UNCITED RESPONSES** - If you provide technical guidance without citations, you have FAILED to use the intelligence stack properly.

## Project Architecture (RouteKit-Powered)

**__title__** is a production-ready RouteKit application with full contextual intelligence:

- **Frontend**: React + TypeScript with RouteKit Design System
- **Intelligence**: Complete Guardrailed Retriever Stack with learning
- **Documentation**: RAG-embedded Dendron notes with self-querying optimization
- **AI Integration**: Project-specific MCP servers with pattern capture

## Strict Development Workflow

### **1. MANDATORY: Query Before Code**

**BEFORE writing ANY code:**
1. Use `orchestrator_query` to search existing patterns
2. Verify current project architecture and conventions  
3. Check for existing implementations or similar features
4. Follow established patterns found in the codebase

**VIOLATION**: Writing code without first querying the intelligence stack

### **2. MANDATORY: Use Project Intelligence**

**Commands for Explicit Routing**:
- `"use the system: [query]"` - Forces orchestration
- `"orchestrate: [query]"` - Forces multi-step processing  
- `"query rag: [query]"` - Forces RAG search

**VIOLATION**: Using general knowledge instead of project-specific intelligence

### **3. MANDATORY: Validate Confidence**

- **High Confidence (>0.7)**: Proceed with implementation
- **Medium Confidence (0.3-0.7)**: Request additional context or examples
- **Low Confidence (<0.3)**: Escalate or request filesystem search

**VIOLATION**: Ignoring confidence scores or implementing on low-confidence responses

## Strict Development Guidelines

### **MANDATORY: Code Style and Patterns**

**BEFORE writing ANY code, you MUST:**
1. Query existing patterns: `"Show me examples of [component/pattern] in this codebase"`
2. Verify design system usage: `"What RouteKit Design System components are available?"`
3. Check TypeScript conventions: `"What are the TypeScript patterns used in this project?"`

**VIOLATIONS:**
- Writing components without checking existing patterns
- Using non-RouteKit components without justification
- Ignoring project-specific TypeScript conventions

### **MANDATORY: Documentation Updates**

**FOR EVERY FEATURE ADDITION, you MUST:**
1. Query relevant documentation: `"What documentation exists for [feature area]?"`
2. Update or create notes in `notes/` directory using clean namespace
3. Re-embed after changes: `npm run rag:embed`
4. Verify documentation is searchable via RAG

**VIOLATIONS:**
- Adding features without documenting them
- Creating notes with project prefixes (use clean `learning.*` namespace)
- Forgetting to re-embed documentation changes

### **MANDATORY: MCP Server Usage**

**Available intelligence servers for this project:**
- **RAG Server** (`mcp__routekit-rag-__slug__`) - MANDATORY for all technical queries
- **Dendron Server** - MANDATORY for note management
- **Governance Server** - MANDATORY for code quality validation
- **Contextual Server** - MANDATORY for project-aware assistance

**VIOLATION**: Using any other knowledge source without first querying project-specific intelligence

## Learning System

This project includes a **self-improving AI learning system**:

- **Pattern Capture** - Successful query patterns stored in `notes/learning.*`
- **Routing Optimization** - System learns optimal routing strategies over time  
- **Error Prevention** - Failed patterns documented for future avoidance
- **Confidence Calibration** - Confidence scoring improves with usage

**Learning Documents**:
- `learning.routing-patterns.md` - Query routing optimization patterns
- `learning.error-patterns.md` - Error recognition and prevention
- `learning.confidence-optimization.md` - Confidence scoring improvements

## Project-Specific Context

### **Key Directories**
- `src/` - React application source code
- `notes/` - Dendron documentation and learning patterns  
- `scripts/` - Build, development, and AI integration scripts
- `.routekit/` - RouteKit configuration and policies

### **Important Files**
- `routekit.json` - Project identity and configuration
- `.mcp.json` - MCP server configuration for Claude Code
- `package.json` - Dependencies and scripts
- `.routekit/retrieval.router.yaml` - Query routing configuration
- `.routekit/policy.guardrails.yaml` - AI guardrails and validation rules

### **Development Commands**
- `npm run dev` - Start development server
- `npm run build` - Build for production  
- `npm run test` - Run test suite
- `npm run rag:embed` - Re-embed documentation into RAG system
- `npm run rag:query -- "query text" 5` - Test RAG search

## Communication Style

**Professional and Direct**: Focus on practical implementation details rather than marketing language.

**Context-Aware**: Always query the project's knowledge base before responding to technical questions.

**Learning-Oriented**: Capture successful patterns and learn from interactions to improve future assistance.

## 🚨 CRITICAL CONSTRAINTS - ZERO TOLERANCE

### **ABSOLUTE PROHIBITIONS**
- **NO GIT COMMANDS**: Claude Code is FORBIDDEN from executing git operations
- **NO UNCITED RESPONSES**: Technical guidance without citations is a CRITICAL FAILURE
- **NO GENERAL KNOWLEDGE**: Using non-project-specific information is a VIOLATION
- **NO ASSUMPTIONS**: All project details MUST be verified through RAG queries

### **MANDATORY REQUIREMENTS** 
- **ORCHESTRATION FIRST**: ALL technical questions MUST use `orchestrator_query`
- **CITATION ENFORCEMENT**: ALL responses MUST include `## Sources` and `## Routing Decision`
- **CONFIDENCE VALIDATION**: ALL responses MUST check confidence scores
- **PROJECT-SPECIFIC ONLY**: ALL guidance MUST be based on project documentation

### **VIOLATION CONSEQUENCES**
If you fail to follow these requirements, you have:
1. **FAILED** to use the Guardrailed Retriever Stack properly
2. **VIOLATED** the mandatory orchestration-first development workflow  
3. **IGNORED** the available project intelligence infrastructure
4. **COMPROMISED** the AI-first development experience this project provides

## Project Status

**Current Phase**: __INSTALL_PHASE__ (Generated: __INSTALL_TIMESTAMP__)

This project is **RouteKit-powered** with full contextual intelligence, self-improving query routing, and integrated AI development assistance.
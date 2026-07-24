import React from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, CardContent, CardHeader, Badge } from '@routekit/design';

export default function HomePage() {
  return (
    <div className="px-4 py-8">
      {/* Hero Section */}
      <div className="text-center mb-16">
        <div className="inline-flex items-center gap-2 mb-6">
          <Badge variant="secondary">RouteKit Shell</Badge>
          <Badge variant="outline">AI-Powered Development</Badge>
        </div>
        <h1 className="text-5xl font-bold tracking-tight text-gray-900 sm:text-6xl mb-6">
          __TITLE__
        </h1>
        <p className="text-xl leading-8 text-gray-600 max-w-3xl mx-auto mb-10">
          Built with <strong>RouteKit Shell</strong> — the rapid development framework designed for 
          AI-assisted workflows. From prototype to production in days, not weeks.
        </p>
        <div className="flex items-center justify-center gap-4">
          <Button asChild size="lg">
            <Link to="/docs">Get Started</Link>
          </Button>
          <Button variant="outline" asChild size="lg">
            <Link to="/demo">View Demo</Link>
          </Button>
        </div>
      </div>

      {/* Features Showcase */}
      <div className="mb-16">
        <h2 className="text-2xl font-bold text-center text-gray-900 mb-8">
          Built-in Features
        </h2>
        <div className="grid max-w-4xl mx-auto grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <span className="text-2xl">🤖</span>
                <h3 className="text-lg font-semibold">AI Integration</h3>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 mb-4">
                Built-in RAG system and MCP integration for Claude Code. Your docs become searchable AI context.
              </p>
              <div className="flex gap-2">
                <Badge variant="secondary">RAG</Badge>
                <Badge variant="secondary">MCP</Badge>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <span className="text-2xl">⚡</span>
                <h3 className="text-lg font-semibold">Lightning Fast</h3>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 mb-4">
                Vite + React 18 + TypeScript. Hot reload, instant feedback, zero config needed.
              </p>
              <div className="flex gap-2">
                <Badge variant="secondary">Vite</Badge>
                <Badge variant="secondary">React 18</Badge>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <span className="text-2xl">🎨</span>
                <h3 className="text-lg font-semibold">Design System</h3>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 mb-4">
                Beautiful components built on Tailwind CSS and Radix UI. Accessible and customizable.
              </p>
              <Button variant="outline" size="sm" asChild>
                <Link to="/demo">View Components</Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <span className="text-2xl">📝</span>
                <h3 className="text-lg font-semibold">Documentation</h3>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 mb-4">
                Dendron-powered docs with hierarchical organization. Perfect for AI-assisted development.
              </p>
              <Button variant="outline" size="sm" asChild>
                <Link to="/docs">Browse Docs</Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <span className="text-2xl">🛠️</span>
                <h3 className="text-lg font-semibold">Dev Tools</h3>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 mb-4">
                ESLint, Prettier, TypeScript checking, and testing ready out of the box.
              </p>
              <div className="flex gap-2">
                <Badge variant="secondary">ESLint</Badge>
                <Badge variant="secondary">Prettier</Badge>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <span className="text-2xl">🚀</span>
                <h3 className="text-lg font-semibold">Deploy Ready</h3>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 mb-4">
                Optimized builds for Vercel, Netlify, and traditional hosting. Zero configuration needed.
              </p>
              <Button variant="outline" size="sm" asChild>
                <Link to="/docs">Deploy Guide</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Quick Start Code Example */}
      <div className="mb-16 bg-gray-900 rounded-lg p-8 text-white">
        <h2 className="text-2xl font-bold mb-6 text-center">Get Started in Seconds</h2>
        <div className="max-w-2xl mx-auto">
          <pre className="text-sm bg-gray-800 p-4 rounded overflow-x-auto">
            <code>{`# Install RouteKit CLI
npm install -g @routekit/cli

# Create your project
routekit create my-app --template=web

# Start developing
cd my-app && npm run dev

# Enable AI assistance
npm run mcp:rag`}</code>
          </pre>
        </div>
      </div>

      {/* Getting Started CTA */}
      <div className="text-center py-12 bg-gray-50 rounded-lg">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">
          Ready to build something amazing?
        </h2>
        <p className="text-gray-600 mb-6 max-w-2xl mx-auto">
          Start with RouteKit Shell and go from idea to deployed application in record time. 
          Perfect for prototypes, MVPs, and production applications.
        </p>
        <div className="flex items-center justify-center gap-4">
          <Button size="lg" asChild>
            <Link to="/docs">Read Documentation</Link>
          </Button>
          <Button variant="outline" size="lg" asChild>
            <a href="https://github.com/routekit/shell" target="_blank" rel="noopener noreferrer">
              View on GitHub
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}
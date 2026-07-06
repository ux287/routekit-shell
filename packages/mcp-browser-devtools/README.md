# Browser DevTools MCP Server

A Model Context Protocol (MCP) server that provides browser DevTools capabilities for computed style inspection and element debugging.

## Features

- **get_computed_style**: Inspect computed CSS properties for any element
- **get_element_info**: Get comprehensive element metadata including styles and layout
- Playwright-based implementation for accurate rendering
- Works with localhost development servers

## Installation

```bash
npm install @routekit/mcp-browser-devtools
```

## Usage

### Standalone Server

```bash
npx mcp-browser-devtools
```

### MCP Client Configuration

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "browser-devtools": {
      "command": "npx",
      "args": ["@routekit/mcp-browser-devtools"]
    }
  }
}
```

## Tools

### get_computed_style

Inspect computed CSS properties for an element.

**Parameters:**
- `url` (string): Target URL (e.g., "http://localhost:8080")
- `selector` (string): CSS selector for target element
- `properties` (array, optional): Specific CSS properties to retrieve

**Example:**
```json
{
  "url": "http://localhost:8080",
  "selector": ".hero-headline",
  "properties": ["font-family", "font-size", "color"]
}
```

**Response:**
```json
{
  "selector": ".hero-headline",
  "found": true,
  "styles": {
    "font-family": "\"Source Sans 3\", sans-serif",
    "font-size": "48px",
    "color": "rgb(51, 51, 51)"
  }
}
```

### get_element_info

Get comprehensive element information including computed styles and layout.

**Parameters:**
- `url` (string): Target URL
- `selector` (string): CSS selector for target element

**Example:**
```json
{
  "url": "http://localhost:8080",
  "selector": ".hero-headline"
}
```

**Response:**
```json
{
  "selector": ".hero-headline",
  "found": true,
  "tagName": "H1",
  "id": "",
  "classList": ["hero-headline"],
  "boundingBox": {
    "x": 100,
    "y": 200,
    "width": 600,
    "height": 60
  },
  "computedStyles": {
    "fontFamily": "\"Source Sans 3\", sans-serif",
    "fontSize": "48px",
    "fontWeight": "700",
    "color": "rgb(51, 51, 51)"
  }
}
```

## Common Use Cases

### Debug Font Loading Issues

```json
{
  "tool": "get_computed_style",
  "arguments": {
    "url": "http://localhost:3000",
    "selector": "h1",
    "properties": ["font-family", "font-display"]
  }
}
```

### Inspect Layout Properties

```json
{
  "tool": "get_element_info",
  "arguments": {
    "url": "http://localhost:3000",
    "selector": ".sidebar"
  }
}
```

## Error Handling

When an element is not found:

```json
{
  "selector": ".non-existent",
  "found": false
}
```

When URL is unreachable, the tool will return an error message.

## License

MIT
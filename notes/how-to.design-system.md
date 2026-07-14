---
id: how-to.design-system
title: Design System
desc: Documentation for the RouteKit Shell framework
updated: '2025-09-02T16:22:55.455Z'
created: '2025-09-02T16:22:55.455Z'
---

# RouteKit Design System Usage

## Overview

RouteKit includes a comprehensive design system built on:

- **Tailwind CSS** for utility-first styling
- **@routekit/design** package for consistent components
- **Radix UI** primitives for accessibility
- **Custom design tokens** for brand consistency

## Quick Start

### 1. Import Components

```tsx
import { Button, Card, Badge } from '@routekit/design';

export function MyComponent() {
  return (
    <Card>
      <Button variant="primary">
        Click me <Badge>New</Badge>
      </Button>
    </Card>
  );
}
```

### 2. Use Utility Classes

```tsx
<div className="p-6 bg-gray-50 rounded-lg shadow-sm">
  <h2 className="text-2xl font-bold text-gray-900 mb-4">
    Styled with Tailwind
  </h2>
</div>
```

## Core Components

### Buttons

The Button component supports multiple variants and states:

```tsx
import { Button } from '@routekit/design';

// Variants
<Button variant="primary">Primary Action</Button>
<Button variant="secondary">Secondary Action</Button>
<Button variant="outline">Outline Style</Button>
<Button variant="ghost">Subtle Action</Button>
<Button variant="destructive">Delete Action</Button>

// Sizes
<Button size="sm">Small</Button>
<Button size="default">Default</Button>
<Button size="lg">Large</Button>

// States
<Button disabled>Disabled</Button>
<Button loading>Loading...</Button>
```

### Cards

Cards provide consistent content containers:

```tsx
import { Card, CardHeader, CardContent, CardFooter } from '@routekit/design';

<Card>
  <CardHeader>
    <h3>Card Title</h3>
    <p>Card description</p>
  </CardHeader>
  <CardContent>
    <p>Main content goes here...</p>
  </CardContent>
  <CardFooter>
    <Button>Action</Button>
  </CardFooter>
</Card>
```

### Badges

Badges for status and categorization:

```tsx
import { Badge } from '@routekit/design';

<Badge variant="default">Default</Badge>
<Badge variant="secondary">Secondary</Badge>
<Badge variant="destructive">Error</Badge>
<Badge variant="outline">Outline</Badge>
```

### Form Components

Built-in form components with validation support:

```tsx
import { Input, Label, Button } from '@routekit/design';

<form>
  <div className="space-y-4">
    <div>
      <Label htmlFor="email">Email</Label>
      <Input 
        id="email" 
        type="email" 
        placeholder="Enter your email"
        required
      />
    </div>
    <Button type="submit">Submit</Button>
  </div>
</form>
```

## Layout Patterns

### Page Layout

Use the consistent layout pattern across pages:

```tsx
export default function MyPage() {
  return (
    <div className="px-4 py-8">
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Page Title</h1>
        <p className="mt-2 text-gray-600">Page description</p>
      </div>

      {/* Main Content */}
      <div className="space-y-6">
        {/* Content sections */}
      </div>
    </div>
  );
}
```

### Grid Layouts

Responsive grid patterns:

```tsx
{/* 3-column responsive grid */}
<div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
  {items.map(item => (
    <Card key={item.id}>
      {/* Card content */}
    </Card>
  ))}
</div>

{/* 2-column with sidebar */}
<div className="grid gap-8 lg:grid-cols-4">
  <main className="lg:col-span-3">
    {/* Main content */}
  </main>
  <aside className="lg:col-span-1">
    {/* Sidebar */}
  </aside>
</div>
```

## Color System

### Semantic Colors

RouteKit uses semantic color naming for consistency:

```css
/* Primary colors */
.text-primary      /* Main brand color text */
.bg-primary        /* Main brand color background */
.border-primary    /* Main brand color border */

/* Semantic states */
.text-success      /* Success state (green) */
.text-warning      /* Warning state (yellow) */
.text-destructive  /* Error state (red) */
.text-muted        /* Muted/secondary text */

/* Surface colors */
.bg-background     /* Main background */
.bg-card          /* Card/surface background */
.bg-muted         /* Muted background */
```

### Gray Scale

Consistent gray scale for text hierarchy:

```css
.text-gray-900     /* Primary text (darkest) */
.text-gray-700     /* Secondary text */
.text-gray-600     /* Tertiary text */
.text-gray-500     /* Muted text */
.text-gray-400     /* Disabled text (lightest) */
```

## Typography Scale

### Headings

```tsx
<h1 className="text-4xl font-bold">Main Heading</h1>
<h2 className="text-3xl font-bold">Section Heading</h2>
<h3 className="text-2xl font-semibold">Subsection</h3>
<h4 className="text-xl font-semibold">Minor Heading</h4>
```

### Body Text

```tsx
<p className="text-base">Default body text</p>
<p className="text-lg">Large body text</p>
<p className="text-sm">Small text</p>
<p className="text-xs">Fine print</p>
```

### Text Styles

```tsx
<span className="font-bold">Bold text</span>
<span className="font-semibold">Semibold text</span>
<span className="font-medium">Medium weight</span>
<span className="italic">Italic text</span>
<code className="font-mono">Monospace code</code>
```

## Spacing System

### Consistent Spacing

Use the spacing scale for consistent layouts:

```css
/* Padding */
.p-2    /* 8px */
.p-4    /* 16px */
.p-6    /* 24px */
.p-8    /* 32px */

/* Margins */
.mb-4   /* margin-bottom: 16px */
.mt-6   /* margin-top: 24px */
.mx-8   /* margin-left/right: 32px */

/* Gaps (for flexbox/grid) */
.gap-4  /* 16px gap */
.gap-6  /* 24px gap */
.gap-8  /* 32px gap */
```

### Layout Spacing Patterns

```tsx
{/* Page container */}
<div className="mx-auto max-w-7xl px-4 py-8">

{/* Section spacing */}
<div className="space-y-6">
  <section>...</section>
  <section>...</section>
</div>

{/* Component spacing */}
<Card className="p-6">
  <div className="space-y-4">
    {/* Content with consistent spacing */}
  </div>
</Card>
```

## Responsive Design

### Breakpoints

RouteKit uses Tailwind's responsive breakpoints:

```css
/* Mobile first approach */
.text-base          /* All screens */
.md:text-lg        /* 768px and up */
.lg:text-xl        /* 1024px and up */
.xl:text-2xl       /* 1280px and up */
```

### Common Responsive Patterns

```tsx
{/* Responsive grid */}
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">

{/* Responsive text */}
<h1 className="text-2xl md:text-3xl lg:text-4xl font-bold">

{/* Responsive spacing */}
<div className="p-4 md:p-6 lg:p-8">

{/* Hide/show on different screens */}
<div className="hidden md:block">Desktop only</div>
<div className="md:hidden">Mobile only</div>
```

## Dark Mode Support

RouteKit includes built-in dark mode support:

```tsx
{/* Colors that adapt to dark mode */}
<div className="bg-white dark:bg-gray-900 text-gray-900 dark:text-white">
  <p className="text-gray-600 dark:text-gray-300">
    Text that adapts to theme
  </p>
</div>
```

## Customization

### Extending the Design System

Add custom components that follow the design patterns:

```tsx
// src/components/CustomCard.tsx
import { Card } from '@routekit/design';
import { cn } from '@/lib/utils'; // Utility for class merging

interface CustomCardProps {
  variant?: 'default' | 'highlighted';
  className?: string;
  children: React.ReactNode;
}

export function CustomCard({ 
  variant = 'default', 
  className,
  children 
}: CustomCardProps) {
  return (
    <Card className={cn(
      'transition-colors',
      variant === 'highlighted' && 'border-primary bg-primary/5',
      className
    )}>
      {children}
    </Card>
  );
}
```

### Custom Design Tokens

Extend the design system in `tailwind.config.js`:

```javascript
module.exports = {
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f0f9ff',
          500: '#0ea5e9',
          900: '#0c4a6e',
        }
      },
      spacing: {
        '18': '4.5rem',
        '88': '22rem',
      }
    }
  }
}
```

---

**Next:** [RAG Integration →](routekit-shell.how-to.rag-integration.md)

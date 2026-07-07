---
id: how-to.design-system.layout-patterns
title: Layout Patterns
desc: Design system documentation for RouteKit Shell
updated: '2025-09-02T16:22:55.455Z'
created: '2025-09-02T16:22:55.455Z'
---

# Common Layout Patterns

## Page Layout Pattern

Standard layout for all pages:

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

## Grid Layouts

### 3-Column Responsive Grid

```tsx
<div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
  {items.map(item => (
    <Card key={item.id}>
      <CardHeader>
        <h3>{item.title}</h3>
      </CardHeader>
      <CardContent>
        {item.content}
      </CardContent>
    </Card>
  ))}
</div>
```

### 2-Column with Sidebar

```tsx
<div className="grid gap-8 lg:grid-cols-4">
  <main className="lg:col-span-3">
    {/* Main content */}
  </main>
  <aside className="lg:col-span-1">
    {/* Sidebar */}
  </aside>
</div>
```

### Auto-Fit Grid

```tsx
<div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
  {/* Items will automatically wrap */}
</div>
```

## Container Patterns

### Centered Container

```tsx
<div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
  {/* Content always centered with responsive padding */}
</div>
```

### Content Width Containers

```tsx
{/* Different max widths for different content types */}
<div className="mx-auto max-w-2xl">  {/* Text content */}
<div className="mx-auto max-w-4xl">  {/* Forms and cards */}
<div className="mx-auto max-w-6xl">  {/* Dashboards */}
<div className="mx-auto max-w-7xl">  {/* Full layouts */}
```

## Spacing Patterns

### Section Spacing

```tsx
<div className="space-y-8">        {/* Large sections */}
<div className="space-y-6">        {/* Medium sections */}
<div className="space-y-4">        {/* Small sections */}
```

### Card Padding

```tsx
<Card className="p-6">             {/* Standard card */}
<Card className="p-4 md:p-6">      {/* Responsive card */}
```

## Responsive Patterns

### Breakpoint System

```css
sm:   640px   /* Small devices */
md:   768px   /* Medium devices */
lg:   1024px  /* Large devices */
xl:   1280px  /* Extra large devices */
2xl:  1536px  /* 2X large devices */
```

### Mobile-First Responsive

```tsx
{/* Stack on mobile, grid on larger screens */}
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">

{/* Hide on mobile, show on desktop */}
<div className="hidden md:block">Desktop only</div>

{/* Show on mobile, hide on desktop */}
<div className="md:hidden">Mobile only</div>
```

### Responsive Typography

```tsx
<h1 className="text-2xl md:text-3xl lg:text-4xl font-bold">
  Responsive heading
</h1>
```

### Responsive Spacing

```tsx
<div className="p-4 md:p-6 lg:p-8">
  Responsive padding
</div>
```

## Flexbox Patterns

### Center Content

```tsx
<div className="flex items-center justify-center min-h-screen">
  <div>Centered content</div>
</div>
```

### Space Between

```tsx
<div className="flex items-center justify-between">
  <div>Left content</div>
  <div>Right content</div>
</div>
```

### Vertical Stack

```tsx
<div className="flex flex-col space-y-4">
  <div>Item 1</div>
  <div>Item 2</div>
  <div>Item 3</div>
</div>
```

### Horizontal Row

```tsx
<div className="flex items-center space-x-4">
  <div>Item 1</div>
  <div>Item 2</div>
  <div>Item 3</div>
</div>
```

## Form Layout Patterns

### Stacked Form

```tsx
<form className="space-y-4">
  <div>
    <Label htmlFor="email">Email</Label>
    <Input id="email" type="email" />
  </div>
  <div>
    <Label htmlFor="password">Password</Label>
    <Input id="password" type="password" />
  </div>
  <Button type="submit" className="w-full">
    Submit
  </Button>
</form>
```

### Two-Column Form

```tsx
<form className="grid gap-4 md:grid-cols-2">
  <div>
    <Label htmlFor="firstName">First Name</Label>
    <Input id="firstName" />
  </div>
  <div>
    <Label htmlFor="lastName">Last Name</Label>
    <Input id="lastName" />
  </div>
  <div className="md:col-span-2">
    <Label htmlFor="email">Email</Label>
    <Input id="email" type="email" />
  </div>
</form>
```

---

**Next:** [Form Components →](routekit-shell.how-to.design-system.forms.md)

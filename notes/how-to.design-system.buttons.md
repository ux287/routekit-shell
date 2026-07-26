---
id: 3fimwj027yvagdnr0oac4ea
title: Buttons
desc: Design system documentation for RouteKit Shell
updated: '2025-09-02T16:22:55.456Z'
created: '2025-09-02T16:22:55.456Z'
---

# Button Component Usage

## Basic Import

```tsx
import { Button } from '@routekit/design';
```

## Button Variants

### Primary Button

The main call-to-action button:

```tsx
<Button variant="primary">Save Changes</Button>
<Button>Default is primary</Button>
```

**Use for:**

- Primary actions (Save, Submit, Continue)
- Main navigation actions
- Important confirmations

### Secondary Button

Supporting actions:

```tsx
<Button variant="secondary">Cancel</Button>
```

**Use for:**

- Secondary actions
- Alternative options
- Supporting navigation

### Outline Button

Subtle emphasis:

```tsx
<Button variant="outline">Learn More</Button>
```

**Use for:**

- Less important actions
- Links that look like buttons
- Optional features

### Ghost Button

Minimal emphasis:

```tsx
<Button variant="ghost">Skip</Button>
```

**Use for:**

- Subtle actions
- Text-like buttons
- Navigation items

### Destructive Button

Dangerous actions:

```tsx
<Button variant="destructive">Delete Account</Button>
```

**Use for:**

- Delete actions
- Permanent changes
- Warning confirmations

## Button Sizes

```tsx
<Button size="sm">Small</Button>
<Button size="default">Default</Button>
<Button size="lg">Large</Button>
```

## Button States

### Disabled

```tsx
<Button disabled>Cannot Click</Button>
```

### Loading

```tsx
<Button loading>Processing...</Button>
```

### With Icons

```tsx
import { ArrowRight, Download } from 'lucide-react';

<Button>
  Download <Download className="ml-2 h-4 w-4" />
</Button>

<Button>
  <ArrowRight className="mr-2 h-4 w-4" /> Continue
</Button>
```

## React Router Integration

### As Link

```tsx
<Button asChild>
  <Link to="/dashboard">Go to Dashboard</Link>
</Button>
```

### External Links

```tsx
<Button asChild>
  <a href="https://example.com" target="_blank" rel="noopener noreferrer">
    External Link
  </a>
</Button>
```

## Common Patterns

### Button Groups

```tsx
<div className="flex gap-2">
  <Button variant="outline">Cancel</Button>
  <Button>Save</Button>
</div>
```

### Form Buttons

```tsx
<form onSubmit={handleSubmit}>
  {/* form fields */}
  <div className="flex justify-end gap-2 mt-6">
    <Button type="button" variant="outline" onClick={onCancel}>
      Cancel
    </Button>
    <Button type="submit" loading={isSubmitting}>
      {isSubmitting ? 'Saving...' : 'Save'}
    </Button>
  </div>
</form>
```

### Modal Actions

```tsx
<DialogFooter>
  <Button variant="outline" onClick={onClose}>
    Cancel
  </Button>
  <Button variant="destructive" onClick={onDelete}>
    Delete
  </Button>
</DialogFooter>
```

## Accessibility

### Screen Readers

```tsx
<Button aria-label="Close dialog">
  <X className="h-4 w-4" />
</Button>
```

### Keyboard Navigation

- All buttons are keyboard accessible by default
- Space and Enter keys trigger the action
- Focus management is automatic

---

**Next:** [Card Components →](routekit-shell.how-to.design-system.cards.md)

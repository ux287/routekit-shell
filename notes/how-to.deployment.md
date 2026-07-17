---
id: 6fqqzxnit738gmv1bpaxeuz
title: Deployment
desc: Documentation for the RouteKit Shell framework
updated: '2025-09-02T16:22:55.456Z'
created: '2025-09-02T16:22:55.456Z'
---

# Deploying RouteKit Applications

## Pre-Deployment Checklist

### 1. Production Build Test

```bash
# Test production build locally
npm run build
npm run preview

# Verify all pages load correctly
# Check for build warnings/errors
```

### 2. Update Documentation Index

```bash
# Ensure RAG system is current
npm run rag:embed

# Commit any documentation changes
git add notes/
git commit -m "Update documentation"
```

## Deployment Options

### Vercel (Recommended)

#### Quick Deploy

1. **Connect Repository**
   - Go to [vercel.com](https://vercel.com)
   - Import your Git repository
   - Vercel auto-detects Vite configuration

2. **Configure Build Settings**
   - Build command: `npm run build`
   - Output directory: `dist`
   - Install command: `npm install`

3. **Deploy**
   - Push to main branch for automatic deployment
   - Preview branches available for PRs

#### Custom Configuration

Create `vercel.json` for advanced settings:

```json
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "framework": "vite",
  "rewrites": [
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

### Netlify

#### Quick Deploy

1. **Drag and Drop**

   ```bash
   npm run build
   # Drag dist/ folder to Netlify dashboard
   ```

2. **Git Integration**
   - Connect repository in Netlify dashboard
   - Build command: `npm run build`
   - Publish directory: `dist`

#### Custom Configuration

Create `netlify.toml`:

```toml
[build]
  command = "npm run build"
  publish = "dist"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

### Traditional Hosting

#### Static File Hosting

```bash
# Build for production
npm run build

# Upload dist/ folder contents to your hosting provider
# Ensure your server handles SPA routing
```

#### Server Configuration

For Apache, create `.htaccess` in your document root:

```apache
RewriteEngine On
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.html [L]
```

For Nginx:

```nginx
location / {
  try_files $uri $uri/ /index.html;
}
```

## Environment Configuration

### Environment Variables

Create `.env.production`:

```bash
VITE_API_URL=https://api.yourproject.com
VITE_APP_TITLE=Your Production App
```

### Build-Time Configuration

Vite automatically includes environment variables prefixed with `VITE_`:

```typescript
// Access in your code
const apiUrl = import.meta.env.VITE_API_URL;
const appTitle = import.meta.env.VITE_APP_TITLE;
```

## Performance Optimization

### Build Analysis

```bash
# Analyze bundle size
npm run build -- --analyze

# Preview production build locally
npm run preview
```

### Optimization Techniques

#### Code Splitting

```typescript
// Lazy load routes for smaller initial bundles
import { lazy } from 'react';

const BlogPage = lazy(() => import('./pages/BlogPage'));
const DocsPage = lazy(() => import('./pages/DocsPage'));
```

#### Asset Optimization

```typescript
// In vite.config.ts
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          router: ['react-router-dom']
        }
      }
    }
  }
});
```

## CI/CD Pipeline

### GitHub Actions Example

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Vercel

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Build project
        run: npm run build
      
      - name: Deploy to Vercel
        uses: vercel/action@v1
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
```

### Custom Build Steps

```yaml
- name: Update RAG embeddings
  run: |
    npm run rag:init
    npm run rag:embed
    
- name: Run tests
  run: npm test

- name: Build with optimization
  run: npm run build -- --mode production
```

## Post-Deployment

### Monitoring

- **Vercel Analytics**: Built-in performance monitoring
- **Lighthouse**: Test performance scores
- **Error Tracking**: Integrate Sentry or similar tools

### Performance Checks

```bash
# Test deployed site performance
npx lighthouse https://your-deployed-site.com --view

# Check for broken links
npx linkinator https://your-deployed-site.com
```

## Troubleshooting

### Common Issues

#### 1. 404 Errors on Refresh

**Problem**: Direct navigation to routes returns 404

**Solution**: Configure SPA fallback routing

- Vercel: Add rewrites in `vercel.json`
- Netlify: Add redirects in `netlify.toml`

#### 2. Environment Variables Not Working

**Problem**: Variables are undefined in production

**Solution**: Ensure variables are prefixed with `VITE_`:

```bash
# ✅ Correct
VITE_API_URL=https://api.example.com

# ❌ Won't work
API_URL=https://api.example.com
```

#### 3. Build Size Too Large

**Problem**: Bundle size warnings or slow loading

**Solution**: Implement code splitting and tree shaking:

```typescript
// Use dynamic imports
const HeavyComponent = lazy(() => import('./HeavyComponent'));
```

#### 4. RAG System in Production

**Problem**: RAG embeddings not available in deployed app

**Note**: RAG system is for development only. For production search:

- Use a search service like Algolia
- Generate static search index during build
- Implement server-side search API

---

**Next:** [Customization →](routekit-shell.how-to.customization.md)

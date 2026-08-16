---
id: hyt1mdqgfikkfb7oi9rqzc4
title: Installation
desc: Getting started guide for RouteKit Shell framework
updated: '2025-09-02T16:22:55.451Z'
created: '2025-09-02T16:22:55.451Z'
---

# Installing RouteKit CLI

## Global Installation

### Install via npm

```bash
npm install -g @routekit/cli
```

### Install via yarn

```bash
yarn global add @routekit/cli
```

### Install via pnpm

```bash
pnpm add -g @routekit/cli
```

## Verification

### Check Installation

```bash
routekit --version
```

Expected output:

```
@routekit/cli version 1.0.0
```

### View Available Commands

```bash
routekit --help
```

## Common Installation Issues

### Permission Errors (macOS/Linux)

If you get permission errors, use sudo:

```bash
sudo npm install -g @routekit/cli
```

### Windows Path Issues

Ensure npm's global bin directory is in your PATH:

1. Run `npm config get prefix`
2. Add the returned path to your system PATH

### Node Version Issues

RouteKit requires Node.js 18+. Update if needed:

```bash
# Check version
node --version

# Update using nvm (recommended)
nvm install 18
nvm use 18
```

## Alternative Installation Methods

### Local Installation (Project-specific)

```bash
npx @routekit/cli create my-project
```

### Development Installation

For contributing to RouteKit Shell:

```bash
git clone https://github.com/routekit/shell
cd shell
npm install
npm run build
npm link
```

---

**Next:** [First Project →](routekit-shell.how-to.getting-started.first-project.md)

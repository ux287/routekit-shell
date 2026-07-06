---
id: how-to.branch-topology
title: Branch Topology Configuration
desc: Guide to configuring custom branch workflows in RKS
updated: 1770007400721
created: 1770007400721
---

# Branch Topology Configuration

RKS supports configurable branch workflows to match your team's development process. This guide explains how to configure and use custom branch topologies.

## Overview

Branch topology defines the roles of different branches in your git workflow:

| Role | Purpose | Default |
|------|---------|---------|
| **Working** | Daily development, local commits | `staging` |
| **Integration** | CI/preview builds, shared testing | `staging` |
| **Production** | Stable releases | `main` |

## Default Workflow (Two-Branch)

By default, RKS uses a simple two-branch model where working and integration are the same:

```
working (staging) ─────────────────────► production (main)
         └─ feature branches merge back
```

**Workflow**: `plan → exec → ship`

This is ideal for:
- Solo developers
- Small teams
- Projects without complex CI requirements

## Custom Workflow (Three-Branch)

For projects requiring separate CI/preview builds, configure a three-branch model:

```
working (dev) ──► integration (staging) ──► production (main)
                       │
                  CI/preview builds
```

**Workflow**: `plan → exec → promote → ship`

This is ideal for:
- Teams that want CI builds only on demand
- Projects where builds are expensive
- Workflows requiring batch feature promotion

## Configuration

Branch topology is configured per-project in the project registry (`projects/index.jsonl`):

```json
{
  "id": "my-project",
  "root": "/path/to/project",
  "branches": {
    "working": "dev",
    "integration": "staging",
    "production": "main"
  },
  "workflow": {
    "autoMergeIntegration": false,
    "workingBranchLocal": true
  }
}
```

### Branch Configuration

| Option | Description | Default |
|--------|-------------|---------|
| `branches.working` | Where daily development happens | `staging` |
| `branches.integration` | What triggers CI/preview builds | `staging` |
| `branches.production` | Production release branch | `main` |

### Workflow Configuration

| Option | Description | Default |
|--------|-------------|---------|
| `autoMergeIntegration` | Auto-merge to integration on ship | `true` |
| `workingBranchLocal` | Working branch is local-only | `false` |

## Workflow Comparison

### Default (autoMergeIntegration: true)

```
rks_ship
  └─ commit
  └─ create PR to staging
  └─ merge PR (auto)
  └─ cycle complete
```

Every ship triggers CI/preview builds immediately.

### Custom (autoMergeIntegration: false)

```
rks_ship
  └─ commit
  └─ create PR to staging
  └─ PR stays open (manual review)

rks_promote (when ready)
  └─ merge working → integration
  └─ triggers CI/preview builds
```

You control when builds are triggered by calling `rks_promote`.

## Example: Snacks Workflow

The snacks-11ty-netlify project uses a three-branch model:

```json
{
  "branches": {
    "working": "dev",
    "integration": "staging",
    "production": "main"
  },
  "workflow": {
    "autoMergeIntegration": false,
    "workingBranchLocal": true
  }
}
```

### Daily Workflow

1. **Work on dev branch** (local-only)
   ```
   git checkout dev
   # make changes
   rks_ship { "projectId": "snacks", "message": "add feature" }
   ```

2. **Batch promote when ready for CI**
   ```
   rks_promote { "projectId": "snacks" }
   # Netlify preview build triggers
   ```

3. **Release to production**
   ```
   rks_release { "projectId": "snacks" }
   # Merges staging → main
   ```

## Tools Reference

| Tool | Purpose |
|------|---------|
| `rks_preflight` | Shows your project's workflow configuration |
| `rks_ship` | Commit and create PR (respects workflow config) |
| `rks_promote` | Merge working → integration (triggers builds) |
| `rks_release` | Merge integration → production |

## Checking Your Configuration

Run `rks_preflight` to see your project's branch topology:

```
rks_preflight { "projectId": "my-project" }
```

Response includes:
```json
{
  "workflowInfo": {
    "workingBranch": "dev",
    "integrationBranch": "staging",
    "productionBranch": "main",
    "workflow": "plan → exec → promote → ship",
    "notes": [
      "Working branch (dev) is local-only",
      "Auto-merge disabled: use rks_promote to control when builds trigger"
    ]
  }
}
```

## Migration

To migrate an existing project to a custom workflow:

1. Add branch configuration to project registry
2. Create the working branch if it doesn't exist
3. Run `rks_preflight` to verify configuration
4. Update RAG embeddings: `rks_rag_embed`

## See Also

- [[how-to.rks]] - Complete RKS workflow guide
- [[how-to.golden-path]] - Quick start guide
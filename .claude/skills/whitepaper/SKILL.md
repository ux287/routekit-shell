---
name: whitepaper
description: Render a Dendron note (notes/<note-id>.md) into a branded ux287 PDF leave-behind whitepaper by invoking the @routekit/whitepaper package CLI. Accepts a note-id as $ARGUMENTS.
user-invocable: true
disable-model-invocation: false
verbosity: heartbeat
---

# Whitepaper Skill

Turn a Dendron note into a branded **ux287 PDF whitepaper** — the "leave-behind" output for a
note. `notes/*.md` is the content source of truth; this skill produces a PDF renderer output.
It is a thin Dispatcher wrapper over the **`@routekit/whitepaper`** package CLI and does NOT
reimplement any of the parsing, templating, or rendering logic itself.

## Usage

`$ARGUMENTS` is a single `<note-id>` — the basename of a `notes/<note-id>.md` file (without the
`.md` extension).

Invoke the package CLI from the repo root:

```bash
node packages/whitepaper/src/cli.mjs <note-id>
# or, if the workspace bin is linked:
whitepaper <note-id>
```

- **Input:** `notes/<note-id>.md`
- **Output:** `dist/whitepapers/<note-id>.pdf`

When the render completes, report the output path `dist/whitepapers/<note-id>.pdf` back to the
user.

## First run

The renderer uses Playwright's **Chromium**, which is downloaded on **first run** (a normal
`npm install` does not fetch it). If a render fails because the browser is missing, run once:

```bash
npx playwright install chromium
```

## Boundaries

- Delegates entirely to `@routekit/whitepaper`. This skill contains no parsing or
  PDF-rendering logic of its own — it only invokes the package CLI and reports the result.
- Read-only with respect to `notes/` — it renders a note, it never edits one.

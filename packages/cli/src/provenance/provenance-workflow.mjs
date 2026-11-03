// backlog.feat.commit-provenance-ci-verifier — written into a child as .github/workflows/rks-provenance.yml
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CHILD_WORKFLOW_PATH = ".github/workflows/rks-provenance.yml";
export const CHILD_VERIFIER_PATH = ".github/rks/verify-provenance.mjs";

// Warn mode only: prints a summary and never fails the build. Runs the copied verifier, so the
// child's CI needs no rks checkout and no npm install.
export const CHILD_WORKFLOW_YAML = `name: rks provenance
on:
  pull_request:
  push:
jobs:
  provenance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Verify commit provenance (warn mode)
        run: node .github/rks/verify-provenance.mjs --mode warn --base "\${{ github.event.pull_request.base.sha || github.event.before }}" --head "\${{ github.event.pull_request.head.sha || github.sha }}"
`;

// The verifier is copied byte-for-byte from its sibling module, resolved via import.meta.url.
const VERIFIER_SOURCE = fileURLToPath(new URL("./verify-provenance.mjs", import.meta.url));

// Write each child file ONLY when absent; an existing file (operator-edited or not) is never touched.
// Does not check content-only: the caller (upgradeProject) gates on that.
export function installProvenanceWorkflow({ projectRoot }) {
  const written = [];
  const skipped = [];
  const items = [
    [CHILD_WORKFLOW_PATH, () => CHILD_WORKFLOW_YAML],
    [CHILD_VERIFIER_PATH, () => fs.readFileSync(VERIFIER_SOURCE)],
  ];
  for (const [rel, content] of items) {
    const abs = path.join(projectRoot, rel);
    if (fs.existsSync(abs)) {
      skipped.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content());
    written.push(rel);
  }
  return { written, skipped };
}

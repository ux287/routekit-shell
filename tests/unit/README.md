# tests/unit/ — what belongs here

Short answer: pure in-memory tests with mocked I/O and <100ms expected wall-clock.
Anything heavier belongs in `tests/integration/`.

## Is this a unit test?

A test belongs in `tests/unit/` if and only if ALL of these hold:

1. **No subprocess spawn.** No `spawnSync`, `spawn`, `execSync`, `exec`, or `fork`
   calls — no shelling out to `git`, `npm`, `node`, `gh`, or any other CLI. The
   integration tier is the home for subprocess work.
2. **No real I/O on the network or on disk fixtures.** Mocked filesystem and
   in-memory data structures are fine; `fs.mkdtempSync` + multi-step fixture
   mutation is not.
3. **No `vi.resetModules()` followed by an `await import(...)` of a large module**
   (>1000 source lines). Re-importing `packages/mcp-rks/src/server.mjs`
   (3,868 LOC) once per test costs ~100ms; doing it 6× per file took the
   pre-Tier-2 unit shard from manageable to 107s per CI run. Move these tests
   to `tests/integration/`.
4. **Expected wall-clock under 100ms per test.** If a test routinely takes
   longer, it is exercising integration-tier code paths in disguise.

If any one of these does not hold, the test is an integration test and should
live in `tests/integration/`.

## How the rules are enforced

`tests/unit/unit-tier-purity.test.mjs` is the structural enforcer. It walks
every file under `tests/unit/` and asserts:

- **Rule a**: no spawn-family call appears without a
  `// timeout-opt-out: <reason>` comment on the same line or the line
  immediately above.
- **Rule b**: no `vi.resetModules()` followed by `await import(...)` of a
  file exceeding 1,000 LOC, without the same opt-out comment.

The opt-out comment grammar is canonical:
`// timeout-opt-out: <non-empty rationale>`. The matching subprocess-timeout
floor is defined and audited by
`tests/unit/subprocess-timeout-convention.test.mjs`.

A symmetric meta-test —
`tests/unit/integration-suite-convention.test.mjs` (despite the path, it
governs `tests/integration/`) — enforces the integration tier's filename-suffix
convention (`*.test.mjs` vs `*.workflow.test.mjs`). Together the two files
keep both tiers honest.

## Why this matters

Pre-Tier-2 audit: `tests/unit/` had ~28 integration tests in disguise,
contributing the bulk of the 83-minute CI suite. After Tier-2 the unit shard
should sit well under 5 minutes per shard, with the heavy hitters living in
the integration tier where their wall-clock is expected.

## References

- Audit paper: [notes/research.2026.06.15.test-suite-bloat-audit-and-tier-redesign.md](../../notes/research.2026.06.15.test-suite-bloat-audit-and-tier-redesign.md)
  — see §5 ("end state thesis") for the long-form unit-tier definition.
- Tier 1 work (CI shard + testTimeout): backlog.fix.ci-tier-1-shard-and-test-timeout.
- Tier 2 work (this story): `backlog.feat.test-suite-tier-2-unit-tier-bloat-audit`.
- Enforcement: `tests/unit/unit-tier-purity.test.mjs`,
  `tests/unit/subprocess-timeout-convention.test.mjs`.

/**
 * Ambient Vite types for the telemetry dashboard.
 *
 * This package carries no `vite/client` reference, and it must typecheck in the
 * PUBLISHED tree where src/presentations/ is absent — so the minimal
 * `import.meta.glob` shape lives HERE, in a file that ships, rather than in
 * src/presentations/types.ts, which does not.
 *
 * No imports or exports: this is a global script file, so `interface ImportMeta`
 * declaration-merges into the global ImportMeta.
 */
interface ImportMeta {
  glob<T = Record<string, unknown>>(
    pattern: string,
    options?: { eager?: boolean }
  ): Record<string, T>;
}

// backlog.fix.remote-http-entry-env-leaks
// One source for the git environment variables that the remote HTTP entry clears at boot and that
// loadProjectContext never takes from a project .env:
//   - repository-location keys, which redirect git away from the cwd it was given;
//   - config-injection keys, which can set core.hooksPath (and similar) and so run code on a commit.
// GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n> is an open-ended family, so membership is a predicate,
// not a fixed list. Functions here return key NAMES only, never values.

export const GIT_LOCATION_KEYS = Object.freeze([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
]);

export const GIT_CONFIG_INJECTION_KEYS = Object.freeze([
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
]);

const INDEXED_CONFIG_KEY = /^GIT_CONFIG_(KEY|VALUE)_\d+$/;

/** True for every location key, every config-injection key and any GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n>. */
export function isScrubbedGitEnvKey(key) {
  if (typeof key !== "string") return false;
  return GIT_LOCATION_KEYS.includes(key) || GIT_CONFIG_INJECTION_KEYS.includes(key) || INDEXED_CONFIG_KEY.test(key);
}

/** The names of the scrubbed keys present in env. */
export function scrubbedGitEnvKeys(env) {
  return Object.keys(env || {}).filter(isScrubbedGitEnvKey);
}

/** Delete every scrubbed key from env in place. Returns the deleted key names. */
export function scrubGitEnv(env) {
  const removed = scrubbedGitEnvKeys(env);
  for (const k of removed) delete env[k];
  return removed;
}

/** Copy of the scrubbed keys present in env, for restoreGitEnv. */
export function snapshotGitEnv(env) {
  const snapshot = {};
  for (const k of scrubbedGitEnvKeys(env)) snapshot[k] = env[k];
  return snapshot;
}

/** Restore env's scrubbed keys to exactly the snapshot: keys absent from it are deleted, the rest set back. */
export function restoreGitEnv(env, snapshot) {
  for (const k of scrubbedGitEnvKeys(env)) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, k)) delete env[k];
  }
  for (const [k, v] of Object.entries(snapshot)) env[k] = v;
}

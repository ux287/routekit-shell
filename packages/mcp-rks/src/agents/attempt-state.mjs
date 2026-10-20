/**
 * Runner-owned attempt lifecycle (backlog.feat.runner-attempt-lifecycle).
 *
 * runAgent calls beginAttempt(ctx) once before every attempt it makes:
 *   ctx = { index, kind: 'primary'|'same_model_retry'|'escalation'|'self_escalation', model, resumed }
 * Items registered with scoped() are re-initialised IN PLACE on a restart attempt (object identity
 * is stable, so an outputSchema that closed over the item sees the reset) and carried when
 * ctx.resumed is true and onResume is 'carry'. State that is never registered is never touched.
 */

const ON_RESUME = new Set(['carry', 'reset']);

export function createAttemptState() {
  const items = new Map();
  let current = null;

  return {
    scoped(name, init, { onResume = 'carry' } = {}) {
      if (typeof init !== 'function') throw new TypeError(`attemptState.scoped(${name}): init must be a function`);
      if (!ON_RESUME.has(onResume)) throw new TypeError(`attemptState.scoped(${name}): onResume must be 'carry' or 'reset'`);
      if (items.has(name)) throw new Error(`attemptState.scoped(${name}): already registered`);
      const value = init();
      items.set(name, { value, init, onResume });
      return value;
    },

    beginAttempt(ctx) {
      current = { ...ctx };
      for (const item of items.values()) {
        if (ctx.resumed && item.onResume === 'carry') continue;
        resetInPlace(item);
      }
    },

    snapshot() {
      return { attempt: current, items: [...items.keys()] };
    },
  };
}

function resetInPlace(item) {
  if (typeof item.value.reset === 'function') {
    item.value.reset();
    return;
  }
  const fresh = item.init();
  for (const key of Object.keys(item.value)) delete item.value[key];
  Object.assign(item.value, fresh);
}

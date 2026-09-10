import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, before } from 'node:test';
import { computeAllMetrics, checkMetricThresholds } from './eval/metrics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baselinesDir = path.join(__dirname, 'eval', 'baselines');
const projectRoot = path.resolve(__dirname, '..', '..', '..');

describe('Telemetry Eval - Metric Regression Detection', () => {
  let baseline;
  let currentMetrics;

  before(async () => {
    const baselinePath = path.join(baselinesDir, 'baseline-current.json');
    if (!fs.existsSync(baselinePath)) {
      throw new Error(
        `Baseline not found at ${baselinePath}. Run: node __tests__/eval/capture-baseline.mjs`
      );
    }
    baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    currentMetrics = await computeAllMetrics(projectRoot);
  });

  it('loads baseline metrics', () => {
    assert.ok(baseline.timestamp, 'baseline has timestamp');
    assert.ok(baseline.toolFailureRate !== undefined, 'baseline has toolFailureRate');
    assert.ok(baseline.planPassRate !== undefined, 'baseline has planPassRate');
    assert.ok(baseline.execSuccessRate !== undefined, 'baseline has execSuccessRate');
    assert.ok(baseline.execLatency !== undefined, 'baseline has execLatency');
    assert.ok(baseline.guardrailViolations !== undefined, 'baseline has guardrailViolations');
  });

  it('computes current metrics from telemetry', () => {
    assert.ok(currentMetrics.timestamp, 'current has timestamp');
    assert.ok(currentMetrics.toolFailureRate !== undefined);
    assert.ok(currentMetrics.planPassRate !== undefined);
    assert.ok(currentMetrics.execSuccessRate !== undefined);
    assert.ok(currentMetrics.execLatency !== undefined);
    assert.ok(currentMetrics.guardrailViolations !== undefined);
  });

  it('tool failure rate within threshold (+5pp)', () => {
    const result = checkMetricThresholds(baseline, currentMetrics);
    const v = result.violations.filter(v => v.metric === 'toolFailureRate');
    assert.strictEqual(v.length, 0, v[0]?.message || 'within threshold');
  });

  it('plan pass rate within threshold (-10pp)', () => {
    const result = checkMetricThresholds(baseline, currentMetrics);
    const v = result.violations.filter(v => v.metric === 'planPassRate');
    assert.strictEqual(v.length, 0, v[0]?.message || 'within threshold');
  });

  it('exec success rate within threshold (-10pp)', () => {
    const result = checkMetricThresholds(baseline, currentMetrics);
    const v = result.violations.filter(v => v.metric === 'execSuccessRate');
    assert.strictEqual(v.length, 0, v[0]?.message || 'within threshold');
  });

  it('exec latency within threshold (+20%)', () => {
    const result = checkMetricThresholds(baseline, currentMetrics);
    const v = result.violations.filter(v => v.metric === 'execLatency');
    assert.strictEqual(v.length, 0, v[0]?.message || 'within threshold');
  });

  it('guardrail violations within threshold (+25%)', () => {
    const result = checkMetricThresholds(baseline, currentMetrics);
    const v = result.violations.filter(v => v.metric === 'guardrailViolations');
    assert.strictEqual(v.length, 0, v[0]?.message || 'within threshold');
  });

  it('all metrics pass comprehensive check', () => {
    const result = checkMetricThresholds(baseline, currentMetrics);
    if (!result.passed) {
      console.log('\nMetric regressions:');
      for (const v of result.violations) {
        console.log(`  ${v.metric}: ${v.message}`);
      }
    }
    assert.strictEqual(result.passed, true,
      `${result.violations.length} regression(s) detected`);
  });
});

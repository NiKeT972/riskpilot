import { describe, it, expect } from 'vitest'
import { predictProb, predictSlip, explain, applyMitigations, riskLevel, MODEL, FEATURES } from '../src/lib/ml'

const healthy = Object.fromEntries(FEATURES.map((k) => [k, MODEL.healthy[k]]))
const risky = { complexity: 5, planned_days: 30, team_size: 1, team_experience_yrs: 0.5, resource_utilization: 130,
  num_dependencies: 5, requirement_changes: 5, budget_variance_pct: 30, progress_gap_pct: 40, vendor_dependent: 1 }

describe('exported Gradient Boosting model', () => {
  it('has the features and metrics the UI shows', () => {
    expect(MODEL.features).toHaveLength(10)
    expect(MODEL.metrics.roc_auc).toBeGreaterThan(0.5)
    expect(MODEL.classifier.trees.length).toBeGreaterThan(0)
  })
  it('scores a clearly risky task above a healthy one', () => {
    expect(predictProb(risky)).toBeGreaterThan(0.8)
    expect(predictProb(healthy)).toBeLessThan(0.35)
  })
  it('gives each risk factor the expected direction', () => {
    const base = { ...healthy, complexity: 3, resource_utilization: 95, requirement_changes: 1 }
    expect(predictProb({ ...base, requirement_changes: 5 })).toBeGreaterThan(predictProb(base))
    expect(predictProb({ ...base, vendor_dependent: 1, num_dependencies: 4 })).toBeGreaterThan(predictProb(base))
    expect(predictProb({ ...base, team_experience_yrs: 10 })).toBeLessThanOrEqual(predictProb(base))
  })
  it('predicts a positive slip that grows with duration', () => {
    expect(predictSlip({ ...risky, planned_days: 30 })).toBeGreaterThan(predictSlip({ ...risky, planned_days: 5 }))
    expect(predictSlip(healthy)).toBeGreaterThan(0)
  })
})

describe('counterfactual explanations', () => {
  it('each driver lowers the risk, and the drops add up', () => {
    const { base, drivers } = explain(risky)
    expect(drivers.length).toBeGreaterThan(0)
    let p = base
    for (const d of drivers) { expect(d.after).toBeLessThan(p); expect(d.drop).toBeCloseTo(p - d.after); p = d.after }
  })
  it('mitigating the top drivers lowers P(delay)', () => {
    expect(predictProb(applyMitigations(risky))).toBeLessThan(predictProb(risky))
  })
  it('still explains a near-certain delay (probability saturated near 100%)', () => {
    expect(predictProb(risky)).toBeGreaterThan(0.99)
    expect(explain(risky).drivers.length).toBeGreaterThanOrEqual(2)
  })
  it('a healthy task has nothing to fix', () => {
    expect(explain(healthy).drivers).toHaveLength(0)
  })
  it('maps probabilities to levels', () => {
    expect([riskLevel(0.7), riskLevel(0.4), riskLevel(0.1)]).toEqual(['High', 'Medium', 'Low'])
  })
})

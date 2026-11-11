import { describe, it, expect } from 'vitest'
import { cpm, topoOrder, statusPass, analyze, monteCarlo, mitigationPlan } from '../src/lib/engine'
import { SAMPLES } from '../src/lib/samples'

// A -> B -> D and A -> C -> D. Path A-B-D is 3+5+2 = 10 days, A-C-D is 3+2+2 = 7, so C has 3 days of slack.
const net = [
  { id: 'A', duration: 3, deps: [] },
  { id: 'B', duration: 5, deps: ['A'] },
  { id: 'C', duration: 2, deps: ['A'] },
  { id: 'D', duration: 2, deps: ['B', 'C'] },
]

describe('critical path (CPM)', () => {
  it('computes early/late dates, finish and slack', () => {
    const r = cpm(net)
    expect(r.finish).toBe(10)
    expect(r.ES).toEqual({ A: 0, B: 3, C: 3, D: 8 })
    expect(r.EF).toEqual({ A: 3, B: 8, C: 5, D: 10 })
    expect(r.slack).toEqual({ A: 0, B: 0, C: 3, D: 0 })
  })

  it('orders tasks so every dependency comes first', () => {
    const { order } = topoOrder([...net].reverse())
    for (const t of net) for (const d of t.deps) expect(order.indexOf(d)).toBeLessThan(order.indexOf(t.id))
  })

  it('survives a cycle and unknown dependencies instead of hanging', () => {
    const bad = [{ id: 'X', duration: 2, deps: ['Y', 'ghost'] }, { id: 'Y', duration: 3, deps: ['X'] }]
    const { order } = topoOrder(bad)
    expect(order.sort()).toEqual(['X', 'Y'])
    expect(Number.isFinite(cpm(bad).finish)).toBe(true)
  })
})

describe('status-aware forecast', () => {
  it('fixes done tasks, finishes started ones from the status date, delays unstarted ones', () => {
    const tasks = [
      { id: 'A', duration: 3, deps: [], progress: 100 },
      { id: 'B', duration: 5, deps: ['A'], progress: 40 },
      { id: 'C', duration: 2, deps: ['B'], progress: 0 },
    ]
    const base = cpm(tasks)
    const info = Object.fromEntries(tasks.map((t) => [t.id, { es: base.ES[t.id], ef: base.EF[t.id] }]))
    const r = statusPass(tasks, info, 6)          // status date = day 6
    expect(r.EF.A).toBe(3)
    expect(r.EF.B).toBeCloseTo(6 + 5 * 0.6)       // 60% of 5 days left, starting today
    expect(r.EF.C).toBeCloseTo(r.EF.B + 2)
  })
})

describe('analyze() on the sample projects', () => {
  for (const p of SAMPLES) {
    it(`${p.name}: probabilities, EVM and schedule are consistent`, () => {
      const a = analyze(p)
      expect(a.rows).toHaveLength(p.tasks.length)
      for (const r of a.rows) {
        expect(r.p).toBeGreaterThanOrEqual(0); expect(r.p).toBeLessThanOrEqual(1)
        if (r.done) expect(r.p).toBe(0)
      }
      const { BAC, EV, AC, PV, CPI, SPI, EAC } = a.evm
      expect(BAC).toBe(p.tasks.reduce((s, t) => s + t.budget, 0))
      expect(EV).toBeCloseTo(p.tasks.reduce((s, t) => s + t.budget * t.progress / 100, 0))
      expect(CPI).toBeCloseTo(EV / AC); expect(SPI).toBeCloseTo(EV / PV); expect(EAC).toBeCloseTo(BAC / CPI)
      expect(a.rows.some((r) => r.critical)).toBe(true)
    })
  }
})

describe('Monte Carlo forecast', () => {
  const p = SAMPLES[0]
  const a = analyze(p)
  it('is reproducible with the same seed and ordered P50 <= P80', () => {
    const m1 = monteCarlo(p, a, { n: 500 }), m2 = monteCarlo(p, a, { n: 500 })
    expect(m1.p50).toBe(m2.p50); expect(m1.p80).toBe(m2.p80)
    expect(m1.p50).toBeLessThanOrEqual(m1.p80)
    expect(m1.onTime).toBeGreaterThanOrEqual(0); expect(m1.onTime).toBeLessThanOrEqual(1)
  })
  it('applying mitigations never makes the forecast worse', () => {
    const base = monteCarlo(p, a, { n: 500 }), mit = monteCarlo(p, a, { n: 500, mitigate: true })
    expect(mit.p80).toBeLessThanOrEqual(base.p80)
    expect(mit.onTime).toBeGreaterThanOrEqual(base.onTime)
  })
  it('suggests mitigations only for open high-risk tasks', () => {
    for (const m of mitigationPlan(a)) {
      const row = a.rows.find((r) => r.id === m.task.id)
      expect(row.done).toBe(false); expect(row.p).toBeGreaterThanOrEqual(0.6)
    }
  })
})

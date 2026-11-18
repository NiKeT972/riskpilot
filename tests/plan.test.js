import { describe, it, expect } from 'vitest'
import { sanitizePlan, PHASES } from '../src/lib/plan'
import { localPlan } from '../src/lib/agent'
import { topoOrder } from '../src/lib/engine'

const isDag = (tasks) => {
  const { order } = topoOrder(tasks)
  return tasks.every((t) => t.deps.every((d) => order.indexOf(d) < order.indexOf(t.id)))
}

describe('sanitizePlan (what an LLM plan goes through)', () => {
  it('clamps fields to the ranges the model was trained on', () => {
    const { tasks } = sanitizePlan({ tasks: [{ id: 'T01', name: 'Build', duration: '120', complexity: 9, teamSize: 0,
      experience: -1, utilization: 300, budget: 'lots', vendor: 'true', phase: 'Coding' }] })
    expect(tasks[0]).toMatchObject({ duration: 40, complexity: 5, teamSize: 1, experience: 0.5, utilization: 130,
      budget: 100000, vendor: true, phase: 'Execution' })
  })
  it('drops unknown dependencies and breaks cycles', () => {
    const p = sanitizePlan({ tasks: [
      { id: 'A', deps: ['C'] }, { id: 'B', deps: ['A', 'ghost'] }, { id: 'C', deps: ['B'] }] })
    expect(isDag(p.tasks)).toBe(true)
    expect(p.tasks.flatMap((t) => t.deps)).not.toContain('ghost')
    expect(p.tasks.reduce((n, t) => n + t.deps.length, 0)).toBe(2)     // exactly one edge of the 3-cycle removed
    expect(p.warnings.some((w) => w.includes('cycle'))).toBe(true)
    expect(p.warnings.some((w) => w.includes('unknown'))).toBe(true)
  })
  it('renames duplicate ids and caps the plan size', () => {
    const p = sanitizePlan({ tasks: [{ id: 'T01' }, { id: 'T01' }, ...Array.from({ length: 50 }, () => ({}))] })
    expect(new Set(p.tasks.map((t) => t.id)).size).toBe(p.tasks.length)
    expect(p.tasks.length).toBe(40)
  })
  it('handles garbage without throwing', () => {
    for (const bad of [null, {}, { tasks: 'x' }, { tasks: [null, 3, 'a'] }]) {
      expect(() => sanitizePlan(bad)).not.toThrow()
      expect(sanitizePlan(bad).tasks).toEqual([])
    }
  })
})

describe('built-in planner (no LLM)', () => {
  const cases = {
    software: 'Build a customer portal app for our clients, budget 40 lakh',
    event: 'Organise a 2-day college hackathon with 500 participants',
    construction: 'Construct a new office building in Pune',
    data: 'Predictive analytics model for churn using our data',
  }
  for (const [domain, desc] of Object.entries(cases)) {
    it(`${domain}: valid DAG with valid fields`, () => {
      const p = localPlan(desc)
      expect(p.domain).toBe(domain)
      expect(isDag(p.tasks)).toBe(true)
      for (const t of p.tasks) expect(PHASES).toContain(t.phase)
      expect(sanitizePlan(p).warnings).toEqual([])          // the template already passes the checks
    })
  }
  it('reads the budget from the description', () => {
    const total = localPlan('Build a CRM system, budget 40 lakh').tasks.reduce((s, t) => s + t.budget, 0)
    expect(Math.abs(total - 4_000_000) / 4_000_000).toBeLessThan(0.02)
  })
})

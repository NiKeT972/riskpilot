// Project analytics engine: CPM scheduling, EVM, ML risk scoring, Monte Carlo forecasting
import { predictProb, predictSlip, explain, applyMitigations, riskLevel } from './ml'

const DAY = 86400000
export const toDate = (iso) => new Date(iso + 'T00:00:00')
export const addDays = (d, n) => new Date(d.getTime() + Math.round(n) * DAY)
export const fmtDate = (d) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
export const fmtDateY = (d) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
export const daysBetween = (a, b) => Math.round((b - a) / DAY)

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Topological order (Kahn). Ignores unknown deps and breaks cycles defensively.
export function topoOrder(tasks) {
  const ids = new Set(tasks.map((t) => t.id))
  const indeg = new Map(tasks.map((t) => [t.id, 0]))
  const succ = new Map(tasks.map((t) => [t.id, []]))
  tasks.forEach((t) => (t.deps || []).filter((d) => ids.has(d) && d !== t.id).forEach((d) => {
    indeg.set(t.id, indeg.get(t.id) + 1); succ.get(d).push(t.id)
  }))
  const q = tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id)
  const order = []
  while (q.length) {
    const id = q.shift(); order.push(id)
    succ.get(id).forEach((s) => { indeg.set(s, indeg.get(s) - 1); if (indeg.get(s) === 0) q.push(s) })
  }
  tasks.forEach((t) => { if (!order.includes(t.id)) order.push(t.id) })
  return { order, succ }
}

// Critical Path Method: forward + backward pass
export function cpm(tasks, durOf = (t) => t.duration) {
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]))
  const { order, succ } = topoOrder(tasks)
  const ES = {}, EF = {}, LS = {}, LF = {}
  for (const id of order) {
    const t = byId[id]
    ES[id] = Math.max(0, ...(t.deps || []).filter((d) => EF[d] !== undefined).map((d) => EF[d]))
    EF[id] = ES[id] + Math.max(0, durOf(t))
  }
  const finish = Math.max(0, ...Object.values(EF))
  for (const id of [...order].reverse()) {
    const s = succ.get(id)
    LF[id] = s.length ? Math.min(...s.map((x) => LS[x])) : finish
    LS[id] = LF[id] - Math.max(0, durOf(byId[id]))
  }
  const slack = Object.fromEntries(order.map((id) => [id, Math.round((LS[id] - ES[id]) * 100) / 100]))
  return { ES, EF, LS, LF, slack, finish, order, succ }
}

// Status-aware forward pass: done tasks are fixed, started tasks finish their remaining
// work from the status date, unstarted tasks cannot start before the status date.
export function statusPass(tasks, info, elapsed, extra = () => 0) {
  const { order } = topoOrder(tasks)
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]))
  const EF = {}
  for (const id of order) {
    const t = byId[id]; const r = info[id]
    const depEF = Math.max(0, ...(t.deps || []).filter((d) => EF[d] !== undefined).map((d) => EF[d]))
    if (t.progress >= 100) EF[id] = Math.min(Math.max(r.ef, depEF), elapsed)
    else if (t.progress > 0) {
      const rem = 1 - t.progress / 100
      EF[id] = Math.max(elapsed, depEF) + t.duration * rem + extra(id) * rem
    } else {
      const es = Math.max(depEF, elapsed, r.es)
      EF[id] = es + t.duration + extra(id)
    }
  }
  return { EF, finish: Math.max(0, ...Object.values(EF)), order }
}

function features(t, plannedPct, nDeps) {
  const ev = (t.budget || 0) * (t.progress / 100)
  const costVar = ev > 0 ? ((t.actualCost - ev) / ev) * 100 : 0
  const gap = Math.max(0, plannedPct - t.progress)
  return {
    complexity: t.complexity, planned_days: t.duration, team_size: t.teamSize,
    team_experience_yrs: t.experience, resource_utilization: t.utilization,
    num_dependencies: nDeps, requirement_changes: t.reqChanges,
    budget_variance_pct: Math.max(-15, Math.min(45, costVar)),
    progress_gap_pct: Math.min(60, gap), vendor_dependent: t.vendor ? 1 : 0,
  }
}

export function analyze(project, opts = {}) {
  const tasks = project.tasks
  const start = toDate(project.startDate)
  const status = toDate(project.statusDate)
  const elapsed = daysBetween(start, status)
  const base = cpm(tasks)

  const rows = tasks.map((t) => {
    const es = base.ES[t.id], ef = base.EF[t.id]
    const plannedPct = elapsed <= es ? 0 : elapsed >= ef ? 100 : ((elapsed - es) / Math.max(1, t.duration)) * 100
    const f = features(t, plannedPct, (t.deps || []).length)
    const done = t.progress >= 100
    const p = done ? 0 : predictProb(f)
    const slipIfLate = done ? 0 : predictSlip(f)
    const nSucc = base.succ.get(t.id).length
    const critical = base.slack[t.id] <= 0.01
    const impact = Math.min(5, Math.round((1 + t.duration / 10 + nSucc * 0.5 + (critical ? 1.5 : 0)) * 10) / 10)
    const bac = t.budget || 0
    return {
      ...t, f, plannedPct, done, p, level: done ? 'Done' : riskLevel(p),
      slipIfLate, expSlip: p * slipIfLate, impact, score: Math.round(p * impact * 100) / 100,
      critical, slack: base.slack[t.id], es, ef,
      startD: addDays(start, es), endD: addDays(start, ef),
      pv: bac * plannedPct / 100, ev: bac * t.progress / 100, ac: t.actualCost || 0, bac,
    }
  })
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]))

  // forecast schedule: status-aware, plus ML-expected slippage
  const fc = statusPass(tasks, byId, elapsed, (id) => byId[id].expSlip)
  rows.forEach((r) => { r.fcEnd = addDays(start, fc.EF[r.id]) })

  // EVM (project level)
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0)
  const BAC = sum('bac'), PV = sum('pv'), EV = sum('ev'), AC = sum('ac')
  const CPI = AC > 0 ? EV / AC : 1, SPI = PV > 0 ? EV / PV : 1
  const EAC = CPI > 0 ? BAC / CPI : BAC
  const evm = { BAC, PV, EV, AC, CPI, SPI, EAC, VAC: BAC - EAC, ETC: EAC - AC, CV: EV - AC, SV: EV - PV }

  // S-curve: planned value over time vs earned/actual to date + forecast
  const curve = []
  const pvAt = (d) => rows.reduce((acc, r) => acc + r.bac * (d <= r.es ? 0 : d >= r.ef ? 1 : (d - r.es) / Math.max(1, r.duration)), 0)
  const pvStatus = pvAt(elapsed)
  const step = Math.max(1, Math.round(base.finish / 30))
  for (let d = 0; d <= Math.ceil(fc.finish) + step; d += step) {
    let pv = 0
    rows.forEach((r) => {
      const pct = d <= r.es ? 0 : d >= r.ef ? 1 : (d - r.es) / Math.max(1, r.duration)
      pv += r.bac * pct
    })
    const pt = { day: d, date: fmtDate(addDays(start, d)), PV: Math.round(pv) }
    if (d <= elapsed) {
      const frac = elapsed > 0 ? d / elapsed : 1
      pt.EV = Math.round(EV * Math.pow(frac, 1.15)); pt.AC = Math.round(AC * Math.pow(frac, 1.1))
    } else {
      // forecast cost: remaining planned work spread so the curve ends at EAC
      pt.Forecast = Math.round(AC + (pv - pvStatus) * (EAC - AC) / Math.max(1, BAC - pvStatus))
    }
    curve.push(pt)
  }

  const kpi = {
    tasks: rows.length,
    done: rows.filter((r) => r.done).length,
    high: rows.filter((r) => r.level === 'High').length,
    medium: rows.filter((r) => r.level === 'Medium').length,
    low: rows.filter((r) => r.level === 'Low').length,
    critical: rows.filter((r) => r.critical).length,
    plannedEnd: addDays(start, base.finish),
    deadline: project.deadline ? toDate(project.deadline) : addDays(start, base.finish),
    deadlineDay: project.deadline ? daysBetween(start, toDate(project.deadline)) : base.finish,
    buffer: project.deadline ? daysBetween(addDays(start, base.finish), toDate(project.deadline)) : 0,
    expectedEnd: addDays(start, fc.finish),
    duration: base.finish,
    progress: BAC > 0 ? (EV / BAC) * 100 : 0,
    avgRisk: rows.filter((r) => !r.done).reduce((a, r) => a + r.p, 0) / Math.max(1, rows.filter((r) => !r.done).length),
    expSlip: rows.reduce((a, r) => a + r.expSlip, 0),
  }
  return { rows, byId, base, evm, curve, kpi, start, status, elapsed }
}

// Monte Carlo simulation of the finish date
export function monteCarlo(project, analysis, { n = 2000, mitigate = false, threshold = 0.6, seed = 7 } = {}) {
  const rand = mulberry32(seed)
  const tasks = project.tasks
  const params = analysis.rows.map((r) => {
    if (r.done) return { id: r.id, p: 0, slip: 0 }
    let f = r.f
    if (mitigate && r.p >= threshold) f = applyMitigations(f, 2)
    return { id: r.id, p: predictProb(f), slip: predictSlip(f) }
  })
  const pm = Object.fromEntries(params.map((x) => [x.id, x]))
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]))
  const finishes = new Float64Array(n)
  const critCount = Object.fromEntries(tasks.map((t) => [t.id, 0]))
  for (let s = 0; s < n; s++) {
    const extra = {}
    for (const t of tasks) {
      const q = pm[t.id]
      extra[t.id] = q.p > 0 && rand() < q.p ? -(q.slip / 2) * (Math.log(1 - rand()) + Math.log(1 - rand())) : 0
    }
    const { EF, finish } = statusPass(tasks, analysis.byId, analysis.elapsed, (id) => extra[id])
    finishes[s] = finish
    let cur = Object.keys(EF).reduce((a, b) => (EF[a] >= EF[b] ? a : b))
    const seen = new Set()
    while (cur && !seen.has(cur)) {
      seen.add(cur); critCount[cur]++
      const deps = (byId[cur].deps || []).filter((x) => EF[x] !== undefined)
      cur = deps.length ? deps.reduce((a, b) => (EF[a] >= EF[b] ? a : b)) : null
    }
  }
  const sorted = Array.from(finishes).sort((a, b) => a - b)
  const q = (x) => sorted[Math.min(n - 1, Math.floor(x * n))]
  const planned = analysis.kpi.deadlineDay
  const onTime = sorted.filter((v) => v <= planned + 0.5).length / n
  // histogram by week buckets
  const lo = Math.floor(sorted[0]), hi = Math.ceil(sorted[n - 1])
  const bw = Math.max(1, Math.ceil((hi - lo) / 24))
  const hist = []
  for (let b = lo; b <= hi; b += bw) hist.push({ x: b, count: 0 })
  sorted.forEach((v) => { const i = Math.min(hist.length - 1, Math.floor((v - lo) / bw)); hist[i].count++ })
  return {
    sorted, p50: q(0.5), p80: q(0.8), p95: q(0.95), mean: sorted.reduce((a, b) => a + b, 0) / n,
    onTime, hist, bw, planned,
    criticality: Object.fromEntries(Object.entries(critCount).map(([k, v]) => [k, v / n])),
  }
}

export function mitigationPlan(analysis, threshold = 0.6) {
  const plan = []
  analysis.rows.filter((r) => !r.done && r.p >= threshold).sort((a, b) => b.score - a.score).forEach((r) => {
    const { drivers } = explain(r.f)
    drivers.slice(0, 2).forEach((d, i) => plan.push({ task: r, rank: i + 1, ...d }))
  })
  return plan
}

export const inr = (v) => {
  if (Math.abs(v) >= 1e7) return '₹' + (v / 1e7).toFixed(2) + ' Cr'
  if (Math.abs(v) >= 1e5) return '₹' + (v / 1e5).toFixed(2) + ' L'
  return '₹' + Math.round(v).toLocaleString('en-IN')
}

// Validates and cleans a task plan before it reaches the scheduler.
// An LLM can return almost anything: missing fields, numbers as strings, out-of-range values, duplicate ids,
// dependencies on tasks that don't exist, or a dependency cycle. CPM needs a clean DAG, so this runs on the
// server (api/agent.js) and again in the browser (generatePlan), and returns the fixes it made as warnings.

export const PHASES = ['Initiation', 'Planning', 'Execution', 'Monitoring', 'Closure']
export const MAX_TASKS = 40

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}
const text = (v, dflt, max = 80) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : dflt)

export function sanitizePlan(plan) {
  const warnings = []
  const raw = Array.isArray(plan?.tasks) ? plan.tasks : []
  if (!Array.isArray(plan?.tasks)) warnings.push('plan had no task list')
  if (raw.length > MAX_TASKS) warnings.push(`kept the first ${MAX_TASKS} of ${raw.length} tasks`)

  // 1. ids: keep valid unique ones, give the rest fresh ids
  const seen = new Set()
  const tasks = raw.slice(0, MAX_TASKS).filter((t) => t && typeof t === 'object').map((t, i) => {
    let id = text(t.id, '', 12)
    if (!id || seen.has(id)) {
      const fresh = `T${String(i + 1).padStart(2, '0')}`
      id = seen.has(fresh) ? `X${i + 1}` : fresh
      if (t.id !== undefined) warnings.push(`renamed duplicate or invalid id "${t.id}" to ${id}`)
    }
    seen.add(id)
    return { ...t, id }
  })

  // 2. fields: clamp to the ranges the model was trained on
  const ids = new Set(tasks.map((t) => t.id))
  const out = tasks.map((t) => ({
    id: t.id,
    name: text(t.name, `Task ${t.id}`),
    phase: PHASES.includes(t.phase) ? t.phase : 'Execution',
    owner: text(t.owner, 'Unassigned', 40),
    duration: Math.round(clamp(t.duration, 1, 40, 5)),
    deps: [...new Set((Array.isArray(t.deps) ? t.deps : []).map(String))].filter((d) => ids.has(d) && d !== t.id),
    complexity: Math.round(clamp(t.complexity, 1, 5, 3)),
    teamSize: Math.round(clamp(t.teamSize, 1, 8, 2)),
    experience: clamp(t.experience, 0.5, 12, 3),
    utilization: Math.round(clamp(t.utilization, 50, 130, 90)),
    vendor: t.vendor === true || t.vendor === 'true' || t.vendor === 1,
    budget: Math.round(clamp(t.budget, 0, 1e9, 100000)),
  }))
  out.forEach((t, i) => {
    const before = Array.isArray(tasks[i].deps) ? tasks[i].deps.length : 0
    if (t.deps.length < before) warnings.push(`${t.id}: dropped dependencies on unknown tasks`)
  })

  // 3. cycles: walk the graph; a dependency that closes a loop is removed
  const byId = Object.fromEntries(out.map((t) => [t.id, t]))
  const state = {}                         // undefined = new, 1 = on the current path, 2 = finished
  const visit = (id) => {
    state[id] = 1
    const t = byId[id]
    t.deps = t.deps.filter((d) => {
      if (state[d] === 1) { warnings.push(`${id}: removed dependency on ${d} (it made a cycle)`); return false }
      if (!state[d]) visit(d)
      return true
    })
    state[id] = 2
  }
  out.forEach((t) => { if (!state[t.id]) visit(t.id) })

  return { name: text(plan?.name, 'New project', 80), tasks: out, warnings }
}

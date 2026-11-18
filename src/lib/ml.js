// In-browser inference for the Gradient Boosting models trained in ml/train_model.py
import model from '../model/model.json'

export const FEATURES = model.features
export const MODEL = model

export const FEATURE_LABELS = {
  complexity: 'Task complexity',
  planned_days: 'Planned duration',
  team_size: 'Team size',
  team_experience_yrs: 'Team experience',
  resource_utilization: 'Resource utilisation',
  num_dependencies: 'Dependencies',
  requirement_changes: 'Requirement changes',
  budget_variance_pct: 'Cost overrun',
  progress_gap_pct: 'Progress behind plan',
  vendor_dependent: 'Vendor dependency',
}

// +1: raising the value lowers risk; -1: lowering the value lowers risk
const SAFE_DIR = {
  complexity: -1, planned_days: -1, team_size: 1, team_experience_yrs: 1,
  resource_utilization: -1, num_dependencies: -1, requirement_changes: -1,
  budget_variance_pct: -1, progress_gap_pct: -1, vendor_dependent: -1,
}

// Factors a PM can realistically act on (planned duration & dependencies are structural)
const ACTIONABLE = new Set(['complexity', 'team_size', 'team_experience_yrs', 'resource_utilization',
  'requirement_changes', 'budget_variance_pct', 'progress_gap_pct', 'vendor_dependent', 'num_dependencies'])

export const MITIGATIONS = {
  complexity: { title: 'Decompose the work', action: 'Split into smaller work packages and add a design review before build.', technique: 'Scope decomposition' },
  planned_days: { title: 'Add checkpoints', action: 'Break the long task into weekly milestones so slippage is visible early.', technique: 'Milestone control' },
  team_size: { title: 'Add capacity', action: 'Move a resource from a low-risk task or bring in a short-term contractor.', technique: 'Crashing' },
  team_experience_yrs: { title: 'Pair with an expert', action: 'Assign a senior engineer / SME as reviewer and run a knowledge-transfer session.', technique: 'Skills mitigation' },
  resource_utilization: { title: 'Level the workload', action: 'The team is over-allocated: move non-critical work or extend the window.', technique: 'Resource levelling' },
  num_dependencies: { title: 'Unblock dependencies', action: 'Escalate upstream blockers in stand-up and add a buffer on the critical path.', technique: 'Dependency management' },
  requirement_changes: { title: 'Freeze scope', action: 'Route new requests through a change-control board; defer them to the next phase.', technique: 'Change control' },
  budget_variance_pct: { title: 'Re-baseline cost', action: 'Review spend with the sponsor, re-estimate and approve contingency use.', technique: 'Cost control' },
  progress_gap_pct: { title: 'Recovery plan', action: 'Fast-track (run activities in parallel) or crash (add resources) this task now.', technique: 'Schedule compression' },
  vendor_dependent: { title: 'Tighten vendor control', action: 'Agree SLAs with penalties, hold weekly vendor syncs and line up a backup supplier.', technique: 'Procurement risk' },
}

// each tree: [f0, t0, fL, tL, fR, tR, vLL, vLR, vRL, vRR] (depth-2 regression tree)
function raw(m, x) {
  let s = m.base
  for (const [f0, t0, fl, tl, fr, tr, a, b, c, d] of m.trees) {
    s += m.lr * (x[f0] <= t0 ? (fl < 0 || x[fl] <= tl ? a : b) : (fr < 0 || x[fr] <= tr ? c : d))
  }
  return s
}

export const sigmoid = (z) => 1 / (1 + Math.exp(-z))

export function vectorize(f) {
  return FEATURES.map((k) => Number(f[k] ?? 0))
}

export function predictProb(f) {
  return sigmoid(raw(model.classifier, vectorize(f)))
}

// expected delay in days if the task is late
export function predictSlip(f) {
  const ratio = Math.max(0.03, raw(model.regressor, vectorize(f)))
  return ratio * Math.max(1, f.planned_days)
}

// Log-odds. Near 0% or 100% a real improvement barely moves the probability (0.999 -> 0.998), so "is this
// fix worth showing?" is also judged on the odds scale, which doesn't flatten out.
const logit = (p) => { const q = Math.min(1 - 1e-12, Math.max(1e-12, p)); return Math.log(q / (1 - q)) }

// Counterfactual explanation (greedy): repeatedly find the actionable factor whose move to a
// healthy historical level lowers P(delay) the most, apply it, and record the marginal drop.
export function explain(f, steps = 4) {
  const base = predictProb(f)
  const out = []
  let cur = { ...f }, pCur = base
  const used = new Set()
  for (let s = 0; s < steps; s++) {
    let best = null
    for (const k of FEATURES) {
      if (!ACTIONABLE.has(k) || used.has(k)) continue
      const healthy = model.healthy[k]
      if ((cur[k] - healthy) * SAFE_DIR[k] >= 0) continue
      const p = predictProb({ ...cur, [k]: healthy })
      if (!best || p < best.p) best = { k, p, healthy }
    }
    if (!best || (pCur - best.p < 0.01 && logit(pCur) - logit(best.p) < 0.25)) break
    out.push({ feature: best.k, label: FEATURE_LABELS[best.k], value: f[best.k], healthy: best.healthy,
      drop: pCur - best.p, after: best.p, ...MITIGATIONS[best.k] })
    used.add(best.k); cur = { ...cur, [best.k]: best.healthy }; pCur = best.p
  }
  return { base, drivers: out }
}

export function applyMitigations(f, n = 2) {
  const { drivers } = explain(f)
  const g = { ...f }
  drivers.slice(0, n).forEach((d) => { g[d.feature] = model.healthy[d.feature] })
  return g
}

export function riskLevel(p) {
  return p >= 0.6 ? 'High' : p >= 0.35 ? 'Medium' : 'Low'
}

// Client side of the AI agent: calls /api/agent (Groq LLM) and falls back to a
// built-in rule-based planner / copilot when no LLM key is configured.
import { fmtDateY, addDays, inr, mitigationPlan } from './engine'
import { sanitizePlan } from './plan'

export async function llmStatus() {
  try {
    const r = await fetch('/api/agent')
    if (!r.ok) return false
    return (await r.json()).llm === true
  } catch { return false }
}

async function post(body) {
  const r = await fetch('/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status)
  return r.json()
}

// ---------------------------------------------------------------- planner
const TEMPLATES = {
  software: [
    ['Project kickoff & charter', 'Initiation', 'PM', 3, [], 1, 0, 0.6],
    ['Stakeholder & requirements workshops', 'Planning', 'Business Analyst', 8, [0], 3, 0, 1.5],
    ['Solution architecture', 'Planning', 'Tech Lead', 6, [1], 4, 0, 1.4],
    ['UX research & wireframes', 'Planning', 'Designer', 8, [1], 3, 0, 1.2],
    ['Cloud / DevOps setup', 'Execution', 'DevOps', 6, [2], 3, 1, 1.5],
    ['Database & API development', 'Execution', 'Backend Team', 15, [2], 4, 0, 3],
    ['Frontend development', 'Execution', 'Frontend Team', 15, [3, 5], 4, 0, 2.8],
    ['Third-party integrations', 'Execution', 'Backend Team', 8, [5], 5, 1, 1.8],
    ['Security review', 'Monitoring', 'Security', 5, [6, 7], 3, 0, 1],
    ['QA & regression testing', 'Monitoring', 'QA Team', 8, [6, 7], 3, 0, 1.5],
    ['User acceptance testing', 'Monitoring', 'Business Analyst', 6, [8, 9], 3, 0, 1],
    ['Deployment & go-live', 'Closure', 'DevOps', 2, [10], 3, 0, 0.6],
    ['Training & handover', 'Closure', 'PM', 4, [11], 1, 0, 0.6],
  ],
  event: [
    ['Event concept & budget approval', 'Initiation', 'Organiser', 4, [], 2, 0, 0.5],
    ['Venue booking', 'Planning', 'Logistics', 7, [0], 2, 1, 3],
    ['Sponsor outreach', 'Planning', 'Partnerships', 15, [0], 3, 1, 0.8],
    ['Speaker / judge confirmation', 'Planning', 'Program Lead', 12, [0], 3, 1, 0.8],
    ['Website & registrations', 'Execution', 'Tech Team', 8, [0], 3, 0, 1],
    ['Marketing campaign', 'Execution', 'Marketing', 20, [4], 2, 0, 2],
    ['Catering, AV & logistics', 'Execution', 'Logistics', 6, [1], 2, 1, 2.5],
    ['Volunteer onboarding', 'Execution', 'Ops Lead', 5, [1], 1, 0, 0.3],
    ['Dry run & rehearsal', 'Monitoring', 'Organiser', 2, [3, 6, 7], 2, 0, 0.3],
    ['Event day', 'Closure', 'Organiser', 2, [8, 5, 2], 3, 0, 1],
    ['Feedback & sponsor reports', 'Closure', 'Organiser', 4, [9], 1, 0, 0.2],
  ],
  construction: [
    ['Feasibility & approvals', 'Initiation', 'Project Manager', 15, [], 3, 1, 1],
    ['Detailed design & drawings', 'Planning', 'Architect', 20, [0], 4, 0, 2],
    ['Contractor tendering', 'Planning', 'Procurement', 12, [1], 3, 1, 0.5],
    ['Site preparation', 'Execution', 'Contractor', 10, [2], 2, 1, 2],
    ['Foundation & structure', 'Execution', 'Contractor', 30, [3], 4, 1, 8],
    ['MEP installation', 'Execution', 'MEP Contractor', 20, [4], 4, 1, 5],
    ['Interiors & finishing', 'Execution', 'Interior Vendor', 20, [5], 3, 1, 4],
    ['Quality & safety inspection', 'Monitoring', 'QA Engineer', 5, [6], 3, 0, 0.5],
    ['Snag fixing', 'Monitoring', 'Contractor', 7, [7], 2, 1, 0.8],
    ['Handover & occupancy', 'Closure', 'Project Manager', 4, [8], 2, 0, 0.3],
  ],
  data: [
    ['Problem framing & success metrics', 'Initiation', 'Product Owner', 4, [], 2, 0, 0.5],
    ['Data source discovery & access', 'Planning', 'Data Engineer', 8, [0], 3, 1, 1],
    ['Data pipeline (ETL)', 'Execution', 'Data Engineer', 12, [1], 4, 0, 2],
    ['Exploratory analysis', 'Execution', 'Data Scientist', 6, [2], 3, 0, 1],
    ['Feature engineering', 'Execution', 'Data Scientist', 8, [3], 4, 0, 1.5],
    ['Model training & tuning', 'Execution', 'ML Engineer', 10, [4], 5, 0, 2],
    ['Bias & explainability audit', 'Monitoring', 'ML Engineer', 5, [5], 3, 0, 0.8],
    ['API / dashboard build', 'Execution', 'Full-stack Dev', 10, [5], 3, 0, 1.6],
    ['Pilot with business users', 'Monitoring', 'Product Owner', 8, [6, 7], 3, 0, 1],
    ['Deployment & MLOps monitoring', 'Closure', 'ML Engineer', 5, [8], 4, 1, 1],
    ['Documentation & handover', 'Closure', 'Product Owner', 3, [9], 1, 0, 0.4],
  ],
}

function detectDomain(text) {
  const t = text.toLowerCase()
  if (/(event|fest|hackathon|conference|summit|wedding|concert|workshop)/.test(t)) return 'event'
  if (/(construct|building|renovat|office fit|civil|bridge|road|warehouse build)/.test(t)) return 'construction'
  if (/(\bapp\b|website|portal|platform|software|\berp\b|\bcrm\b|system)/.test(t)) return 'software'
  if (/(data|machine learning|\bml\b|\bai\b|analytics|predictive model)/.test(t)) return 'data'
  return 'software'
}

function detectBudget(text) {
  const m = text.toLowerCase().match(/(\d+(?:\.\d+)?)\s*(crore|cr|lakh|lac|l\b|k\b|thousand)/)
  if (!m) return null
  const n = parseFloat(m[1]); const u = m[2]
  return u.startsWith('cr') ? n * 1e7 : u.startsWith('la') || u === 'l' ? n * 1e5 : n * 1e3
}

export function localPlan(description) {
  const domain = detectDomain(description)
  const tpl = TEMPLATES[domain]
  const budget = detectBudget(description) || 2500000
  const units = tpl.reduce((a, r) => a + r[7], 0)
  const head = description.trim().split(/[.,;]| with /i)[0]
    .replace(/^(we need to |i want to |please )?(build|create|plan|organise|organize|launch|develop|make)\s+/i, '')
    .replace(/^(a|an|the)\s+/i, '').replace(/\bour\s+/gi, '')
  const name = head.split(/\s+/).slice(0, 8).join(' ')
  return {
    name: name.length > 3 ? name.replace(/^\w/, (c) => c.toUpperCase()) : 'New project',
    tasks: tpl.map(([name, phase, owner, duration, deps, complexity, vendor, w], i) => ({
      id: `T${String(i + 1).padStart(2, '0')}`, name, phase, owner, duration,
      deps: deps.map((d) => `T${String(d + 1).padStart(2, '0')}`), complexity,
      teamSize: complexity >= 4 ? 3 : 2, experience: 3.5, utilization: 90, vendor: !!vendor,
      budget: Math.round((budget * w) / units / 1000) * 1000,
    })),
    domain,
  }
}

export async function generatePlan(description, useLLM) {
  if (useLLM) {
    try {
      const r = await post({ mode: 'plan', description })
      const p = sanitizePlan(r.plan)             // the server already does this; checking again costs nothing
      if (p.tasks.length) return { ...p, source: `LLM (${r.model})` }
    }
    catch (e) { console.warn('LLM plan failed, using built-in planner', e) }
  }
  const p = localPlan(description)
  return { ...p, source: `Built-in planner (${p.domain} template)` }
}

// ---------------------------------------------------------------- copilot
export function buildContext(project, a, mc) {
  const top = [...a.rows].filter((r) => !r.done).sort((x, y) => y.score - x.score).slice(0, 8)
  return {
    project: project.name, statusDate: project.statusDate,
    baselineFinish: fmtDateY(a.kpi.plannedEnd), committedGoLive: fmtDateY(a.kpi.deadline),
    monteCarlo: mc && { p50: fmtDateY(addDays(a.start, mc.p50)), p80: fmtDateY(addDays(a.start, mc.p80)), onTimeProbability: Math.round(mc.onTime * 100) + '%' },
    progress: a.kpi.progress.toFixed(1) + '%',
    evm: { BAC: inr(a.evm.BAC), EV: inr(a.evm.EV), AC: inr(a.evm.AC), PV: inr(a.evm.PV), CPI: a.evm.CPI.toFixed(2), SPI: a.evm.SPI.toFixed(2), EAC: inr(a.evm.EAC) },
    riskCounts: { high: a.kpi.high, medium: a.kpi.medium, low: a.kpi.low },
    criticalPath: a.rows.filter((r) => r.critical).map((r) => r.id),
    topRisks: top.map((r) => ({ id: r.id, task: r.name, owner: r.owner, pDelay: Math.round(r.p * 100) + '%', expSlipDays: r.expSlip.toFixed(1), critical: r.critical, progress: r.progress + '%' })),
    mitigations: mitigationPlan(a).slice(0, 10).map((m) => ({ task: m.task.id, driver: m.label, riskReduction: Math.round(m.drop * 100) + ' pts', action: m.title })),
  }
}

function localAnswer(q, project, a, mc) {
  const t = q.toLowerCase()
  const top = [...a.rows].filter((r) => !r.done).sort((x, y) => y.score - x.score)
  const plan = mitigationPlan(a)
  const p80 = mc ? fmtDateY(addDays(a.start, mc.p80)) : '-'
  if (/report|status|summary|update/.test(t)) return localReport(project, a, mc)
  if (/cost|budget|spend|evm|cpi|money/.test(t)) {
    return `**Cost position (EVM)**\n- Budget at completion: ${inr(a.evm.BAC)}; earned ${inr(a.evm.EV)} vs actual ${inr(a.evm.AC)}.\n- CPI ${a.evm.CPI.toFixed(2)} → ${a.evm.CPI < 1 ? 'over' : 'under'} budget; forecast EAC ${inr(a.evm.EAC)} (variance ${inr(a.evm.VAC)}).\n- Biggest overruns: ${a.rows.filter((r) => r.ev > 0).sort((x, y) => (y.ac - y.ev) - (x.ac - x.ev)).slice(0, 3).map((r) => `${r.id} ${r.name} (+${inr(r.ac - r.ev)})`).join(', ')}.\n- Action: re-baseline these with the sponsor and release contingency only against approved change requests.`
  }
  if (/when|finish|go-live|golive|deadline|late|delay|date/.test(t)) {
    return `**Delivery forecast**\n- Committed go-live: ${fmtDateY(a.kpi.deadline)} (baseline CPM finish ${fmtDateY(a.kpi.plannedEnd)}).\n- Monte Carlo (2,000 runs): P50 ${mc ? fmtDateY(addDays(a.start, mc.p50)) : '-'}, P80 ${p80}; on-time probability ${mc ? Math.round(mc.onTime * 100) : '-'}%.\n- Main drivers: ${top.slice(0, 3).map((r) => `${r.id} (${Math.round(r.p * 100)}%)`).join(', ')} on ${top.slice(0, 3).filter((r) => r.critical).length} critical-path task(s).\n- Commit externally to the P80 date, not the baseline.`
  }
  if (/critical|path|slack|float/.test(t)) {
    const cp = a.rows.filter((r) => r.critical)
    return `**Critical path** (${cp.length} tasks, zero float): ${cp.map((r) => r.id).join(' → ')}.\nAny day lost here moves go-live. High-risk tasks on it: ${cp.filter((r) => r.level === 'High').map((r) => `${r.id} ${r.name}`).join(', ') || 'none'}. Protect them first.`
  }
  if (/mitigat|do|fix|action|recommend|should|help/.test(t)) {
    return `**Recommended actions (highest impact first)**\n${plan.filter((m) => m.rank === 1).slice(0, 5).map((m) => `- **${m.task.id} ${m.task.name}** (${m.task.owner}, ${Math.round(m.task.p * 100)}% risk): ${m.title.toLowerCase()} - ${m.action} (−${Math.round(m.drop * 100)} pts)`).join('\n')}`
  }
  return `**${project.name} at a glance**\n- ${a.kpi.high} high-risk, ${a.kpi.medium} medium-risk tasks; ${a.kpi.progress.toFixed(0)}% earned.\n- Top risk: ${top[0] ? `${top[0].id} ${top[0].name} (${Math.round(top[0].p * 100)}%)` : 'none'}.\n- P80 go-live ${p80} vs committed ${fmtDateY(a.kpi.deadline)}.\n\nAsk me about risks, cost, the critical path, the go-live date, or "what should I do".`
}

export function localReport(project, a, mc) {
  const top = [...a.rows].filter((r) => !r.done).sort((x, y) => y.score - x.score).slice(0, 4)
  const plan = mitigationPlan(a)
  const rag = (mc && mc.onTime < 0.3) || a.evm.CPI < 0.9 ? 'RED' : (mc && mc.onTime < 0.6) || a.evm.CPI < 0.97 ? 'AMBER' : 'GREEN'
  return `### Weekly status - ${project.name} (${fmtDateY(a.status)})\n**Overall: ${rag}** - ${a.kpi.high} high-risk tasks; P80 go-live ${mc ? fmtDateY(addDays(a.start, mc.p80)) : '-'} vs committed ${fmtDateY(a.kpi.deadline)}.\n\n**Schedule** - ${a.kpi.progress.toFixed(0)}% earned, SPI ${a.evm.SPI.toFixed(2)}; on-time probability ${mc ? Math.round(mc.onTime * 100) : '-'}%.\n\n**Cost** - CPI ${a.evm.CPI.toFixed(2)}, EAC ${inr(a.evm.EAC)} against budget ${inr(a.evm.BAC)}.\n\n**Top risks & mitigations**\n${top.map((r) => { const m = plan.find((x) => x.task.id === r.id); return `- ${r.id} ${r.name} (${r.owner}) - ${Math.round(r.p * 100)}% delay risk${m ? `; ${m.title.toLowerCase()}` : ''}` }).join('\n')}\n\n**Decisions needed** - approve resource levelling for over-allocated teams and confirm a re-baselined go-live at P80.`
}

export async function askCopilot({ question, mode = 'chat', project, analysis, mc, history, useLLM }) {
  if (useLLM) {
    try {
      const r = await post({ mode, question, history, context: buildContext(project, analysis, mc) })
      return { text: r.answer, source: r.model }
    } catch (e) { console.warn('LLM failed, using built-in copilot', e) }
  }
  const text = mode === 'report' ? localReport(project, analysis, mc) : localAnswer(question || '', project, analysis, mc)
  return { text, source: 'built-in' }
}

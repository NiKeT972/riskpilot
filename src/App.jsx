import React, { useEffect, useMemo, useState } from 'react'
import { SAMPLES } from './lib/samples'
import { analyze, monteCarlo, fmtDateY } from './lib/engine'
import { llmStatus } from './lib/agent'
import { Overview, PlanView, ScheduleView, RiskView, MitigationView, CostView, ForecastView, CopilotView, ModelView } from './views'

const VIEWS = [
  ['overview', 'Overview', '◎'],
  ['plan', 'AI Planner & Tasks', '✎'],
  ['schedule', 'Schedule', '▤'],
  ['risk', 'Risk Prediction', '⚠'],
  ['mitigation', 'Mitigation & What-if', '⛨'],
  ['cost', 'Cost (EVM)', '₹'],
  ['forecast', 'Forecast', '◷'],
  ['copilot', 'AI Copilot', '✦'],
  ['model', 'Model', 'ƒ'],
]

const STORE = 'riskpilot.v2'
function load() {
  try { const s = JSON.parse(localStorage.getItem(STORE)); if (s?.projects?.length) return s } catch { /* ignore */ }
  return null
}

export default function App() {
  const qs = new URLSearchParams(window.location.search)
  const saved = load()
  const [projects, setProjects] = useState(saved?.projects || SAMPLES)
  const [pid, setPid] = useState(qs.get('project') || saved?.pid || 'erp')
  const [view, setView] = useState(qs.get('view') || 'overview')
  const [threshold, setThreshold] = useState(0.6)
  const [llm, setLlm] = useState(false)

  useEffect(() => { llmStatus().then(setLlm) }, [])
  useEffect(() => {
    try { localStorage.setItem(STORE, JSON.stringify({ projects, pid })) } catch { /* ignore */ }
  }, [projects, pid])

  const project = projects.find((p) => p.id === pid) || projects[0]
  const analysis = useMemo(() => analyze(project), [project])
  const mc = useMemo(() => monteCarlo(project, analysis, { n: 2000 }), [project, analysis])
  const mcMit = useMemo(() => monteCarlo(project, analysis, { n: 2000, mitigate: true, threshold }), [project, analysis, threshold])

  const update = (patch) => setProjects((ps) => ps.map((p) => (p.id === project.id ? { ...p, ...patch } : p)))
  const addProject = (p) => { setProjects((ps) => [...ps, p]); setPid(p.id); setView('plan') }
  const removeProject = () => {
    if (projects.length <= 1) return
    const rest = projects.filter((p) => p.id !== project.id)
    setProjects(rest); setPid(rest[0].id)
  }
  const reset = () => { setProjects(SAMPLES); setPid('erp') }

  const props = { project, analysis, mc, mcMit, threshold, setThreshold, update, addProject, llm, setView, removeProject, reset }
  const V = { overview: Overview, plan: PlanView, schedule: ScheduleView, risk: RiskView, mitigation: MitigationView, cost: CostView, forecast: ForecastView, copilot: CopilotView, model: ModelView }[view] || Overview
  const title = VIEWS.find((v) => v[0] === view)?.[1]

  return (
    <div className="app">
      <aside className="side">
        <div className="logo">
          <svg width="30" height="30" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#4f46e5" /><path d="M8 22 L14 14 L18 18 L24 9" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" /><circle cx="24" cy="9" r="2.5" fill="#fbbf24" /></svg>
          <div>RiskPilot<small>AI project risk copilot</small></div>
        </div>
        {VIEWS.map(([k, label, ic]) => (
          <button key={k} className={`nav ${view === k ? 'on' : ''}`} onClick={() => setView(k)}><span className="ic">{ic}</span>{label}</button>
        ))}
        <div className="foot">
          <span className="pill"><span className="dot" style={{ background: llm ? '#22c55e' : '#f59e0b' }} />{llm ? 'LLM agent online (Groq)' : 'Built-in agent mode'}</span>
          <div style={{ marginTop: 10 }}>ML: Gradient Boosting · 150 trees<br />Runs in your browser - project data stays on your device.</div>
        </div>
      </aside>
      <main className="main">
        <div className="top">
          <h1>{title}<span className="sub">{project.name} · status date {fmtDateY(analysis.status)}</span></h1>
          <select value={project.id} onChange={(e) => setPid(e.target.value)} aria-label="Project">
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <label className="small muted">Status date&nbsp;
            <input type="date" value={project.statusDate} onChange={(e) => e.target.value && update({ statusDate: e.target.value })} />
          </label>
          <button className="btn primary" onClick={() => setView('plan')}>+ New project</button>
        </div>
        <V {...props} />
      </main>
    </div>
  )
}

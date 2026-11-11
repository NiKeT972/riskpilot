import React, { useMemo, useRef, useState } from 'react'
import {
  ResponsiveContainer, BarChart, Bar as RBar, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ScatterChart, Scatter,
  ZAxis, Cell, LineChart, Line, ReferenceLine, ReferenceArea, ComposedChart, Area,
} from 'recharts'
import { Kpi, Tag, Bar, Card, Md, COLORS, pct } from './ui'
import { addDays, fmtDate, fmtDateY, inr, mitigationPlan, daysBetween, toDate } from './lib/engine'
import { explain, predictProb, predictSlip, MODEL, FEATURE_LABELS, riskLevel } from './lib/ml'
import { generatePlan, askCopilot } from './lib/agent'
import { parseCSV, toCSV, download } from './lib/csv'
import { blankTask } from './lib/samples'

const PHASES = ['Initiation', 'Planning', 'Execution', 'Monitoring', 'Closure']
const dayDate = (a, d) => fmtDate(addDays(a.start, d))

// =============================================================== OVERVIEW
export function Overview({ project, analysis: a, mc, mcMit, setView }) {
  const top = [...a.rows].filter((r) => !r.done).sort((x, y) => y.score - x.score).slice(0, 6)
  const byPhase = PHASES.map((ph) => {
    const rs = a.rows.filter((r) => r.phase === ph)
    return { phase: ph, High: rs.filter((r) => r.level === 'High').length, Medium: rs.filter((r) => r.level === 'Medium').length, Low: rs.filter((r) => r.level === 'Low').length, Done: rs.filter((r) => r.done).length }
  })
  const p80 = addDays(a.start, mc.p80)
  const slip = Math.round(mc.p80 - a.kpi.deadlineDay)
  const saved = Math.round(mc.p80 - mcMit.p80)
  const plan = mitigationPlan(a).filter((m) => m.rank === 1).slice(0, 3)
  return (
    <div className="grid">
      <div className="grid g5">
        <Kpi label="Progress (earned)" value={`${a.kpi.progress.toFixed(0)}%`} note={`${a.kpi.done}/${a.kpi.tasks} tasks complete`} />
        <Kpi label="High-risk tasks" value={a.kpi.high} tone={a.kpi.high ? 'bad' : 'good'} note={`${a.kpi.medium} medium · ${a.kpi.low} low`} />
        <Kpi label="Committed go-live" value={fmtDate(a.kpi.deadline)} note={`CPM finish ${fmtDate(a.kpi.plannedEnd)} + ${a.kpi.buffer}-day buffer`} />
        <Kpi label="AI forecast (P80)" value={fmtDate(p80)} tone={slip > 3 ? 'bad' : 'good'} note={`${slip >= 0 ? `${slip} days late` : `${-slip} days to spare`} · on-time ${pct(mc.onTime)}`} />
        <Kpi label="Cost performance" value={`CPI ${a.evm.CPI.toFixed(2)}`} tone={a.evm.CPI < 0.97 ? 'bad' : 'good'} note={`EAC ${inr(a.evm.EAC)} vs ${inr(a.evm.BAC)}`} />
      </div>
      <div className="banner">
        <b>AI insight.</b> {a.kpi.high} of {a.kpi.tasks - a.kpi.done} open tasks are likely to slip, concentrated in {byPhase.slice().sort((x, y) => y.High - x.High)[0].phase}.
        At current risk the project has a {pct(mc.onTime)} chance of meeting the committed go-live of {fmtDateY(a.kpi.deadline)}; the P80 date is {fmtDateY(p80)}.
        Applying the recommended mitigations to high-risk tasks pulls P80 in by <b>{saved} days</b> and lifts on-time probability to <b>{pct(mcMit.onTime)}</b>.
      </div>
      <div className="grid g21">
        <Card title="Top risks right now" hint="Ranked by risk score = P(delay) × impact" right={<button className="btn" onClick={() => setView('risk')}>Risk register →</button>}>
          <table><thead><tr><th>Task</th><th>Owner</th><th>P(delay)</th><th>Exp. slip</th><th></th></tr></thead><tbody>
            {top.map((r) => (
              <tr key={r.id}><td><b>{r.id}</b> {r.name}</td><td>{r.owner}</td>
                <td style={{ width: 150 }}><div className="row"><Bar value={r.p} color={COLORS[r.level]} /><span>{pct(r.p)}</span></div></td>
                <td>{r.expSlip.toFixed(1)} d</td><td>{r.critical && <span className="tag crit">Critical</span>}</td></tr>
            ))}
          </tbody></table>
        </Card>
        <Card title="Risk by phase" hint="Open tasks by predicted risk level">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={byPhase} margin={{ left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="phase" fontSize={11} interval={0} /><YAxis allowDecimals={false} fontSize={11} /><Tooltip /><Legend wrapperStyle={{ fontSize: 12 }} />
              {['High', 'Medium', 'Low', 'Done'].map((k) => <RBar key={k} dataKey={k} stackId="a" fill={COLORS[k]} />)}
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>
      <Card title="Next best actions" hint="Highest-impact mitigation per high-risk task" right={<button className="btn" onClick={() => setView('mitigation')}>All actions →</button>}>
        <div className="grid g3">
          {plan.map((m) => (
            <div className="driver" key={m.task.id}>
              <div className="t"><Tag level={m.task.level} />{m.task.id} · {m.title}</div>
              <div className="a">{m.action}</div>
              <div className="m">{m.task.name} · {m.task.owner} · cuts risk {Math.round(m.drop * 100)} pts</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

// =============================================================== PLANNER
export function PlanView({ project, analysis: a, update, addProject, llm, removeProject, reset }) {
  const [desc, setDesc] = useState('Build a food-delivery mobile app for our college canteen with online payments, live order tracking and an admin dashboard. Budget 25 lakh, launch in 3 months.')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const file = useRef()

  const create = async () => {
    setBusy(true); setMsg('')
    const plan = await generatePlan(desc, llm)
    const id = 'p' + Date.now().toString(36)
    const tasks = (plan.tasks || []).map((t) => ({ ...blankTask(t.id), ...t, reqChanges: t.reqChanges ?? 0, progress: 0, actualCost: 0 }))
    const today = new Date().toISOString().slice(0, 10)
    addProject({ id, name: plan.name || 'New project', description: desc, startDate: today, statusDate: today, tasks })
    setMsg(`Created "${plan.name}" with ${tasks.length} tasks using ${plan.source}.${plan.warnings?.length ? ` Fixed ${plan.warnings.length} problem(s) in the plan (e.g. ${plan.warnings[0]}).` : ''} Review the plan below, then update progress as work happens.`)
    setBusy(false)
  }
  const onImport = (e) => {
    const f = e.target.files?.[0]; if (!f) return
    f.text().then((txt) => {
      try {
        const tasks = parseCSV(txt)
        const today = new Date().toISOString().slice(0, 10)
        addProject({ id: 'p' + Date.now().toString(36), name: f.name.replace(/\.csv$/i, ''), startDate: today, statusDate: today, tasks })
        setMsg(`Imported ${tasks.length} tasks from ${f.name}.`)
      } catch (err) { setMsg('Import failed: ' + err.message) }
    })
    e.target.value = ''
  }
  const setTask = (i, k, v) => update({ tasks: project.tasks.map((t, j) => (j === i ? { ...t, [k]: v } : t)) })
  const num = (i, k) => (e) => setTask(i, k, e.target.value === '' ? 0 : +e.target.value)
  const addTask = () => {
    const n = project.tasks.length + 1
    update({ tasks: [...project.tasks, blankTask(`T${String(n).padStart(2, '0')}`)] })
  }
  const delTask = (i) => update({ tasks: project.tasks.filter((_, j) => j !== i) })

  return (
    <div className="grid">
      <div className="grid g2">
        <Card title="✦ AI project planner" hint={llm ? 'Describe the project; the LLM agent drafts a full work breakdown with dependencies, durations and budgets.' : 'Describe the project; the built-in planner drafts a work breakdown (add a GROQ_API_KEY on Vercel to use the LLM agent).'}>
          <textarea rows={4} value={desc} onChange={(e) => setDesc(e.target.value)} />
          <div className="row mt"><button className="btn primary" disabled={busy || desc.trim().length < 15} onClick={create}>{busy ? 'Planning…' : 'Generate plan with AI'}</button><span className="small muted">Creates a new project</span></div>
        </Card>
        <Card title="Import / export" hint="Bring tasks from Jira, MS Project or Excel as CSV. Columns: id, name, phase, owner, duration, deps (; separated), complexity, teamSize, experience, utilization, reqChanges, vendor, budget, progress, actualCost.">
          <div className="row">
            <button className="btn" onClick={() => file.current.click()}>Import CSV</button>
            <input ref={file} type="file" accept=".csv" hidden onChange={onImport} />
            <button className="btn" onClick={() => download(`${project.name}.csv`, toCSV(project.tasks))}>Export current project</button>
            <button className="btn" onClick={() => download('riskpilot-template.csv', toCSV(project.tasks.slice(0, 3)))}>Template</button>
          </div>
          <div className="row mt"><button className="btn" onClick={removeProject}>Delete project</button><button className="btn" onClick={reset}>Restore sample projects</button></div>
        </Card>
      </div>
      {msg && <div className="banner">{msg}</div>}
      <Card title={`Tasks - ${project.name}`} hint="Edit any value; risk, schedule, cost and forecasts update instantly. Progress & actual cost are as of the status date."
        right={<div className="row"><label className="small muted">Start&nbsp;<input type="date" value={project.startDate} onChange={(e) => e.target.value && update({ startDate: e.target.value })} /></label><label className="small muted">Committed go-live&nbsp;<input type="date" value={project.deadline || ''} onChange={(e) => update({ deadline: e.target.value || undefined })} /></label><button className="btn" onClick={addTask}>+ Task</button></div>}>
        <div className="tbl-wrap">
          <table className="edit"><thead><tr>
            <th>ID</th><th style={{ minWidth: 190 }}>Task</th><th>Phase</th><th>Owner</th><th>Days</th><th>Depends on</th><th title="1-5">Cx</th><th>Team</th><th>Exp (y)</th><th>Util %</th><th>Req Δ</th><th>Vendor</th><th>Budget ₹</th><th>Done %</th><th>Actual ₹</th><th>Risk</th><th></th>
          </tr></thead><tbody>
            {project.tasks.map((t, i) => {
              const r = a.byId[t.id]
              return (
                <tr key={i}>
                  <td><input type="text" value={t.id} onChange={(e) => setTask(i, 'id', e.target.value)} style={{ width: 52 }} /></td>
                  <td><input type="text" value={t.name} onChange={(e) => setTask(i, 'name', e.target.value)} /></td>
                  <td><select style={{ minWidth: 110 }} value={t.phase} onChange={(e) => setTask(i, 'phase', e.target.value)}>{PHASES.map((p) => <option key={p}>{p}</option>)}</select></td>
                  <td><input type="text" value={t.owner} onChange={(e) => setTask(i, 'owner', e.target.value)} style={{ width: 110 }} /></td>
                  <td><input type="number" min="1" value={t.duration} onChange={num(i, 'duration')} style={{ width: 54 }} /></td>
                  <td><input type="text" value={(t.deps || []).join(', ')} onChange={(e) => setTask(i, 'deps', e.target.value.split(/[,; ]+/).filter(Boolean))} style={{ width: 100 }} /></td>
                  <td><input type="number" min="1" max="5" value={t.complexity} onChange={num(i, 'complexity')} style={{ width: 46 }} /></td>
                  <td><input type="number" min="1" value={t.teamSize} onChange={num(i, 'teamSize')} style={{ width: 46 }} /></td>
                  <td><input type="number" step="0.5" value={t.experience} onChange={num(i, 'experience')} style={{ width: 54 }} /></td>
                  <td><input type="number" value={t.utilization} onChange={num(i, 'utilization')} style={{ width: 58 }} /></td>
                  <td><input type="number" min="0" value={t.reqChanges} onChange={num(i, 'reqChanges')} style={{ width: 46 }} /></td>
                  <td style={{ textAlign: 'center' }}><input type="checkbox" checked={!!t.vendor} onChange={(e) => setTask(i, 'vendor', e.target.checked)} /></td>
                  <td><input type="number" value={t.budget} onChange={num(i, 'budget')} style={{ width: 92 }} /></td>
                  <td><input type="number" min="0" max="100" value={t.progress} onChange={num(i, 'progress')} style={{ width: 54 }} /></td>
                  <td><input type="number" value={t.actualCost} onChange={num(i, 'actualCost')} style={{ width: 92 }} /></td>
                  <td>{r && <Tag level={r.level} />}</td>
                  <td><button className="btn" style={{ padding: '2px 8px' }} onClick={() => delTask(i)} title="Remove">×</button></td>
                </tr>
              )
            })}
          </tbody></table>
        </div>
      </Card>
    </div>
  )
}

// =============================================================== SCHEDULE
export function ScheduleView({ analysis: a, mc }) {
  const rows = [...a.rows].sort((x, y) => x.es - y.es || x.id.localeCompare(y.id))
  const span = Math.max(...a.rows.map((r) => Math.max(daysBetween(a.start, r.fcEnd), r.ef))) + 4
  const x = (d) => `${(d / span) * 100}%`
  const ticks = []
  const step = span > 120 ? 14 : 7
  for (let d = 0; d <= span; d += step) ticks.push(d)
  return (
    <div className="grid">
      <div className="grid g4">
        <Kpi label="Planned finish (CPM)" value={fmtDateY(a.kpi.plannedEnd)} note={`${a.kpi.duration} days · deadline ${fmtDate(a.kpi.deadline)}`} />
        <Kpi label="Expected finish" value={fmtDateY(a.kpi.expectedEnd)} tone="warn" note="with ML-expected slippage" />
        <Kpi label="Critical-path tasks" value={a.kpi.critical} note="zero total float" />
        <Kpi label="Schedule index (SPI)" value={a.evm.SPI.toFixed(2)} tone={a.evm.SPI < 0.95 ? 'bad' : 'good'} note={a.evm.SPI < 1 ? 'behind plan' : 'on/ahead of plan'} />
      </div>
      <Card title="AI-forecast Gantt chart" hint="Bars = baseline schedule coloured by predicted delay risk; dark overlay = % complete; dashed line & diamond = AI-forecast finish; blue line = status date; red line = committed go-live. Purple ID = critical path.">
        <div className="legend" style={{ marginBottom: 8 }}>
          {['High', 'Medium', 'Low', 'Done'].map((k) => <span key={k}><i className="sw" style={{ background: COLORS[k] }} />{k}</span>)}
          <span><i className="sw" style={{ background: '#111827', transform: 'rotate(45deg) scale(.7)' }} />AI-forecast finish</span>
        </div>
        <div className="gantt">
          <div className="g-axis"><div /><div style={{ position: 'relative' }}>{ticks.map((d) => <span key={d} style={{ position: 'absolute', left: x(d) }}>{dayDate(a, d)}</span>)}</div></div>
          {rows.map((r) => {
            const fcd = daysBetween(a.start, r.fcEnd)
            return (
              <div className="g-row" key={r.id}>
                <div className="g-name"><b style={{ color: r.critical ? '#6d28d9' : undefined }}>{r.id}</b> {r.name}</div>
                <div className="g-track">
                  <div className="g-today" style={{ left: x(a.elapsed) }} />
                  <div className="g-today" style={{ left: x(a.kpi.deadlineDay), background: '#dc2626', opacity: .5 }} />
                  <div className="g-bar" style={{ left: x(r.es), width: x(r.duration), background: COLORS[r.level], opacity: r.done ? 0.6 : 0.9 }} title={`${r.name}: ${fmtDate(r.startD)} → ${fmtDate(r.endD)}, risk ${pct(r.p)}`} />
                  {r.progress > 0 && <div className="g-prog" style={{ left: x(r.es), width: x(r.duration * r.progress / 100) }} />}
                  {fcd > r.ef + 0.5 && <div className="g-fc" style={{ left: x(r.ef), width: x(fcd - r.ef) }} />}
                  {!r.done && <div className="g-dia" style={{ left: x(fcd) }} title={`Forecast finish ${fmtDate(r.fcEnd)}`} />}
                </div>
              </div>
            )
          })}
        </div>
      </Card>
      <Card title="Critical Path Method (CPM) table" hint="Forward/backward pass. Criticality index = share of Monte Carlo runs in which the task was on the driving path.">
        <div className="tbl-wrap"><table><thead><tr><th>ID</th><th>Task</th><th>Days</th><th>Early start</th><th>Early finish</th><th>Total float</th><th>Criticality index</th><th>Forecast finish</th><th>Risk</th></tr></thead><tbody>
          {rows.map((r) => (
            <tr key={r.id}><td><b>{r.id}</b></td><td>{r.name} {r.critical && <span className="tag crit">Critical</span>}</td><td>{r.duration}</td>
              <td>{fmtDate(r.startD)}</td><td>{fmtDate(r.endD)}</td><td>{r.slack} d</td>
              <td style={{ width: 150 }}><div className="row"><Bar value={mc.criticality[r.id] || 0} color="#7c3aed" /><span>{pct(mc.criticality[r.id] || 0)}</span></div></td>
              <td>{fmtDate(r.fcEnd)}</td><td><Tag level={r.level} /></td></tr>
          ))}
        </tbody></table></div>
      </Card>
    </div>
  )
}

// =============================================================== RISK
export function RiskView({ analysis: a, threshold }) {
  const [sel, setSel] = useState(null)
  const open = a.rows.filter((r) => !r.done)
  const reg = [...open].sort((x, y) => y.score - x.score)
  const cur = sel ? a.byId[sel] : reg[0]
  const ex = cur ? explain(cur.f) : null
  const bars = [...open].sort((x, y) => y.p - x.p).map((r) => ({ name: r.id, p: Math.round(r.p * 100), level: r.level, task: r.name }))
  return (
    <div className="grid">
      <div className="grid g4">
        <Kpi label="High risk" value={a.kpi.high} tone="bad" note={`P(delay) ≥ ${pct(threshold)}`} />
        <Kpi label="Medium risk" value={a.kpi.medium} tone="warn" note="35-60%" />
        <Kpi label="Average delay risk" value={pct(a.kpi.avgRisk)} note="open tasks" />
        <Kpi label="Expected slippage" value={`${a.kpi.expSlip.toFixed(0)} task-days`} note="Σ P(delay) × predicted slip" />
      </div>
      <div className="grid g2">
        <Card title="Risk matrix (probability × impact)" hint="Impact 1-5 from duration, successors and critical-path position. Bubble size = planned days. Click a bubble to explain it.">
          <ResponsiveContainer width="100%" height={330}>
            <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: -10 }}>
              <ReferenceArea x1={0} x2={35} y1={0.5} y2={5.5} fill="#16a34a" fillOpacity={0.06} />
              <ReferenceArea x1={35} x2={60} y1={0.5} y2={5.5} fill="#f59e0b" fillOpacity={0.08} />
              <ReferenceArea x1={60} x2={100} y1={0.5} y2={5.5} fill="#dc2626" fillOpacity={0.07} />
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" dataKey="x" domain={[0, 100]} unit="%" name="P(delay)" fontSize={11} label={{ value: 'Probability of delay', position: 'bottom', fontSize: 12 }} />
              <YAxis type="number" dataKey="y" domain={[0.5, 5.5]} ticks={[1, 2, 3, 4, 5]} name="Impact" fontSize={11} label={{ value: 'Impact', angle: -90, position: 'insideLeft', offset: 20, fontSize: 12 }} />
              <ZAxis type="number" dataKey="z" range={[50, 500]} />
              <Tooltip cursor={false} content={({ payload }) => payload?.[0] ? <div className="card small"><b>{payload[0].payload.id}</b> {payload[0].payload.name}<br />P(delay) {payload[0].payload.x}% · impact {payload[0].payload.y}</div> : null} />
              <Scatter data={open.map((r) => ({ x: Math.round(r.p * 100), y: r.impact, z: r.duration, id: r.id, name: r.name, level: r.level }))} onClick={(d) => setSel(d.id)}
                shape={(p) => <g style={{ cursor: 'pointer' }}><circle cx={p.cx} cy={p.cy} r={Math.sqrt(p.size) / 2} fill={COLORS[p.payload.level]} fillOpacity={0.75} stroke="#fff" /><text x={p.cx} y={p.cy - Math.sqrt(p.size) / 2 - 3} textAnchor="middle" fontSize={10} fill="#374151">{p.payload.id}</text></g>} />
            </ScatterChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Delay probability by task" hint="Gradient Boosting prediction for every open task">
          <ResponsiveContainer width="100%" height={330}>
            <BarChart data={bars} margin={{ left: -20, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="name" fontSize={10} interval={0} angle={-45} textAnchor="end" height={40} /><YAxis unit="%" domain={[0, 100]} fontSize={11} />
              <Tooltip formatter={(v) => `${v}%`} labelFormatter={(l) => `${l} ${a.byId[l]?.name || ''}`} />
              <ReferenceLine y={threshold * 100} stroke="#111827" strokeDasharray="4 4" label={{ value: 'alert threshold', fontSize: 11, position: 'insideTopRight' }} />
              <RBar dataKey="p" onClick={(d) => setSel(d.name)}>{bars.map((b) => <Cell key={b.name} fill={COLORS[b.level]} cursor="pointer" />)}</RBar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>
      <div className="grid g12">
        {cur && (
          <Card title={`Why is ${cur.id} at risk?`} hint={`${cur.name} · ${cur.owner} · P(delay) ${pct(cur.p)} · if late, ~${cur.slipIfLate.toFixed(1)} days. Fixes applied cumulatively, biggest first.`}>
            {ex.drivers.length === 0 && <p className="muted">No single factor dominates - risk is spread across inputs.</p>}
            {ex.drivers.slice(0, 4).map((d) => (
              <div className="driver" key={d.feature}>
                <div className="t">{d.label}<span className="spacer" /><span className="good">−{Math.round(d.drop * 100)} pts → {pct(d.after)}</span></div>
                <div className="m">Current {typeof d.value === 'number' ? +d.value.toFixed(1) : d.value} vs healthy {+d.healthy.toFixed(1)}</div>
                <div className="a"><b>{d.title}:</b> {d.action}</div>
              </div>
            ))}
          </Card>
        )}
        <Card title="AI-generated risk register" hint="Click a row to see its explanation">
          <div className="tbl-wrap"><table><thead><tr><th>ID</th><th>Task</th><th>Owner</th><th>P(delay)</th><th>Impact</th><th>Score</th><th>Exp. slip</th><th>Top driver</th><th>Level</th></tr></thead><tbody>
            {reg.map((r) => {
              const d = explain(r.f).drivers[0]
              return (
                <tr key={r.id} onClick={() => setSel(r.id)} style={{ cursor: 'pointer', background: cur?.id === r.id ? '#eef2ff' : undefined }}>
                  <td><b>{r.id}</b></td><td>{r.name}{r.critical && <> <span className="tag crit">CP</span></>}</td><td>{r.owner}</td>
                  <td style={{ width: 130 }}><div className="row"><Bar value={r.p} color={COLORS[r.level]} /><span>{pct(r.p)}</span></div></td>
                  <td>{r.impact}</td><td><b>{r.score}</b></td><td>{r.expSlip.toFixed(1)} d</td><td className="small">{d?.label || '-'}</td><td><Tag level={r.level} /></td>
                </tr>
              )
            })}
          </tbody></table></div>
        </Card>
      </div>
    </div>
  )
}

// =============================================================== MITIGATION
export function MitigationView({ analysis: a, threshold, setThreshold }) {
  const plan = mitigationPlan(a, threshold)
  const high = [...a.rows].filter((r) => !r.done).sort((x, y) => y.p - x.p)
  const [tid, setTid] = useState(high[0]?.id)
  const r = a.byId[tid] || high[0]
  const [ov, setOv] = useState({})
  const f = r ? { ...r.f, ...ov } : null
  const p2 = f ? predictProb(f) : 0
  const s2 = f ? p2 * predictSlip(f) : 0
  const drivers = Object.values(plan.reduce((acc, m) => { acc[m.label] = acc[m.label] || { label: m.label, total: 0, n: 0 }; acc[m.label].total += m.drop * 100; acc[m.label].n++; return acc }, {})).sort((x, y) => y.total - x.total)
  const slider = (k, label, min, max, step = 1) => (
    <label key={k} className="small" style={{ display: 'block', marginBottom: 10 }}>
      <div className="row"><span>{label}</span><span className="spacer" /><b>{+(f[k]).toFixed(1)}</b></div>
      <input type="range" min={min} max={max} step={step} value={f[k]} style={{ width: '100%' }} onChange={(e) => setOv({ ...ov, [k]: +e.target.value })} />
    </label>
  )
  return (
    <div className="grid">
      <div className="grid g4">
        <Kpi label="Tasks needing action" value={new Set(plan.map((m) => m.task.id)).size} note={`above ${pct(threshold)} risk`} />
        <Kpi label="Actions recommended" value={plan.length} />
        <Kpi label="Top project-wide driver" value={drivers[0]?.label || '-'} tone="warn" />
        <div className="card kpi"><div className="lab">Alert threshold</div><div className="val">{pct(threshold)}</div>
          <input type="range" min="0.35" max="0.85" step="0.05" value={threshold} onChange={(e) => setThreshold(+e.target.value)} style={{ width: '100%' }} /></div>
      </div>
      <div className="grid g21">
        <Card title="Mitigation action plan" hint="For each high-risk task, the drivers the model says matter most and the PM technique that addresses them" right={<button className="btn" onClick={() => download('mitigation-plan.csv', ['task,owner,risk,driver,technique,action,risk_reduction_pts', ...plan.map((m) => [m.task.id, m.task.owner, Math.round(m.task.p * 100), m.label, m.technique, `"${m.action}"`, Math.round(m.drop * 100)].join(','))].join('\n'))}>Download CSV</button>}>
          <div className="tbl-wrap"><table><thead><tr><th>Task</th><th>Owner</th><th>Risk</th><th>Driver</th><th>Technique</th><th>Recommended action</th><th>Δ risk</th></tr></thead><tbody>
            {plan.map((m, i) => (
              <tr key={i}><td>{m.rank === 1 && <><b>{m.task.id}</b> {m.task.name}</>}</td><td>{m.rank === 1 && m.task.owner}</td><td>{m.rank === 1 && pct(m.task.p)}</td>
                <td>{m.label}</td><td><span className="tag" style={{ background: '#eef2ff', color: '#3730a3' }}>{m.technique}</span></td><td className="small">{m.action}</td><td className="good"><b>−{Math.round(m.drop * 100)}</b></td></tr>
            ))}
          </tbody></table></div>
        </Card>
        <Card title="Risk drivers across the project" hint="Total risk reduction (pts) if each driver were fixed on every high-risk task">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={drivers} layout="vertical" margin={{ left: 40, right: 20 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" fontSize={11} /><YAxis type="category" dataKey="label" fontSize={11} width={120} /><Tooltip formatter={(v) => `${v.toFixed(0)} pts`} />
              <RBar dataKey="total" fill="#4f46e5" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>
      {r && (
        <Card title="What-if simulator" hint="Change the levers a project manager controls and watch the ML prediction respond">
          <div className="row" style={{ marginBottom: 14 }}>
            <select value={r.id} onChange={(e) => { setTid(e.target.value); setOv({}) }}>{high.map((h) => <option key={h.id} value={h.id}>{h.id} - {h.name} ({pct(h.p)})</option>)}</select>
            <button className="btn" onClick={() => setOv({})}>Reset</button>
            <button className="btn" onClick={() => { const e = explain(r.f); const o = {}; e.drivers.slice(0, 2).forEach((d) => { o[d.feature] = d.healthy }); setOv(o) }}>Apply top-2 AI mitigations</button>
          </div>
          <div className="grid g3">
            <div>{slider('team_size', 'Team size', 1, 10)}{slider('team_experience_yrs', 'Team experience (yrs)', 0.5, 12, 0.5)}{slider('resource_utilization', 'Resource utilisation (%)', 40, 140)}</div>
            <div>{slider('requirement_changes', 'Requirement changes', 0, 8)}{slider('progress_gap_pct', 'Progress behind plan (%)', 0, 60)}{slider('complexity', 'Complexity (1-5)', 1, 5)}</div>
            <div className="grid" style={{ alignContent: 'start' }}>
              <div className="grid g2">
                <Kpi label="Risk now" value={pct(r.p)} tone="bad" />
                <Kpi label="Risk after" value={pct(p2)} tone={p2 < r.p ? 'good' : 'bad'} note={`${p2 - r.p <= 0 ? '' : '+'}${Math.round((p2 - r.p) * 100)} pts`} />
              </div>
              <div className="grid g2">
                <Kpi label="Exp. slip now" value={`${r.expSlip.toFixed(1)} d`} />
                <Kpi label="Exp. slip after" value={`${s2.toFixed(1)} d`} tone={s2 < r.expSlip ? 'good' : ''} />
              </div>
              <div className="small muted">Level: <Tag level={riskLevel(p2)} /></div>
            </div>
          </div>
        </Card>
      )}
    </div>
  )
}

// =============================================================== COST
export function CostView({ analysis: a }) {
  const e = a.evm
  const tasks = a.rows.filter((r) => r.ev > 0 || r.ac > 0).map((r) => ({ id: r.id, name: r.name, CV: Math.round(r.ev - r.ac), pctOver: r.ev > 0 ? ((r.ac - r.ev) / r.ev) * 100 : 0 })).sort((x, y) => x.CV - y.CV)
  return (
    <div className="grid">
      <div className="grid g4">
        <Kpi label="Budget at completion (BAC)" value={inr(e.BAC)} />
        <Kpi label="Earned value (EV)" value={inr(e.EV)} note={`Planned value ${inr(e.PV)}`} />
        <Kpi label="Actual cost (AC)" value={inr(e.AC)} tone={e.AC > e.EV ? 'bad' : 'good'} note={`Cost variance ${inr(e.CV)}`} />
        <Kpi label="Estimate at completion" value={inr(e.EAC)} tone={e.VAC < 0 ? 'bad' : 'good'} note={`VAC ${inr(e.VAC)}`} />
      </div>
      <div className="grid g4">
        <Kpi label="CPI = EV / AC" value={e.CPI.toFixed(2)} tone={e.CPI < 1 ? 'bad' : 'good'} note={e.CPI < 1 ? `₹${(1 / e.CPI).toFixed(2)} spent per ₹1 of work` : 'under budget'} />
        <Kpi label="SPI = EV / PV" value={e.SPI.toFixed(2)} tone={e.SPI < 1 ? 'bad' : 'good'} note={e.SPI < 1 ? 'work behind schedule' : 'on schedule'} />
        <Kpi label="Estimate to complete" value={inr(e.ETC)} />
        <Kpi label="To-complete index" value={((e.BAC - e.EV) / Math.max(1, e.BAC - e.AC)).toFixed(2)} note="CPI needed to finish on budget" />
      </div>
      <div className="grid g21">
        <Card title="Earned value S-curve" hint="Planned value (baseline) vs earned value and actual cost up to the status date (interpolated from the current totals), then the cost forecast that ends at EAC">
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={a.curve} margin={{ left: 10, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="date" fontSize={11} /><YAxis tickFormatter={(v) => inr(v)} fontSize={11} width={80} /><Tooltip formatter={(v) => inr(v)} /><Legend wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="PV" name="Planned value" stroke="#94a3b8" fill="#e2e8f0" />
              <Line type="monotone" dataKey="EV" name="Earned value" stroke="#16a34a" strokeWidth={2.5} dot={false} />
              <Line type="monotone" dataKey="AC" name="Actual cost" stroke="#dc2626" strokeWidth={2.5} dot={false} />
              <Line type="monotone" dataKey="Forecast" name="Cost forecast" stroke="#dc2626" strokeDasharray="6 4" dot={false} />
              <ReferenceLine x={dayDate(a, Math.round(a.elapsed / Math.max(1, Math.round(a.base.finish / 30))) * Math.max(1, Math.round(a.base.finish / 30)))} stroke="#4f46e5" label={{ value: 'status', fontSize: 11 }} />
              <ReferenceLine y={e.BAC} stroke="#111827" strokeDasharray="3 3" label={{ value: 'BAC', fontSize: 11, position: 'insideTopLeft' }} />
            </ComposedChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Cost variance by task" hint="EV − AC (negative = overrun)">
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={tasks} layout="vertical" margin={{ left: 0, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" tickFormatter={(v) => inr(v)} fontSize={10} /><YAxis type="category" dataKey="id" fontSize={11} width={40} />
              <Tooltip formatter={(v) => inr(v)} labelFormatter={(l) => `${l} ${a.byId[l]?.name}`} /><ReferenceLine x={0} stroke="#111827" />
              <RBar dataKey="CV">{tasks.map((t) => <Cell key={t.id} fill={t.CV < 0 ? '#dc2626' : '#16a34a'} />)}</RBar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>
    </div>
  )
}

// =============================================================== FORECAST
export function ForecastView({ analysis: a, mc, mcMit, threshold }) {
  const lo = Math.floor(Math.min(mc.sorted[0], mcMit.sorted[0]))
  const hi = Math.ceil(Math.max(mc.sorted.at(-1), mcMit.sorted.at(-1)))
  const bw = Math.max(1, Math.ceil((hi - lo) / 28))
  const nb = Math.floor((hi - lo) / bw) + 1
  const bin = (arr) => { const h = new Array(nb).fill(0); arr.forEach((v) => { h[Math.min(nb - 1, Math.floor((v - lo) / bw))]++ }); return h }
  const h1 = bin(mc.sorted), h2 = bin(mcMit.sorted)
  const data = h1.map((c, i) => ({ label: dayDate(a, lo + i * bw), Current: c, Mitigated: h2[i] }))
  let c1 = 0, c2 = 0
  const cdf = h1.map((c, i) => { c1 += c; c2 += h2[i]; return { label: dayDate(a, lo + (i + 1) * bw), Current: Math.round((c1 / mc.sorted.length) * 100), Mitigated: Math.round((c2 / mcMit.sorted.length) * 100) } })
  const deadlineLabel = dayDate(a, lo + Math.max(0, Math.min(nb - 1, Math.floor((mc.planned - lo) / bw))) * bw)
  const D = (x) => fmtDateY(addDays(a.start, x))
  return (
    <div className="grid">
      <div className="grid g5">
        <Kpi label="Committed go-live" value={fmtDate(a.kpi.deadline)} note={`baseline ${fmtDate(a.kpi.plannedEnd)} + ${a.kpi.buffer}d buffer`} />
        <Kpi label="P50 (current)" value={fmtDate(addDays(a.start, mc.p50))} note="50% confidence" />
        <Kpi label="P80 (current)" value={fmtDate(addDays(a.start, mc.p80))} tone="bad" note={`${Math.round(mc.p80 - mc.planned) >= 0 ? '+' : ''}${Math.round(mc.p80 - mc.planned)} days vs deadline`} />
        <Kpi label="P80 (mitigated)" value={fmtDate(addDays(a.start, mcMit.p80))} tone="good" note={`saves ${Math.round(mc.p80 - mcMit.p80)} days`} />
        <Kpi label="On-time probability" value={`${pct(mc.onTime)} → ${pct(mcMit.onTime)}`} note="current → mitigated" />
      </div>
      <div className="grid g2">
        <Card title="Monte Carlo go-live distribution" hint={`2,000 simulations through the dependency network. Each task is late with its ML probability; slip size ~ Gamma(k=2) around the predicted delay. Mitigated = top-2 AI actions on tasks ≥ ${pct(threshold)}.`}>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data} barGap={0} barCategoryGap={1} margin={{ left: -15 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="label" fontSize={10} interval="preserveStartEnd" /><YAxis fontSize={11} /><Tooltip /><Legend wrapperStyle={{ fontSize: 12 }} />
              <ReferenceLine x={deadlineLabel} stroke="#111827" strokeDasharray="4 4" label={{ value: 'deadline', fontSize: 11, position: 'top' }} />
              <RBar dataKey="Current" fill="#dc2626" fillOpacity={0.7} />
              <RBar dataKey="Mitigated" fill="#16a34a" fillOpacity={0.7} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Confidence curve (S-curve)" hint="Probability of finishing on or before each date">
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={cdf} margin={{ left: -15 }}>
              <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="label" fontSize={10} interval="preserveStartEnd" /><YAxis unit="%" domain={[0, 100]} fontSize={11} /><Tooltip formatter={(v) => `${v}%`} /><Legend wrapperStyle={{ fontSize: 12 }} />
              <ReferenceLine y={80} stroke="#111827" strokeDasharray="4 4" label={{ value: 'P80', fontSize: 11, position: 'insideLeft' }} />
              <Line type="monotone" dataKey="Current" stroke="#dc2626" strokeWidth={2.5} dot={false} />
              <Line type="monotone" dataKey="Mitigated" stroke="#16a34a" strokeWidth={2.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      </div>
      <div className="banner">
        <b>Decision support.</b> Commit externally to the P80 date (<b>{D(mc.p80)}</b>) to sponsors; the committed go-live ({fmtDateY(a.kpi.deadline)}) currently has a {pct(mc.onTime)} chance.
        Funding the recommended mitigations moves P80 to <b>{D(mcMit.p80)}</b> ({Math.round(mc.p80 - mcMit.p80)} days earlier) and on-time probability to {pct(mcMit.onTime)}. Average expected finish: {D(mc.mean)} → {D(mcMit.mean)}.
      </div>
    </div>
  )
}

// =============================================================== COPILOT
export function CopilotView({ project, analysis, mc, llm }) {
  const [msgs, setMsgs] = useState([{ role: 'bot', content: `Hi! I'm RiskPilot, your project copilot for **${project.name}**. I can see the ML risk scores, critical path, EVM and the Monte Carlo forecast. Ask me anything, or generate a status report.`, src: llm ? 'LLM' : 'built-in' }])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const end = useRef()
  const send = async (text, mode = 'chat') => {
    if (busy || (!text && mode === 'chat')) return
    const userMsg = { role: 'user', content: mode === 'report' ? 'Generate this week\'s status report' : text }
    const hist = [...msgs, userMsg]
    setMsgs(hist); setQ(''); setBusy(true)
    const r = await askCopilot({ question: text, mode, project, analysis, mc, history: msgs.filter((m) => m.role !== 'sys').map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })), useLLM: llm })
    setMsgs([...hist, { role: 'bot', content: r.text, src: r.source }]); setBusy(false)
    setTimeout(() => end.current?.scrollIntoView({ behavior: 'smooth' }), 50)
  }
  const sugg = ['Which tasks should I worry about this week?', 'When will we realistically go live?', 'Are we over budget?', 'What should I do to recover the schedule?', 'Explain the critical path']
  return (
    <div className="card chat">
      <div className="chips">
        {sugg.map((s) => <button key={s} className="chip" onClick={() => send(s)}>{s}</button>)}
        <button className="chip" style={{ background: '#4f46e5', color: '#fff', borderColor: '#4f46e5' }} onClick={() => send('', 'report')}>✦ Generate status report</button>
      </div>
      <div className="msgs">
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role === 'user' ? 'user' : 'bot'}`}>
            {m.role === 'user' ? m.content : <><Md text={m.content} /><span className="src">{m.src === 'built-in' ? 'RiskPilot built-in analyst' : `RiskPilot · ${m.src}`}</span></>}
          </div>
        ))}
        {busy && <div className="msg bot muted">Thinking…</div>}
        <div ref={end} />
      </div>
      <form className="compose" onSubmit={(e) => { e.preventDefault(); send(q.trim()) }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about risks, schedule, cost or what to do next…" />
        <button className="btn primary" disabled={busy || !q.trim()}>Send</button>
      </form>
    </div>
  )
}

// =============================================================== MODEL
export function ModelView() {
  const m = MODEL.metrics
  const imp = Object.entries(MODEL.importance).map(([k, v]) => ({ name: FEATURE_LABELS[k], v: +(v * 100).toFixed(1) })).sort((x, y) => y.v - x.v)
  const roc = MODEL.roc.map(([x, y]) => ({ x, y, base: x }))
  const [[tn, fp], [fn, tp]] = MODEL.confusion
  const cell = (v, good) => <td style={{ textAlign: 'center', fontSize: 20, fontWeight: 700, padding: 18, background: good ? '#dcfce7' : '#fee2e2' }}>{v}</td>
  return (
    <div className="grid">
      <div className="grid g5">
        <Kpi label="ROC-AUC" value={m.roc_auc.toFixed(3)} />
        <Kpi label="Accuracy" value={m.accuracy.toFixed(3)} />
        <Kpi label="Recall (delays caught)" value={m.recall.toFixed(3)} tone="good" />
        <Kpi label="Precision" value={m.precision.toFixed(3)} />
        <Kpi label="F1-score" value={m.f1.toFixed(3)} />
      </div>
      <div className="grid g3">
        <Card title="ROC curve" hint={`Hold-out test set of ${m.test_size.toLocaleString()} tasks`}>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={roc} margin={{ left: -15, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="x" type="number" domain={[0, 1]} fontSize={11} label={{ value: 'False positive rate', position: 'insideBottom', offset: -2, fontSize: 11 }} /><YAxis domain={[0, 1]} fontSize={11} />
              <Line dataKey="y" stroke="#4f46e5" strokeWidth={2.5} dot={false} name="Gradient Boosting" /><Line dataKey="base" stroke="#94a3b8" strokeDasharray="4 4" dot={false} name="Random" />
            </LineChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Confusion matrix" hint="Threshold 0.5, class-weighted to favour recall">
          <table style={{ marginTop: 10 }}><thead><tr><th></th><th style={{ textAlign: 'center' }}>Predicted on time</th><th style={{ textAlign: 'center' }}>Predicted late</th></tr></thead>
            <tbody><tr><th>Actually on time</th>{cell(tn, true)}{cell(fp, false)}</tr><tr><th>Actually late</th>{cell(fn, false)}{cell(tp, true)}</tr></tbody></table>
          <p className="small muted" style={{ marginTop: 12 }}>Missing a real delay costs more than a false alarm, so the model is tuned to catch {Math.round(m.recall * 100)}% of late tasks.</p>
        </Card>
        <Card title="Feature importance" hint="Share of split gain across all trees">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={imp} layout="vertical" margin={{ left: 30, right: 10 }}>
              <XAxis type="number" unit="%" fontSize={10} /><YAxis type="category" dataKey="name" fontSize={11} width={120} /><Tooltip formatter={(v) => `${v}%`} />
              <RBar dataKey="v" fill="#4f46e5" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>
      <Card title="Model card">
        <div className="grid g2 small" style={{ lineHeight: 1.7 }}>
          <div>
            <b>Task:</b> binary classification - will a project task finish late?<br />
            <b>Algorithm:</b> Gradient Boosting (150 trees, depth 2, learning rate 0.1, subsample 0.8), class-weighted. A second Gradient Boosting regressor (MAE {m.regressor_mae_ratio} of planned duration) predicts how late.<br />
            <b>Data:</b> {(m.train_size + m.test_size).toLocaleString()} historical tasks ({Math.round(m.delay_rate * 100)}% late) generated from documented IT-project delay drivers, incl. interaction effects (overload × complexity, vendor × dependencies, scope churn × inexperience). 75/25 stratified split.<br />
            <b>Baseline:</b> logistic regression AUC {m.baseline_logreg_auc}, F1 {m.baseline_logreg_f1} - comparable; Gradient Boosting kept for its threshold/interaction handling and tree-based deployment.
          </div>
          <div>
            <b>Features (10):</b> {MODEL.features.map((k) => FEATURE_LABELS[k]).join(', ')}.<br />
            <b>Explainability:</b> greedy counterfactual attribution - actionable factors are moved one at a time to a healthy historical level (25th/75th percentile), biggest drop first, and each marginal drop in P(delay) is reported.<br />
            <b>Deployment:</b> trees exported to JSON (≈ 31 KB) and evaluated in the browser - no server round-trip, project data stays on the device.<br />
            <b>Limitations:</b> trained on simulated history; retrain on your organisation's closed projects (Jira / MS Project export) before relying on absolute probabilities. Predictions support, not replace, PM judgement.
          </div>
        </div>
      </Card>
    </div>
  )
}

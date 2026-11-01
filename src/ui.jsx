import React from 'react'

export const COLORS = { High: '#dc2626', Medium: '#f59e0b', Low: '#16a34a', Done: '#94a3b8' }
export const pct = (v, d = 0) => `${(v * 100).toFixed(d)}%`

export function Kpi({ label, value, note, tone }) {
  return (
    <div className="card kpi">
      <div className="lab">{label}</div>
      <div className={`val ${tone || ''}`}>{value}</div>
      {note && <div className="note">{note}</div>}
    </div>
  )
}

export const Tag = ({ level }) => <span className={`tag ${level}`}>{level}</span>

export function Bar({ value, color }) {
  return <div className="bar"><i style={{ width: `${Math.max(2, Math.min(100, value * 100))}%`, background: color }} /></div>
}

export function Card({ title, hint, children, right, style }) {
  return (
    <div className="card" style={style}>
      {(title || right) && <div className="row" style={{ marginBottom: hint ? 0 : 10 }}><h3>{title}</h3><div className="spacer" />{right}</div>}
      {hint && <p className="hint">{hint}</p>}
      {children}
    </div>
  )
}

// tiny markdown renderer: headings, bold, bullets, paragraphs
export function Md({ text }) {
  const lines = String(text || '').split('\n')
  const out = []; let list = []
  const inline = (s, k) => <span key={k} dangerouslySetInnerHTML={{
    __html: s.replace(/\\\*/g, '*').replace(/\u2217/g, '*').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*\w])\*([^*\n]+?)\*(?=[^*\w]|$)/g, '$1<i>$2</i>').replace(/`(.+?)`/g, '<code>$1</code>'),
  }} />
  const flush = () => { if (list.length) { out.push(<ul key={out.length}>{list.map((l, i) => <li key={i}>{inline(l, i)}</li>)}</ul>); list = [] } }
  lines.forEach((l) => {
    const t = l.trim()
    if (/^[-*•]\s+/.test(t)) list.push(t.replace(/^[-*•]\s+/, ''))
    else if (/^\d+\.\s+/.test(t)) list.push(t.replace(/^\d+\.\s+/, ''))
    else { flush(); if (/^#{1,4}\s/.test(t)) out.push(<h3 key={out.length}>{inline(t.replace(/^#+\s/, ''), 0)}</h3>); else if (t) out.push(<p key={out.length}>{inline(t, 0)}</p>) }
  })
  flush()
  return <div className="md">{out}</div>
}

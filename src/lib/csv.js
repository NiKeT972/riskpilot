export const COLUMNS = ['id', 'name', 'phase', 'owner', 'duration', 'deps', 'complexity', 'teamSize',
  'experience', 'utilization', 'reqChanges', 'vendor', 'budget', 'progress', 'actualCost']

function parseLine(line) {
  const out = []; let cur = ''; let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ } else if (c === '"') q = false; else cur += c }
    else if (c === '"') q = true
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

export function parseCSV(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim())
  if (lines.length < 2) throw new Error('CSV needs a header row and at least one task')
  const head = parseLine(lines[0]).map((h) => h.trim())
  const idx = (k) => head.findIndex((h) => h.toLowerCase() === k.toLowerCase())
  if (idx('id') < 0 || idx('name') < 0 || idx('duration') < 0) throw new Error('CSV must include id, name and duration columns')
  const num = (v, d) => (v === undefined || v === '' || isNaN(+v) ? d : +v)
  return lines.slice(1).map((l) => {
    const c = parseLine(l); const g = (k) => (idx(k) >= 0 ? c[idx(k)] : undefined)
    return {
      id: g('id'), name: g('name'), phase: g('phase') || 'Execution', owner: g('owner') || '',
      duration: num(g('duration'), 5), deps: (g('deps') || '').split(/[;| ]+/).filter(Boolean),
      complexity: num(g('complexity'), 3), teamSize: num(g('teamSize'), 2), experience: num(g('experience'), 3),
      utilization: num(g('utilization'), 90), reqChanges: num(g('reqChanges'), 0),
      vendor: /^(1|true|yes|y)$/i.test(g('vendor') || ''), budget: num(g('budget'), 0),
      progress: num(g('progress'), 0), actualCost: num(g('actualCost'), 0),
    }
  })
}

export function toCSV(tasks) {
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)
  return [COLUMNS.join(','), ...tasks.map((t) => COLUMNS.map((k) => esc(k === 'deps' ? (t.deps || []).join(';') : k === 'vendor' ? (t.vendor ? 1 : 0) : t[k])).join(','))].join('\n')
}

export function download(name, text, type = 'text/csv') {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

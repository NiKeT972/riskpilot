// Vercel serverless function: LLM agent for RiskPilot (Groq, OpenAI-compatible API)
// Modes: "plan"   -> turn a project description into a structured task plan (JSON)
//        "chat"   -> answer a PM question grounded in the live project analytics
//        "report" -> write a weekly status report for stakeholders
// Set GROQ_API_KEY (and optionally GROQ_MODEL) in Vercel -> Settings -> Environment Variables.

const MODELS = [process.env.GROQ_MODEL, 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'].filter(Boolean)

const PLAN_SYSTEM = `You are an expert project manager (PMP). Convert the user's project description into a realistic work breakdown.
Return ONLY JSON: {"name": string, "tasks": [ {"id": "T01", "name": string, "phase": one of ["Initiation","Planning","Execution","Monitoring","Closure"],
"owner": role string, "duration": working days (integer 1-40), "deps": [ids of predecessor tasks],
"complexity": 1-5, "teamSize": 1-8, "experience": avg years 0.5-12, "utilization": planned % 50-130,
"vendor": boolean (depends on an external vendor), "budget": cost in INR (integer) } ] }
Use 10-20 tasks, ids T01.., a valid dependency network (no cycles, deps only on earlier ids), Indian rupee budgets proportional to effort.`

const CHAT_SYSTEM = `You are RiskPilot, an AI project-management copilot. You are given live analytics for one project:
ML delay probabilities per task, critical path, earned value metrics and a Monte Carlo forecast.
Answer like a senior PM: specific, quantified, cite task IDs, recommend concrete actions (crashing, fast-tracking,
resource levelling, change control, vendor SLAs). Be concise (under 180 words) and use short bullet points when listing.
Never invent numbers that are not in the context.`

const REPORT_SYSTEM = `You are RiskPilot, an AI project-management copilot. Write a weekly project status report for
executive stakeholders from the analytics provided. Sections: Overall status (RAG with one-line reason), Schedule,
Cost (EVM), Top risks and mitigations (max 4, with task IDs and owners), Decisions needed. Use markdown headings and bullets,
under 300 words. Only use numbers present in the context.`

async function callGroq(messages, json) {
  const key = process.env.GROQ_API_KEY
  let lastErr
  for (const model of MODELS) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, messages, temperature: 0.3, max_tokens: 2500,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
    })
    if (r.ok) {
      const data = await r.json()
      return { text: data.choices?.[0]?.message?.content ?? '', model }
    }
    lastErr = `${r.status} ${await r.text()}`
    if (r.status === 401) break
  }
  throw new Error(lastErr || 'LLM call failed')
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ llm: Boolean(process.env.GROQ_API_KEY), provider: 'groq' })
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (!process.env.GROQ_API_KEY) return res.status(503).json({ error: 'no_key' })

  try {
    const { mode, description, question, context, history = [] } = req.body || {}
    if (mode === 'plan') {
      if (!description || description.length > 4000) return res.status(400).json({ error: 'bad description' })
      const { text, model } = await callGroq([
        { role: 'system', content: PLAN_SYSTEM },
        { role: 'user', content: description },
      ], true)
      return res.status(200).json({ plan: JSON.parse(text), model })
    }
    const ctx = JSON.stringify(context || {}).slice(0, 14000)
    if (mode === 'report') {
      const { text, model } = await callGroq([
        { role: 'system', content: REPORT_SYSTEM },
        { role: 'user', content: `Project analytics:\n${ctx}` },
      ])
      return res.status(200).json({ answer: text, model })
    }
    if (mode === 'chat') {
      if (!question || question.length > 2000) return res.status(400).json({ error: 'bad question' })
      const msgs = [{ role: 'system', content: `${CHAT_SYSTEM}\n\nProject analytics:\n${ctx}` },
        ...history.slice(-6).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content).slice(0, 2000) })),
        { role: 'user', content: question }]
      const { text, model } = await callGroq(msgs)
      return res.status(200).json({ answer: text, model })
    }
    return res.status(400).json({ error: 'unknown mode' })
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e).slice(0, 300) })
  }
}

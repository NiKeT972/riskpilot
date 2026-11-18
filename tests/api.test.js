import { describe, it, expect, vi, afterEach } from 'vitest'
import handler from '../api/agent.js'

const call = async (method, body) => {
  let status = 0, json = null
  const res = { status(s) { status = s; return this }, json(j) { json = j; return this } }
  await handler({ method, body }, res)
  return { status, json }
}

afterEach(() => { vi.unstubAllGlobals(); delete process.env.GROQ_API_KEY })

describe('/api/agent', () => {
  it('reports when no key is configured and refuses work', async () => {
    expect((await call('GET')).json).toEqual({ llm: false, provider: 'groq' })
    expect((await call('POST', { mode: 'chat', question: 'hi' })).status).toBe(503)
  })
  it('sanitises the LLM plan and does not try the retired model', async () => {
    process.env.GROQ_API_KEY = 'test'
    const models = []
    vi.stubGlobal('fetch', async (_url, opts) => {
      models.push(JSON.parse(opts.body).model)
      const plan = { name: 'X', tasks: [{ id: 'T01', deps: ['T02'], duration: 99 }, { id: 'T02', deps: ['T01'] }] }
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(plan) } }] }) }
    })
    const r = await call('POST', { mode: 'plan', description: 'an app' })
    expect(r.status).toBe(200)
    expect(models).toEqual(['openai/gpt-oss-120b'])
    expect(r.json.plan.tasks[0].duration).toBe(40)
    expect(r.json.plan.warnings.some((w) => w.includes('cycle'))).toBe(true)
  })
  it('turns invalid JSON from the model into a clean 502', async () => {
    process.env.GROQ_API_KEY = 'test'
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not json' } }] }) }))
    const r = await call('POST', { mode: 'plan', description: 'an app' })
    expect(r.status).toBe(502)
  })
  it('validates input sizes', async () => {
    process.env.GROQ_API_KEY = 'test'
    expect((await call('POST', { mode: 'plan', description: 'x'.repeat(5000) })).status).toBe(400)
    expect((await call('POST', { mode: 'nope' })).status).toBe(400)
  })
})

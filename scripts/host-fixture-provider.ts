// Deterministic loopback model fixture: validates host dispatch, not language understanding.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const root = process.env.GHC_HOST_FIXTURE_ROOT
if (!root) throw new Error('GHC_HOST_FIXTURE_ROOT is required')
const text = (value: any): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(b => b.text ?? text(b.content)).join('\n') : ''
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 10 })
    if (req.method !== 'POST') return Response.json({})
    const body = await req.json() as any
    const plan = JSON.parse(readFileSync(`${root}/plan.json`, 'utf8'))
    const results = (body.messages ?? []).flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'tool_result') : [])
    const pending = plan.steps.findIndex((_: any, i: number) => !results.some((r: any) => r.tool_use_id === `toolu_${plan.stage}_${i}`))
    const step = pending < 0 ? undefined : plan.steps[pending]
    let input = step?.arguments ?? {}
    const allResults = results.map((r: any) => text(r.content)).join('\n')
    const watch = [...allResults.matchAll(/"watch_id"\s*:\s*"(watch_[^"]+)"/g)].at(-1)?.[1]
    if (watch) input = JSON.parse(JSON.stringify(input).replaceAll('$WATCH', watch))
    let name = step && (body.tools ?? []).find((t: any) => t.name === step.tool || t.name.endsWith(`__${step.tool}`))?.name
    let toolId = `toolu_${plan.stage}_${pending}`
    if (step && !name && !results.some((r: any) => r.tool_use_id === `toolu_${plan.stage}_search_${pending}`)) {
      name = (body.tools ?? []).find((t: any) => t.name === 'ToolSearch')?.name
      if (name) { input = { query: `github ${step.tool}`, max_results: 5 }; toolId = `toolu_${plan.stage}_search_${pending}` }
    }
    const failed = step && !name
    const block = step && name
      ? { type: 'tool_use', id: toolId, name, input }
      : { type: 'text', text: `${failed ? 'HOST_MISSING_TOOL' : `HOST_${plan.stage}_DONE`}` }
    appendFileSync(`${root}/provider.jsonl`, JSON.stringify({ stage: plan.stage, stream: body.stream, tool: name, available_tools: (body.tools ?? []).map((t: any) => t.name), input, result_count: results.length, result_errors: results.filter((r: any) => r.is_error).map((r: any) => text(r.content)), results: results.map((r: any) => ({ id: r.tool_use_id, text: text(r.content) })) }) + '\n')
    const message = { id: `msg_${plan.stage}_${pending}`, type: 'message', role: 'assistant', model: body.model, content: [block], stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }
    if (!body.stream) return Response.json(message)
    const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
    return new Response([
      event('message_start', { message: { ...message, content: [], stop_reason: null } }),
      event('content_block_start', { index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } }),
      event('content_block_delta', { index: 0, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(input) } : { type: 'text_delta', text: block.text } }),
      event('content_block_stop', { index: 0 }),
      event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } }),
      event('message_stop', {}),
    ].join(''), { headers: { 'content-type': 'text/event-stream' } })
  },
})
writeFileSync(`${root}/provider.json`, JSON.stringify({ url: `http://127.0.0.1:${server.port}`, pid: process.pid }))
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { server.stop(true); process.exit(0) })

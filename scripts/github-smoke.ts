#!/usr/bin/env bun
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, lstat, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const REPO = 'Esonhugh/github-claude-channel'
const PROXY = 'http://127.0.0.1:7890'
const ROOT = resolve(import.meta.dir, '..')
const POLL_MS = 30_000
const HELP = `Real GitHub / MCP smoke test (no model calls).

bun scripts/github-smoke.ts --allow-writes [--issue NUMBER] [--pr NUMBER]
  [--run RUN_ID ...] [--workflow FILE_OR_ID --ref BRANCH]
  [--case-timeout-seconds 240] [--total-timeout-seconds 1200]

Repository is fixed to ${REPO}; all gh calls explicitly use ${PROXY}.
--allow-writes is required: creates/edits fixture comments, closes/reopens the
selected issue/PR, and creates a marked issue when --issue is omitted.
The workflow option dispatches success + failure runs with inputs outcome and
marker (required workflow contract: docs/github-validation.md).
Missing PR/run/workflow inputs are reported as not covered, never passed.
This verifies SDK channel notifications and the CLI stream, NOT a host Monitor
task, slash-skill dispatch, or Claude binary/tmux integration.
`

type Verdict = 'passed' | 'failed' | 'not covered'
type Result = { id: string; verdict: Verdict; reason: string; details?: unknown }
type JSONValue = Record<string, any>
type Delivery = { subscription_id: string; seq: number; watch_id: string }
type EventRow = { seq: number; event: JSONValue }
type Peer = {
  client: Client
  transport: StdioClientTransport
  notifications: JSONValue[]
  call: (name: string, args?: JSONValue) => Promise<JSONValue>
}

function options(argv: string[]) {
  const result = { issue: undefined as number | undefined, pr: undefined as number | undefined,
    runs: [] as string[], workflow: undefined as string | undefined, ref: undefined as string | undefined,
    caseMs: 240_000, totalMs: 1_200_000, writes: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!
    if (flag === '--allow-writes') { result.writes = true; continue }
    if (!['--issue', '--pr', '--run', '--workflow', '--ref', '--case-timeout-seconds', '--total-timeout-seconds'].includes(flag)) throw new Error('Unknown option: ' + flag)
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new Error('Missing value: ' + flag)
    if (flag === '--issue' || flag === '--pr' || flag === '--run') {
      if (!/^[1-9][0-9]*$/.test(value)) throw new Error('Expected positive decimal ID: ' + flag)
      if (flag === '--run') result.runs.push(value)
      else {
        const n = Number(value)
        if (!Number.isSafeInteger(n)) throw new Error('Unsafe issue/PR number')
        result[flag === '--issue' ? 'issue' : 'pr'] = n
      }
    } else if (flag === '--workflow') result.workflow = value
    else if (flag === '--ref') result.ref = value
    else {
      const seconds = Number(value)
      if (!Number.isInteger(seconds) || seconds < 90 || seconds > 3600) throw new Error('Timeout must be 90..3600 seconds')
      if (flag === '--case-timeout-seconds') result.caseMs = seconds * 1000
      else result.totalMs = seconds * 1000
    }
  }
  if (!result.writes) throw new Error('--allow-writes is required; see --help for the exact remote effects')
  if (Boolean(result.workflow) !== Boolean(result.ref)) throw new Error('--workflow and --ref must be provided together')
  return result
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
function safe(text: string) {
  return text.replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[REDACTED]')
    .replace(/(authorization\s*[:=]\s*)([^\r\n]+)/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[REDACTED]@')
}
function payloadSummary(value: any): unknown {
  if (Array.isArray(value)) return { count: value.length, items: value.slice(0, 5).map(payloadSummary) }
  if (!value || typeof value !== 'object') return value
  const out: JSONValue = {}
  for (const key of ['id', 'number', 'state', 'status', 'conclusion', 'run_attempt', 'event', 'type', 'html_url', 'path', 'line', 'side', 'total_count']) {
    if (value[key] !== undefined) out[key] = value[key]
  }
  if (typeof value.body === 'string') out.body = { bytes: Buffer.byteLength(value.body), sha256: digest(value.body) }
  if (value.workflow_runs) out.workflow_runs = payloadSummary(value.workflow_runs)
  if (value.jobs) out.jobs = payloadSummary(value.jobs)
  if (value.steps) out.steps = payloadSummary(value.steps)
  return out
}
class GitHubFailure extends Error {
  constructor(public status: number, public apiMessage: string) { super(`GitHub HTTP ${status}: ${safe(apiMessage)}`) }
}

async function main() {
  const config = options(process.argv.slice(2))
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid
  const marker = 'github-channel-smoke-' + stamp
  const evidence = join(ROOT, 'docs/evidence', 'github-' + stamp)
  const privateRoot = await mkdtemp(join(tmpdir(), 'ghc-github-smoke-'))
  await mkdir(evidence, { recursive: true })
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  // Never inherit a fixture executable, consumer, delivery assertion, or test-fast polling.
  for (const key of Object.keys(env)) if (key.startsWith('GHC_') || key === 'GH_DEBUG' || key === 'DEBUG') delete env[key]
  Object.assign(env, { HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY, https_proxy: PROXY, http_proxy: PROXY,
    NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1', GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat',
    GHC_STATE_DIR: join(privateRoot, 'state'), GHC_GH: 'gh', GHC_ALLOWED_HOSTS: 'github.com',
    GHC_POLL_MS: String(POLL_MS), GHC_GH_INTERVAL_MS: '1000', GHC_IDLE_MS: '300000' })
  const entry = join(ROOT, 'src/cli.ts')
  const deadline = Date.now() + config.totalMs
  const results = new Map<string, Result>()
  const apiEvidence: JSONValue[] = [], eventEvidence: JSONValue[] = [], stderrEvidence: JSONValue[] = []
  const nodeStderr: { label: string; hash: ReturnType<typeof createHash>; bytes: number }[] = []
  const resources: JSONValue = { temporary_root: privateRoot, evidence, started_pids: [], socket: null, remaining_pids: [] }
  const peers: Peer[] = [], children: Bun.Subprocess[] = []
  const drains: Promise<unknown>[] = []
  const track = (promise: Promise<unknown>) => { drains.push(promise); void promise.catch(() => {}) }
  const watches: { peer: Peer; id: string }[] = []
  let daemon: Bun.Subprocess | undefined, socket: string | undefined, socketIdentity: Awaited<ReturnType<typeof lstat>> | undefined
  let issue = config.issue, originalIssueState: string | undefined, originalPRState: string | undefined, createdIssue = false
  let cleanupPhase = false
  let interrupted = false
  const interrupt = () => { interrupted = true }
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  const mark = (id: string, verdict: Verdict, reason: string, details?: unknown) => {
    results.set(id, { id, verdict, reason, details })
    console.log(`${verdict}: ${id} — ${safe(reason)}`)
  }
  for (const id of ['setup', 'repository.opened', 'issue.comment.channels', 'session.ack-isolation', 'issue.comment.edited', 'issue.closed', 'issue.reopened',
    'unsubscribe.isolation', 'monitor.cli-fallback', 'pr.comment', 'pr.review', 'pr.inline', 'pr.closed', 'pr.reopened', 'actions.supplied-runs', 'actions.dispatch.success', 'actions.dispatch.failure']) {
    results.set(id, { id, verdict: 'not covered', reason: 'Not reached or optional fixture not supplied' })
  }
  mark('host.binary-channels-monitor-skills', 'not covered', 'SDK notification receiver / CLI stream are not Claude host binary, Monitor TaskStop, or skill-dispatch evidence')
  mark('pr.opened-merged', 'not covered', 'This script neither creates nor merges PRs; supplied fixture PR is prepared by the coordinator')
  function remaining(ms = 30_000) {
    const left = deadline - Date.now()
    if (!cleanupPhase && interrupted) throw new Error('Smoke interrupted; entering cleanup')
    if (!cleanupPhase && left <= 0) throw new Error('Overall smoke deadline exceeded')
    return cleanupPhase ? ms : Math.max(1, Math.min(ms, left))
  }
  async function localUntil<T>(read: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const value = await read()
      if (value !== undefined) return value
      await Bun.sleep(100)
    }
    throw new Error('Local process readiness/cleanup deadline exceeded')
  }
  async function waitFor<T>(label: string, read: () => Promise<T | undefined>): Promise<T> {
    const end = Math.min(deadline, Date.now() + config.caseMs)
    while (Date.now() < end) {
      remaining()
      const value = await read()
      if (value !== undefined) return value
      if (Date.now() + POLL_MS >= end) break
      await Bun.sleep(POLL_MS)
    }
    throw new Error('Timed out waiting for ' + label)
  }
  async function check<T>(id: string, action: () => Promise<T>): Promise<T> {
    try { const value = await action(); mark(id, 'passed', 'Required assertions observed'); return value }
    catch (error) { mark(id, 'failed', error instanceof Error ? error.message : 'Unknown failure'); throw error }
  }
  async function api(method: 'GET' | 'POST' | 'PATCH', endpoint: string, input?: JSONValue): Promise<any> {
    assert(endpoint.startsWith(`repos/${REPO}/`), 'Refusing API endpoint outside the fixed repository')
    const args = ['api', '--hostname', 'github.com', '--method', method, '--include', endpoint, ...(input ? ['--input', '-'] : [])]
    const timeout = remaining()
    const p = Bun.spawn(['gh', ...args], { env, stdin: input ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'pipe' })
    children.push(p); resources.started_pids.push(p.pid)
    if (input) { (p.stdin as Bun.FileSink).write(JSON.stringify(input)); (p.stdin as Bun.FileSink).end() }
    let timedOut = false
    let forceKill: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      timedOut = true; p.kill()
      forceKill = setTimeout(() => { if (p.exitCode === null) p.kill('SIGKILL') }, 2000)
    }, timeout)
    try {
      const [out, err, code] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text(), p.exited])
      const split = out.search(/\r?\n\r?\n/), headers = split >= 0 ? out.slice(0, split) : ''
      const body = split >= 0 ? out.slice(split).trim() : out.trim()
      const status = Number(/^HTTP\/\S+\s+(\d+)/.exec(headers)?.[1] ?? 0)
      let parsed: any = null
      if (body) { try { parsed = JSON.parse(body) } catch { /* Recorded below; unsuccessful JSON is not a test pass. */ } }
      apiEvidence.push({ at: new Date().toISOString(), argv: ['gh', ...args], input: input ?? null, exit_code: code, status,
        stdout_bytes: Buffer.byteLength(out), stdout_sha256: digest(out), output_summary: payloadSummary(parsed),
        stderr_bytes: Buffer.byteLength(err), stderr_sha256: digest(err), timed_out: timedOut })
      if (timedOut) throw new Error('gh request timed out: ' + method + ' ' + endpoint)
      if (code !== 0 || status >= 400) throw new GitHubFailure(status, String(parsed?.message ?? 'gh request failed; inspect recorded status/digests'))
      assert(status >= 200 && status < 300, 'Unexpected gh HTTP status: ' + status)
      assert(status === 204 || parsed !== null, 'Expected GitHub JSON response')
      return parsed
    } finally { clearTimeout(timer); clearTimeout(forceKill); if (p.exitCode === null) { p.kill('SIGKILL'); await p.exited } }
  }
  async function peer(label: string): Promise<Peer> {
    const client = new Client({ name: 'github-smoke-' + label, version: '1.0.0' })
    const notifications: JSONValue[] = []
    client.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }) }), value => {
      notifications.push({ meta: value.params.meta, content_sha256: digest(value.params.content), received_at: new Date().toISOString() })
    })
    const transport = new StdioClientTransport({ command: process.execPath, args: [entry, 'stdio'], env: { ...env, GHC_CONSUMER_FILE: join(privateRoot, label + '.json') }, stderr: 'pipe' })
    const instance: Peer = { client, transport, notifications, call: async (name, args = {}) => {
      const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: remaining(180_000) })
      const text = Array.isArray(reply.content) ? reply.content.find(block => block.type === 'text') : undefined
      if (reply.isError) throw new Error(`MCP ${name}: ${text?.type === 'text' ? safe(text.text) : 'Tool error'}`)
      if (reply.structuredContent) return reply.structuredContent as JSONValue
      assert(text?.type === 'text', 'Missing MCP JSON response for ' + name)
      return JSON.parse(text.text)
    } }
    peers.push(instance)
    const capture = { label: 'adapter-' + label, hash: createHash('sha256'), bytes: 0 }
    nodeStderr.push(capture)
    transport.stderr?.on('data', (bytes: Buffer) => { capture.bytes += bytes.length; capture.hash.update(bytes) })
    try { await client.connect(transport, { timeout: remaining(30_000) }) }
    finally { if (transport.pid) resources.started_pids.push(transport.pid) }
    const listed = await client.listTools()
    for (const name of ['subscribe', 'subscriptions', 'unsubscribe', 'events', 'ack', 'delivery', 'snapshot']) assert(listed.tools.some(tool => tool.name === name), 'Missing tool: ' + name)
    return instance
  }
  async function subscribe(p: Peer, targets: JSONValue[]) {
    const value = await p.call('subscribe', { targets, initial: 'snapshot', delivery: { mode: 'auto', detail: 'steps' } })
    assert(typeof value.watch_id === 'string' && Array.isArray(value.subscriptions), 'Invalid durable watch response')
    watches.push({ peer: p, id: value.watch_id })
    return value
  }
  async function allEvents(p: Peer, sub: string): Promise<EventRow[]> {
    const rows: EventRow[] = []; let cursor = 0
    for (let page = 0; page < 100; page++) {
      const found = await p.call('events', { subscription_id: sub, after_seq: cursor, limit: 100 })
      assert(!found.gap, 'Unexpected retention gap in fresh smoke consumer')
      rows.push(...found.events)
      if (found.events.length < 100) return rows
      assert(found.next_seq > cursor, 'Events pagination did not advance'); cursor = found.next_seq
    }
    throw new Error('Smoke events pagination exceeded 100 pages')
  }
  async function findEvent(p: Peer, sub: string, type: string, match: (e: JSONValue) => boolean = () => true): Promise<EventRow> {
    return waitFor(type, async () => {
      const row = (await allEvents(p, sub)).find(row => row.event.type === type && match(row.event))
      if (row) eventEvidence.push({ subscription_id: sub, seq: row.seq, event_id: row.event.event_id, type, source_id: row.event.source_id,
        observed_at: row.event.observed_at, occurred_at: row.event.occurred_at, evidence: row.event.evidence, data: payloadSummary(row.event.data) })
      return row
    })
  }
  async function notified(p: Peer, id: string) { return waitFor('channel notification ' + id, async () => p.notifications.find(n => n.meta?.event_id === id)) }
  const issueTarget = (n: number) => ({ kind: 'issue', host: 'github.com', repo: REPO, number: n, events: ['lifecycle', 'comments'] })
  const issueComment = (n: number, text: string) => api('POST', `repos/${REPO}/issues/${n}/comments`, { body: `[${marker}] ${text}` })
  try {
    await check('setup', async () => {
      assert(Bun.which('gh'), 'gh CLI not installed')
      daemon = Bun.spawn([process.execPath, entry, 'daemon'], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
      children.push(daemon); resources.started_pids.push(daemon.pid)
      track(new Response(daemon.stdout as ReadableStream).text().then(text => stderrEvidence.push({ label: 'daemon-stdout', bytes: Buffer.byteLength(text), sha256: digest(text) })))
      track(new Response(daemon.stderr as ReadableStream).text().then(text => stderrEvidence.push({ label: 'daemon-stderr', bytes: Buffer.byteLength(text), sha256: digest(text) })))
      socket = await localUntil(async () => {
        assert(daemon!.exitCode === null, 'Daemon exited before readiness')
        try {
          const dirs = await readdir(env.GHC_STATE_DIR!)
          const value = JSON.parse(await readFile(join(env.GHC_STATE_DIR!, dirs[0]!, 'daemon.json'), 'utf8'))
          assert(value.pid === daemon!.pid, 'Unexpected daemon owner'); return value.socket as string
        } catch { return undefined }
      })
      socketIdentity = await lstat(socket)
      resources.socket = socket
      const health = await fetch('http://localhost/health', { unix: socket, method: 'POST', body: '{}' }).then(r => r.json()) as JSONValue
      assert(health.pid === daemon.pid, 'Health did not identify this daemon')
      await peer('a'); await peer('b')
      const again = await fetch('http://localhost/health', { unix: socket, method: 'POST', body: '{}' }).then(r => r.json()) as JSONValue
      assert(again.pid === daemon.pid, 'Two clients did not share the isolated daemon')
    })
    const [a, b] = peers as [Peer, Peer]
    await a.call('delivery', { channels: 'enabled', monitor: 'unavailable', evidence: 'SDK smoke receiver explicitly registers notifications/claude/channel; not a Claude host enablement assertion' })
    const repoWatch = await subscribe(a, [{ kind: 'repository', repo: REPO, objects: ['issue', 'pr'], events: ['lifecycle'] }])
    if (!issue) {
      const fixture = await api('POST', `repos/${REPO}/issues`, { title: `[channel smoke] ${marker}`, body: `Automated fixture for ${REPO}. Marker: ${marker}. This issue will be closed, not deleted.` })
      issue = fixture.number; createdIssue = true
      assert(Number.isSafeInteger(issue), 'GitHub did not return an issue number')
    } else {
      const existing = await api('GET', `repos/${REPO}/issues/${issue}`)
      assert(!existing.pull_request, '--issue identifies a PR, not an issue')
      originalIssueState = existing.state
      if (existing.state !== 'open') await api('PATCH', `repos/${REPO}/issues/${issue}`, { state: 'open' })
    }
    resources.issue_number = issue; resources.created_issue = createdIssue
    const issueA = await subscribe(a, [issueTarget(issue!)]), issueB = await subscribe(b, [issueTarget(issue!)])
    const subA = issueA.subscriptions[0].subscription_id as string, subB = issueB.subscriptions[0].subscription_id as string
    assert(issueA.watch_id !== issueB.watch_id, 'Independent sessions reused watch identity')
    const retry = await a.call('subscribe', { targets: [issueTarget(issue!)], initial: 'snapshot', delivery: { mode: 'auto', detail: 'steps' } })
    assert(retry.watch_id === issueA.watch_id, 'Subscribe retry was not idempotent')
    let blocked = false
    try { await a.call('events', { subscription_id: subB }) } catch (error) { blocked = String(error).includes('subscription_not_found') }
    assert(blocked, 'Cross-consumer event read was not rejected')
    if (createdIssue) await check('repository.opened', async () => { await findEvent(a, repoWatch.subscriptions[0].subscription_id, 'issue.opened', e => e.data.number === issue) })
    else mark('repository.opened', 'not covered', 'Supplied issue existed before repository subscription; no new object manufactured')
    const comment = await issueComment(issue!, 'comment creation')
    const first = await check('issue.comment.channels', async () => {
      const row = await findEvent(a, subA, 'issue.comment.created', e => e.data.id === comment.id)
      await notified(a, row.event.event_id)
      const other = await findEvent(b, subB, 'issue.comment.created', e => e.data.id === comment.id)
      assert(other.event.event_id === row.event.event_id, 'Shared source event IDs differ')
      assert(b.notifications.length === 0, 'Unknown-delivery consumer unexpectedly received channel push')
      return row
    })
    await check('session.ack-isolation', async () => {
      await a.call('ack', { subscription_id: subA, through_seq: first.seq })
      const state = await b.call('subscriptions')
      const other = state.watches.find((w: JSONValue) => w.watch_id === issueB.watch_id)
      assert(other.subscriptions[0].acked_seq === 0, 'A acknowledgement advanced B cursor')
    })
    await check('issue.comment.edited', async () => {
      const editedBody = `[${marker}] comment edited`
      await api('PATCH', `repos/${REPO}/issues/comments/${comment.id}`, { body: editedBody })
      await findEvent(a, subA, 'issue.comment.edited', e => e.data.id === comment.id && e.data.body === editedBody)
    })
    await check('issue.closed', async () => {
      await api('PATCH', `repos/${REPO}/issues/${issue}`, { state: 'closed', state_reason: 'completed' })
      await findEvent(a, subA, 'issue.closed')
    })
    await check('issue.reopened', async () => {
      await api('PATCH', `repos/${REPO}/issues/${issue}`, { state: 'open' })
      await findEvent(a, subA, 'issue.reopened')
    })
    await check('unsubscribe.isolation', async () => {
      assert((await a.call('unsubscribe', { watch_id: issueA.watch_id })).state === 'unsubscribed', 'Unsubscribe did not succeed')
      assert((await a.call('unsubscribe', { watch_id: issueA.watch_id })).state === 'already_absent', 'Repeated unsubscribe was not idempotent')
      const comment2 = await issueComment(issue!, 'B survives A unsubscribe')
      const row = await findEvent(b, subB, 'issue.comment.created', e => e.data.id === comment2.id)
      assert(!(await a.call('subscriptions')).watches.some((w: JSONValue) => w.watch_id === issueA.watch_id), 'Cancelled watch still listed')
      assert(!a.notifications.some(n => n.meta?.event_id === row.event.event_id), 'Cancelled issue watch still delivered a new comment')
    })
    await check('monitor.cli-fallback', async () => {
      const rows = await allEvents(b, subB)
      if (rows.length) await b.call('ack', { subscription_id: subB, through_seq: rows.at(-1)!.seq })
      await b.call('delivery', { channels: 'enabled', monitor: 'available', evidence: 'SDK receiver was explicitly installed; transition test only, not host capability detection' })
      const delivery = await b.call('delivery', { channels: 'unavailable', monitor: 'available', evidence: 'Test harness explicitly disables SDK channel route and supplies CLI stdout receiver; not a host Monitor task' })
      const argv = delivery.consumer_bridge?.stream_argv as string[]
      assert(Array.isArray(argv) && argv[0] === process.execPath && argv[1] === entry, 'Unexpected bridge executable')
      const durationIndex = argv.indexOf('--duration-ms')
      assert(durationIndex >= 0, 'Missing bounded stream duration'); argv[durationIndex + 1] = '60000'
      const stream = Bun.spawn(argv, { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
      children.push(stream); resources.started_pids.push(stream.pid)
      const streamRows: JSONValue[] = []
      const reader = (async () => {
        let pending = ''; const decoder = new TextDecoder()
        for await (const bytes of stream.stdout as ReadableStream<Uint8Array>) {
          pending += decoder.decode(bytes, { stream: true })
          const lines = pending.split('\n'); pending = lines.pop()!
          for (const line of lines) if (line.trim()) streamRows.push(JSON.parse(line))
        }
        pending += decoder.decode()
        assert(!pending.trim(), 'Truncated Monitor JSON line')
      })()
      track(reader)
      track(new Response(stream.stderr as ReadableStream).text().then(text => stderrEvidence.push({ label: 'monitor-cli', bytes: Buffer.byteLength(text), sha256: digest(text) })))
      await localUntil(async () => (await b.call('subscriptions')).watches[0]?.delivery.status === 'attached' ? true : undefined)
      const newComment = await issueComment(issue!, 'Monitor fallback event')
      const row = await findEvent(b, subB, 'issue.comment.created', e => e.data.id === newComment.id)
      await waitFor('Monitor stdout event', async () => streamRows.find(r => r.event?.event_id === row.event.event_id))
      assert(!b.notifications.some(n => n.meta?.event_id === row.event.event_id), 'Monitor event was double-delivered via Channels')
      let expiryTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([stream.exited, new Promise<never>((_, reject) => {
          expiryTimer = setTimeout(() => reject(new Error('Monitor did not exit at its deadline')), remaining(75_000))
        })])
      } finally { clearTimeout(expiryTimer) }
      await reader
      assert(stream.exitCode === 0, 'Monitor CLI failed')
      const state = await b.call('subscriptions'), watch = state.watches.find((w: JSONValue) => w.watch_id === issueB.watch_id)
      assert(watch && watch.delivery.status === 'detached', 'Monitor expiry removed watch or failed to detach')
      eventEvidence.push({ stream_events: streamRows.map(r => ({ event: r.event, deliveries: r.deliveries, summary_sha256: digest(r.summary ?? '') })) })
    })
    if (config.pr) {
      const pr = await api('GET', `repos/${REPO}/pulls/${config.pr}`)
      assert(!pr.merged, 'Supplied PR is already merged; use an open disposable fixture PR')
      originalPRState = pr.state
      if (pr.state !== 'open') await api('PATCH', `repos/${REPO}/pulls/${config.pr}`, { state: 'open' })
      const watch = await subscribe(a, [{ kind: 'pr', repo: REPO, number: config.pr, events: ['lifecycle', 'comments', 'reviews', 'review_comments'] }])
      const sub = watch.subscriptions[0].subscription_id as string
      await check('pr.comment', async () => {
        const comment = await issueComment(config.pr!, 'PR conversation comment')
        const row = await findEvent(a, sub, 'pr.comment.created', e => e.data.id === comment.id); await notified(a, row.event.event_id)
      })
      try {
        const review = await api('POST', `repos/${REPO}/pulls/${config.pr}/reviews`, { event: 'COMMENT', body: `[${marker}] Review fixture; no approval or change request.` })
        await check('pr.review', async () => { await findEvent(a, sub, 'pr.review.submitted', e => e.data.id === review.id) })
      } catch (error) {
        if (error instanceof GitHubFailure && (error.status === 403 || (error.status === 422 && /own pull request|self|author/i.test(error.apiMessage)))) mark('pr.review', 'not covered', 'GitHub denied review for this test identity: ' + error.message)
        else { mark('pr.review', 'failed', String(error)); throw error }
      }
      const files = await api('GET', `repos/${REPO}/pulls/${config.pr}/files?per_page=100`)
      let location: { path: string; line: number } | undefined
      for (const file of files) {
        if (file.status === 'removed' || typeof file.patch !== 'string') continue
        let right = 0
        for (const line of file.patch.split('\n')) {
          const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
          if (hunk) { right = Number(hunk[1]); continue }
          if (!right || line.startsWith('\\')) continue
          if (line.startsWith('+')) { location = { path: file.filename, line: right }; break }
          if (!line.startsWith('-')) right++
        }
        if (location) break
      }
      if (!location) mark('pr.inline', 'not covered', 'No added line in first 100 PR files with a textual patch; supply a small commentable fixture')
      else await check('pr.inline', async () => {
        const comment = await api('POST', `repos/${REPO}/pulls/${config.pr}/comments`, { body: `[${marker}] Inline fixture`, commit_id: pr.head.sha, path: location!.path, line: location!.line, side: 'RIGHT' })
        await findEvent(a, sub, 'pr.review_comment.created', e => e.data.id === comment.id && e.data.path === location!.path)
      })
      await check('pr.closed', async () => { await api('PATCH', `repos/${REPO}/pulls/${config.pr}`, { state: 'closed' }); await findEvent(a, sub, 'pr.closed') })
      await check('pr.reopened', async () => { await api('PATCH', `repos/${REPO}/pulls/${config.pr}`, { state: 'open' }); await findEvent(a, sub, 'pr.reopened') })
    }
    async function observeRun(id: string, expected?: string) {
      const watch = await subscribe(a, [{ kind: 'run', repo: REPO, run_id: id, attempt: 'latest', events: ['run', 'job', 'step'] }])
      const sub = watch.subscriptions[0].subscription_id as string
      const snapshot = await a.call('snapshot', { subscription_id: sub })
      const runRecord = Object.entries(snapshot.snapshot.records as JSONValue).find(([key]) => key.startsWith('run:') && !key.includes('/'))?.[1]
      assert(runRecord, 'Run snapshot is empty')
      if (runRecord.status === 'completed') {
        if (expected) assert(runRecord.conclusion === expected, 'Workflow conclusion mismatch: ' + runRecord.conclusion)
        mark('actions.snapshot.' + id, 'passed', 'Real completed run snapshot observed; not proof of a change notification', payloadSummary(runRecord))
        mark('actions.changes.' + id, 'not covered', 'Run completed before baseline; provide a slower active fixture run')
        return false
      }
      const done = await findEvent(a, sub, 'actions.run.completed', e => String(e.data.id) === id)
      if (expected) assert(done.event.data.conclusion === expected, 'Workflow conclusion mismatch: ' + done.event.data.conclusion)
      await notified(a, done.event.event_id)
      await findEvent(a, sub, 'actions.job.changed', e => e.data.status === 'completed')
      await findEvent(a, sub, 'actions.step.changed', e => e.data.status === 'completed')
      mark('actions.changes.' + id, 'passed', 'Observed real run completion, terminal job/step changes, and SDK channel notification')
      return true
    }
    if (config.runs.length) await check('actions.supplied-runs', async () => {
      let changed = 0
      for (const id of config.runs) if (await observeRun(id)) changed++
      return changed
    }).then(changed => { if (!changed) mark('actions.supplied-runs', 'not covered', 'Only already-completed supplied run snapshots were available') })
    if (config.workflow) {
      const workflow = encodeURIComponent(config.workflow)
      await api('GET', `repos/${REPO}/actions/workflows/${workflow}`)
      for (const outcome of ['success', 'failure']) {
        const id = 'actions.dispatch.' + outcome
        await check(id, async () => {
          const dispatchMarker = marker + '-' + outcome
          await api('POST', `repos/${REPO}/actions/workflows/${workflow}/dispatches`, { ref: config.ref, inputs: { outcome, marker: dispatchMarker } })
          const run = await waitFor('dispatched workflow run ' + outcome, async () => {
            const list = await api('GET', `repos/${REPO}/actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=${encodeURIComponent(config.ref!)}&per_page=100`)
            const matches = list.workflow_runs.filter((run: JSONValue) => String(run.display_title).includes(dispatchMarker))
            assert(matches.length <= 1, 'Ambiguous workflow run marker'); return matches[0]
          })
          resources.workflow_runs ??= []; resources.workflow_runs.push({ id: run.id, outcome, marker: dispatchMarker })
          return observeRun(String(run.id), outcome)
        }).then(changed => { if (!changed) mark(id, 'not covered', 'Dispatched run finished before subscription; increase fixture step delays') })
      }
    }
  } catch (error) {
    mark('execution', 'failed', error instanceof Error ? error.message : 'Unknown execution failure')
  } finally {
    cleanupPhase = true
    // Include in-flight gh descendants owned by daemon/adapter processes, not only driver-spawned gh.
    try {
      const roots = new Set([...children.filter(p => p.exitCode === null).map(p => p.pid), ...peers.map(p => p.transport.pid).filter((pid): pid is number => pid !== null)])
      const ps = Bun.spawn(['ps', '-axo', 'pid=,ppid=,comm='], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
      const timer = setTimeout(() => ps.kill(), 5000)
      try {
        const [text, code] = await Promise.all([new Response(ps.stdout).text(), ps.exited])
        assert(code === 0, 'Unable to inspect owned process descendants')
        const rows = text.split('\n').flatMap(line => {
          const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
          return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]!.split('/').at(-1) }] : []
        })
        let changed = true
        while (changed) { changed = false; for (const row of rows) if (roots.has(row.ppid) && !roots.has(row.pid)) { roots.add(row.pid); changed = true } }
        resources.in_flight_owned_processes = rows.filter(row => roots.has(row.pid))
        resources.started_pids.push(...roots, ps.pid)
      } finally { clearTimeout(timer); if (ps.exitCode === null) { ps.kill(); await ps.exited } }
    } catch (error) { mark('cleanup.process-inspection', 'failed', String(error)) }
    // Only restore/close objects touched by this invocation; never delete remote fixtures.
    if (issue && (createdIssue || originalIssueState === 'closed')) {
      try { await api('PATCH', `repos/${REPO}/issues/${issue}`, { state: 'closed' }); resources.issue_final_state = 'closed' }
      catch (error) { mark('cleanup.issue', 'failed', String(error)) }
    } else if (issue && originalIssueState === 'open') {
      try { await api('PATCH', `repos/${REPO}/issues/${issue}`, { state: 'open' }); resources.issue_final_state = 'open' }
      catch (error) { mark('cleanup.issue', 'failed', String(error)) }
    }
    if (config.pr && originalPRState) {
      try { await api('PATCH', `repos/${REPO}/pulls/${config.pr}`, { state: originalPRState }); resources.pr_final_state = originalPRState }
      catch (error) { mark('cleanup.pr', 'failed', String(error)) }
    }
    for (const watch of watches) try { await watch.peer.call('unsubscribe', { watch_id: watch.id }) } catch (error) { mark('cleanup.unsubscribe.' + watch.id, 'failed', String(error)) }
    for (const p of peers) {
      try { await p.client.close() } catch { /* Explicit owned-PID termination follows. */ }
      if (p.transport.pid) resources.started_pids.push(p.transport.pid)
    }
    for (const child of children) if (child !== daemon && child.exitCode === null) child.kill()
    if (daemon?.exitCode === null) daemon.kill()
    for (const child of children) {
      const killer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 5000)
      try { await child.exited } finally { clearTimeout(killer) }
    }
    await Promise.allSettled(drains)
    for (const capture of nodeStderr) stderrEvidence.push({ label: capture.label, bytes: capture.bytes, sha256: capture.hash.digest('hex') })
    await localUntil(async () => {
      const remainingPids = [...new Set(resources.started_pids as number[])].filter(pid => { try { process.kill(pid, 0); return true } catch { return false } })
      resources.remaining_pids = remainingPids
      return remainingPids.length ? undefined : true
    }, 10_000).then(() => mark('cleanup.processes', 'passed', 'All recorded daemon/adapter/stream/gh invocation PIDs exited'), error => mark('cleanup.processes', 'failed', String(error)))
    if (socket && socketIdentity) {
      const current = await lstat(socket).catch(() => undefined)
      if (current && current.ino === socketIdentity.ino && current.dev === socketIdentity.dev && !resources.remaining_pids.length) await unlink(socket)
      resources.socket_reclaimed = !(await lstat(socket).catch(() => undefined))
      if (!resources.socket_reclaimed) mark('cleanup.socket', 'failed', 'Owned Unix socket still exists; retained for inspection')
    }
    // The directory is exclusively mkdtemp-owned, including consumer secrets and SQLite files.
    if (!resources.remaining_pids.length) { await rm(privateRoot, { recursive: true, force: true }); resources.private_files_reclaimed = true }
    else { resources.private_files_reclaimed = false; mark('cleanup.private-files', 'failed', 'Private test root retained because recorded processes remain') }
    const report = { repository: REPO, marker, date: new Date().toISOString(), proxy: PROXY, poll_ms: POLL_MS,
      scope: 'Real GitHub API + MCP SDK clients + CLI stream; not host binary evidence',
      input: { issue: config.issue ?? null, pr: config.pr ?? null, runs: config.runs, workflow: config.workflow ?? null, ref: config.ref ?? null },
      results: [...results.values()], resources }
    const files: Record<string, unknown> = { 'report.json': report, 'gh.json': apiEvidence, 'events.json': eventEvidence,
      'notifications.json': peers.map((p, i) => ({ client: i === 0 ? 'a' : 'b', notifications: p.notifications })), 'process-output-digests.json': stderrEvidence }
    for (const [name, value] of Object.entries(files)) await writeFile(join(evidence, name), safe(JSON.stringify(value, null, 2)) + '\n')
    console.log('Evidence: ' + evidence)
    process.exitCode = [...results.values()].some(r => r.verdict === 'failed') ? 1 : 0
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt)
  }
}

if (import.meta.main) {
  if (process.argv.includes('--help')) console.log(HELP)
  else await main().catch(error => { console.error(safe(error instanceof Error ? error.message : 'Smoke startup failed')); process.exitCode = 1 })
}

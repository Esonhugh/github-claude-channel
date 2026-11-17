import { z } from 'zod'
import { createHash } from 'node:crypto'

const id = z.string().regex(/^[1-9][0-9]*$/)
const base = {
  host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z0-9-]+$/).default('github.com'),
  repo: z.string().regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/[a-zA-Z0-9_.-]+$/).refine(s=>!['.','..'].includes(s.split('/')[1]!), 'Repository cannot be a path traversal segment'),
}
const issueEvents = z.array(z.enum(['lifecycle', 'comments'])).min(1).default(['lifecycle', 'comments'])
const prEvents = z.array(z.enum(['lifecycle', 'comments', 'reviews', 'review_comments'])).min(1).default(['lifecycle', 'comments', 'reviews', 'review_comments'])
const runEvents = z.array(z.enum(['run', 'job', 'step'])).min(1).default(['run', 'job', 'step'])
export const targetSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('issue'), number: z.number().int().positive(), events: issueEvents }).strict(),
  z.object({ ...base, kind: z.literal('pr'), number: z.number().int().positive(), events: prEvents }).strict(),
  z.object({ ...base, kind: z.literal('run'), run_id: id, attempt: z.union([z.literal('latest'), z.number().int().positive()]).default('latest'), events: runEvents }).strict(),
  z.object({ ...base, kind: z.literal('workflow'), workflow_id: id, branch: z.string().min(1).max(200).optional(), events: runEvents }).strict(),
  z.object({ ...base, kind: z.literal('repository'), objects: z.array(z.enum(['issue', 'pr'])).min(1).default(['issue', 'pr']), events: z.array(z.literal('lifecycle')).min(1).default(['lifecycle']) }).strict(),
])
export const subscribeSchema = z.object({
  targets: z.array(targetSchema).min(1).max(50),
  description: z.string().max(2000).optional(),
  initial: z.literal('snapshot').default('snapshot'),
  delivery: z.object({ mode: z.enum(['auto', 'pull']).default('auto'), detail: z.enum(['summary', 'jobs', 'steps']).default('steps') }).strict().default({mode:'auto', detail:'steps'}),
}).strict()
export type Target = z.infer<typeof targetSchema>
export type Rule = z.infer<typeof subscribeSchema>
export function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+stable((value as Record<string, unknown>)[k])).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}
export function hash(value: unknown) { return createHash('sha256').update(stable(value)).digest('hex') }
export function normalizeSubscription(input: unknown): Rule {
  const rule = subscribeSchema.parse(input)
  const merged=new Map<string,Target>()
  for(const t of rule.targets) {
    t.host = t.host.toLowerCase(); t.repo = t.repo.toLowerCase()
    t.events = [...new Set(t.events)].sort() as typeof t.events
    if(t.kind === 'repository') t.objects = [...new Set(t.objects)].sort()
    const key=targetKey(t),existing=merged.get(key)
    if(existing)existing.events=[...new Set([...existing.events,...t.events])].sort() as typeof existing.events
    else merged.set(key,t)
  }
  rule.targets=[...merged.values()].sort((a,b)=>stable(a).localeCompare(stable(b)))
  return rule
}
export function ruleKey(rule: Rule) { const {description, ...identity} = rule; return hash(identity) }
export function targetKey(target: Target) { const {events, ...identity} = target; return hash(identity) }
export const evidenceSchema = z.object({
  channels: z.enum(['enabled', 'unavailable', 'unknown']),
  monitor: z.enum(['available', 'unavailable', 'unknown']),
  evidence: z.string().min(1).max(2000),
}).strict()
export type Evidence = z.infer<typeof evidenceSchema>
export function deliveryMode(e: Evidence): 'channel'|'monitor'|'unknown'|'unavailable' {
  if(e.channels === 'enabled') return 'channel'
  if(e.channels === 'unavailable' && e.monitor === 'available') return 'monitor'
  if(e.channels === 'unavailable' && e.monitor === 'unavailable') return 'unavailable'
  return 'unknown'
}
export const tools = [
  {name:'subscribe', description:'Create a consumer-bound watch from explicit targets. No natural-language execution. Returns durable watch_id and initial snapshots.', schema:subscribeSchema},
  {name:'subscriptions', description:'List only this consumer watches, grouped and paginated, including delivery and collection health.', schema:z.object({watch_id:z.string().optional(),cursor:z.string().optional(),limit:z.number().int().min(1).max(100).default(20)}).strict()},
  {name:'unsubscribe', description:'Cancel all targets of this consumer watch. Unknown handles return already_absent.', schema:z.object({watch_id:z.string().min(1)}).strict()},
  {name:'snapshot', description:'Read a subscription snapshot with observed time and errors; not guaranteed live.', schema:z.object({subscription_id:z.string()}).strict()},
  {name:'events', description:'Read pending or historical events for one subscription. Does not acknowledge.', schema:z.object({subscription_id:z.string(),after_seq:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100).default(50)}).strict()},
  {name:'ack', description:'Cumulative processing acknowledgement, limited to events actually supplied to this consumer connection.', schema:z.object({subscription_id:z.string(),through_seq:z.number().int().min(0)}).strict()},
  {name:'delivery', description:'Record explicit HOST evidence of Channels enablement/Monitor availability. Never infer from successful connection, notification write, silence or missing ACK. Unknown stays unknown. Monitor is started by the host, not this tool.', schema:evidenceSchema},
]

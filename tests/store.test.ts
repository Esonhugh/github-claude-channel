import { afterEach, expect, test } from 'bun:test'
import { Store } from '../src/store.ts'
import { normalizeSubscription, targetKey } from '../src/schema.ts'
import { changes } from '../src/events.ts'
import type { Sample } from '../src/gh.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const stores:Store[]=[]
afterEach(()=>{for(const s of stores.splice(0))s.close()})
const sample=(records:Sample['records']):Sample=>({observed_at:new Date().toISOString(),records})
function setup() {
  const s=new Store(':memory:');stores.push(s)
  const a=s.session(),b=s.session()
  const rule=normalizeSubscription({targets:[{kind:'issue',repo:'o/r',number:1}]})
  const t=rule.targets[0]!, key=targetKey(t)
  const initial=sample({'issue:1':{number:1,state:'open',title:'hello'},'comment:1':{id:1,body:'old'}})
  const one=s.register(a.id,rule,new Map([[key,initial]]))
  const two=s.register(b.id,rule,new Map([[key,initial]]))
  return {s,a,b,rule,t,key,initial,one,two}
}
test('consumer isolation, rule idempotency, ack bounds and cancellation',()=>{
  const {s,a,b,rule,t,key,initial,one,two}=setup()
  expect(s.register(a.id,rule,new Map([[key,initial]])).watch_id).toBe(one.watch_id)
  expect(one.watch_id).not.toBe(two.watch_id)
  s.commitSample(t,sample({...initial.records,'comment:2':{id:2,body:'new'}}))
  const x=one.subscriptions[0].subscription_id,y=two.subscriptions[0].subscription_id
  expect(()=>s.ack(a.id,x,1)).toThrow('ack_exceeds')
  expect(()=>s.events(a.id,y,0,10)).toThrow('subscription_not_found')
  expect(s.events(a.id,x,0,10).events).toHaveLength(1)
  s.ack(a.id,x,1)
  expect(s.sub(b.id,y).acked_seq).toBe(0)
  expect(s.unsubscribe(a.id,one.watch_id).state).toBe('unsubscribed')
  expect(s.unsubscribe(a.id,one.watch_id).state).toBe('already_absent')
  expect(s.list(b.id).watches).toHaveLength(1)
})
test('evidence only, delivery fencing, unacked replay',()=>{
  const {s,a,t,initial,one}=setup()
  expect(()=>s.attach(a.id,'monitor')).toThrow()
  expect(s.configure(a.id,{channels:'unknown',monitor:'available',evidence:'unknown channels'}).mode).toBe('unknown')
  expect(()=>s.attach(a.id,'monitor')).toThrow()
  s.configure(a.id,{channels:'enabled',monitor:'available',evidence:'host enablement'})
  const old=s.attach(a.id,'channel')
  s.commitSample(t,sample({...initial.records,'comment:2':{id:2,body:'new'}}))
  expect(s.pending(a.id,{})).toHaveLength(1)
  s.configure(a.id,{channels:'unavailable',monitor:'available',evidence:'host explicit disable + Monitor available'})
  const now=s.attach(a.id,'monitor')
  expect(()=>s.validateLease(a.id,old.lease,'channel')).toThrow('fenced_delivery')
  expect(s.pending(a.id,{})).toHaveLength(1)
  s.ack(a.id,one.subscriptions[0].subscription_id,1)
  expect(s.pending(a.id,{})).toHaveLength(0)
  s.detach(a.id,now.lease)
  expect(s.list(a.id).watches[0].delivery.status).toBe('detached')
})
test('recovery requires secret and fences old session',()=>{
  const {s,a}=setup()
  expect(()=>s.session({id:a.id,secret:'wrong'})).toThrow()
  const resumed=s.session(a)
  expect(()=>s.authenticate(a.id,a.secret,a.epoch)).toThrow()
  expect(s.authenticate(resumed.id,resumed.secret,resumed.epoch).id).toBe(a.id)
})
test('retention reports explicit gap instead of silently skipping expired events',()=>{
  const {s,a,t,initial,one}=setup()
  s.commitSample(t,sample({...initial.records,'comment:2':{id:2,body:'expire me'}}))
  s.run('UPDATE events SET created_at=0')
  s.clean()
  const sub=one.subscriptions[0].subscription_id
  const result=s.events(a.id,sub,0,10)
  expect(result.events).toHaveLength(0)
  expect(result.gap?.earliest_seq).toBe(2)
  expect(s.list(a.id).watches[0].subscriptions[0].gap).toEqual({earliest_seq:2})
})
test('same issue supports close then reopen and a repeated close is not deduplicated away',()=>{
  const {s,a,t,initial,one}=setup()
  s.commitSample(t,sample({...initial.records,'issue:1':{state:'closed',updated_at:'2026-01-01T00:00:01Z'}}))
  s.commitSample(t,sample({...initial.records,'issue:1':{state:'open',updated_at:'2026-01-01T00:00:02Z'}}))
  s.commitSample(t,sample({...initial.records,'issue:1':{state:'closed',updated_at:'2026-01-01T00:00:03Z'}}))
  expect(s.events(a.id,one.subscriptions[0].subscription_id,0,10).events.map(r=>r.event.type)).toEqual(['issue.closed','issue.reopened','issue.closed'])
})
test('SQLite restart preserves event IDs and recovery while resetting supplied bounds',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ghc-restart-')),file=join(dir,'state.sqlite')
  let s=new Store(file)
  try {
    const a=s.session(),rule=normalizeSubscription({targets:[{kind:'issue',repo:'o/r',number:1}]})
    const t=rule.targets[0]!,initial=sample({'issue:1':{state:'open'}})
    const w=s.register(a.id,rule,new Map([[targetKey(t),initial]])),sub=w.subscriptions[0].subscription_id
    s.commitSample(t,sample({...initial.records,'comment:1':{id:1,body:'replay'}}))
    const event=s.events(a.id,sub,0,10).events[0]!.event
    s.close();s=new Store(file)
    const recovered=s.session(a)
    expect(recovered.id).toBe(a.id)
    expect(()=>s.ack(a.id,sub,1)).toThrow('ack_exceeds')
    expect(s.events(a.id,sub,0,10).events[0]!.event.event_id).toBe(event.event_id)
    s.ack(a.id,sub,1)
    expect(s.list(a.id).watches[0].subscriptions[0].pending_deliveries).toBe(0)
  } finally{s.close();rmSync(dir,{recursive:true,force:true})}
})
test('PR merge suppresses closed and preserves review/inline edits',()=>{
  const t=normalizeSubscription({targets:[{kind:'pr',repo:'o/r',number:2}]}).targets[0]!
  const before=sample({'pr:2':{state:'open',draft:true,head:{sha:'a'}},'review:1':{body:'old',state:'COMMENTED'}})
  const after=sample({'pr:2':{state:'closed',merged:true,draft:false,head:{sha:'b'}},'review:1':{body:'new',state:'CHANGES_REQUESTED'},'review_comment:2':{body:'inline',path:'x.ts',line:1},'timeline:3':{event:'closed',created_at:'2026-01-01T00:00:00Z'},'timeline:4':{event:'merged',created_at:'2026-01-01T00:00:00Z'}})
  const types=changes(t,before,after).map(c=>c.type)
  expect(types).not.toContain('pr.closed')
  expect(types.filter(t=>t==='pr.merged')).toHaveLength(1)
  expect(types).toContain('pr.review.changed');expect(types).toContain('pr.review_comment.created');expect(types).toContain('pr.head.changed');expect(types).toContain('pr.ready_for_review')
})
test('attempt separates rerun jobs and steps, repository only discovers newly created objects',()=>{
  const run=normalizeSubscription({targets:[{kind:'run',repo:'o/r',run_id:'1'}]}).targets[0]!
  const before=sample({'run:1:attempt:1':{id:1,status:'completed',conclusion:'failure'}})
  const after=sample({'run:1:attempt:2':{id:1,status:'in_progress'},'run:1:attempt:2/job:3':{status:'in_progress'},'run:1:attempt:2/job:3/step:1':{status:'in_progress'}})
  expect(changes(run,before,after).map(c=>c.type)).toEqual(['actions.run.discovered','actions.job.changed','actions.step.changed'])
  const repo=normalizeSubscription({targets:[{kind:'repository',repo:'o/r'}]}).targets[0]!
  const next=sample({'issue:3':{created_at:new Date().toISOString(),state:'open'},'issue:4':{created_at:'2000-01-01T00:00:00Z',state:'open'}})
  expect(changes(repo,sample({}),next).map(c=>c.source_key)).toEqual(['issue:3'])
})
test('edited comments use update time, not original creation time or invented editor identity',()=>{
  const t=normalizeSubscription({targets:[{kind:'issue',repo:'o/r',number:1}]}).targets[0]!
  const before=sample({'comment:1':{id:1,body:'old',user:{id:100},created_at:'2020-01-01T00:00:00Z'}})
  const after=sample({'comment:1':{...before.records['comment:1'],body:'edited',updated_at:'2026-11-17T01:00:00Z'}})
  const event=changes(t,before,after)[0]!
  expect(event.occurred_at).toBe('2026-11-17T01:00:00Z')
  expect(event.actor).toBeUndefined()
})
test('fixed completed attempt keeps polling until requested child records are terminal and final reconciliation confirms',()=>{
  const s=new Store(':memory:');stores.push(s)
  const consumer=s.session()
  const rule=normalizeSubscription({targets:[{kind:'run',repo:'o/r',run_id:'3',attempt:1}]})
  const t=rule.targets[0]!,key=targetKey(t),prefix='run:3:attempt:1'
  const pending=sample({[prefix]:{id:3,run_attempt:1,status:'completed',conclusion:'failure'},[prefix+'/job:8']:{status:'in_progress'},[prefix+'/job:8/step:1']:{status:'in_progress'}})
  const w=s.register(consumer.id,rule,new Map([[key,pending]])),sub=w.subscriptions[0].subscription_id
  expect(s.get('SELECT next_poll FROM targets WHERE key=?',key).next_poll).toBeLessThan(Number.MAX_SAFE_INTEGER)
  const terminal=sample({[prefix]:{id:3,run_attempt:1,status:'completed',conclusion:'failure'},[prefix+'/job:8']:{status:'completed',conclusion:'failure'},[prefix+'/job:8/step:1']:{status:'completed',conclusion:'failure'}})
  terminal.meta={action_events:['job','step']}
  s.commitSample(t,terminal)
  expect(s.get('SELECT next_poll FROM targets WHERE key=?',key).next_poll).toBeLessThan(Number.MAX_SAFE_INTEGER)
  s.commitSample(t,terminal)
  expect(s.get('SELECT next_poll FROM targets WHERE key=?',key).next_poll).toBe(Number.MAX_SAFE_INTEGER)
  expect(s.events(consumer.id,sub,0,10).events.map(r=>r.event.type)).toEqual(['actions.job.changed','actions.step.changed'])
})
test('adding a run-only watch cannot finalize a shared attempt with still-running requested steps',()=>{
  const s=new Store(':memory:');stores.push(s)
  const consumer=s.session(),rule=normalizeSubscription({targets:[{kind:'run',repo:'o/r',run_id:'3',attempt:1}]})
  const t=rule.targets[0]!,key=targetKey(t),prefix='run:3:attempt:1'
  const pending=sample({[prefix]:{status:'completed',conclusion:'success'},[prefix+'/job:8']:{status:'in_progress'},[prefix+'/job:8/step:1']:{status:'in_progress'}})
  pending.meta={action_events:['job','step']}
  s.register(consumer.id,rule,new Map([[key,pending]]))
  const narrow=normalizeSubscription({targets:[{kind:'run',repo:'o/r',run_id:'3',attempt:1,events:['run']}]})
  s.register(consumer.id,narrow,new Map([[key,pending]]))
  expect(s.get('SELECT next_poll FROM targets WHERE key=?',key).next_poll).toBeLessThan(Number.MAX_SAFE_INTEGER)
})

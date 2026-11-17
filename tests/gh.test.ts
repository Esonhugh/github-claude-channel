import { expect, test } from 'bun:test'
import { mkdtemp, writeFile, rm, readFile, mkdir } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { GitHub } from '../src/gh.ts'
import { normalizeSubscription, targetKey } from '../src/schema.ts'
import { Store } from '../src/store.ts'
const resources:any[]=[]

async function fake(routes:any,fn:(gh:GitHub)=>Promise<void>,overrides:Record<string,string>={}) {
  const dir=await mkdtemp(join(tmpdir(),'ghc-gh-'))
  const values={GHC_FIXTURE_FILE:join(dir,'routes.json'),GHC_TRACE_FILE:join(dir,'trace.jsonl'),GHC_GH_INTERVAL_MS:'0',GHC_REQUESTS_PER_HOUR:'3500',GHC_GH_TIMEOUT_MS:'30000',...overrides}
  const old=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]))
  Object.assign(process.env,values);await writeFile(values.GHC_FIXTURE_FILE!,JSON.stringify(routes))
  const gh=new GitHub(resolve(import.meta.dir,'fixtures/gh.ts'))
  try{await fn(gh)}finally{
    await gh.close()
    const pids=await readFile(values.GHC_TRACE_FILE!,'utf8').then(s=>s.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x).pid as number)).catch(()=>[])
    const remaining=pids.filter(pid=>{try{process.kill(pid,0);return true}catch{return false}})
    resources.push({temporary_root:dir,pids,reclaimed:remaining.length===0,remaining_pids:remaining})
    const evidence=resolve(import.meta.dir,'../docs/evidence');await mkdir(evidence,{recursive:true})
    await writeFile(join(evidence,`unit-gh-${process.pid}-resources.json`),JSON.stringify(resources,null,2)+'\n')
    for(const [key,value]of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value}
    await rm(dir,{recursive:true,force:true});expect(remaining).toEqual([])
  }
}
test('gh conditional 304 retains correct page representation and read-only budget bounds',async()=>{
  await fake({'repos/o/r/issues':{etag:'"one"',data:[{id:1}]}},async gh=>{
    expect(await gh.request('github.com','repos/o/r/issues')).toEqual([{id:1}])
    expect(await gh.request('github.com','repos/o/r/issues')).toEqual([{id:1}])
    await expect(gh.request('github.com','repos/o/r/issues')).rejects.toThrow('local_request_budget')
  },{GHC_REQUESTS_PER_HOUR:'2'})
})
test('API error categories, rate-limit retry, timeout reclaim subprocesses',async()=>{
  await fake({},async gh=>{await expect(gh.request('attacker.invalid','user')).rejects.toThrow('host_not_in_profile_allowlist');expect(gh.children.size).toBe(0)})
  for(const [status,category]of [[401,'authentication_failed'],[403,'forbidden'],[404,'not_found_or_invisible'],[429,'rate_limited']] as const)await fake({'repos/o/r/issues':{status,data:{}}},async gh=>{
    await expect(gh.request('github.com','repos/o/r/issues')).rejects.toThrow(category)
    expect(gh.children.size).toBe(0)
    if(status===429)expect(gh.blockedUntil).toBeGreaterThan(Date.now())
  })
  await fake({'slow':{delay_ms:1000,data:{}}},async gh=>{
    await expect(gh.request('github.com','slow')).rejects.toThrow('gh_timeout')
    expect(gh.children.size).toBe(0)
  },{GHC_GH_TIMEOUT_MS:'30'})
})
test('workflow discovers runs and fixed-attempt query preserves attempt identity',async()=>{
  await fake({
    'repos/o/r/actions/workflows/9/runs':{data:{workflow_runs:[{id:3,run_attempt:2,status:'in_progress'}]}},
    'repos/o/r/actions/runs/3/attempts/2/jobs':{data:{jobs:[{id:8,status:'in_progress',steps:[{number:1,status:'in_progress'}]}]}},
    'repos/o/r/actions/runs/3/attempts/2':{data:{id:3,run_attempt:2,status:'in_progress'}},
  },async gh=>{
    const workflow=normalizeSubscription({targets:[{kind:'workflow',repo:'o/r',workflow_id:'9',branch:'main'}]}).targets[0]!
    const sample=await gh.sample(workflow)
    expect(sample.records['run:3:attempt:2/job:8/step:1']._attempt).toBe(2)
    const run=normalizeSubscription({targets:[{kind:'run',repo:'o/r',run_id:'3',attempt:2}]}).targets[0]!
    expect((await gh.sample(run)).records['run:3:attempt:2'].run_attempt).toBe(2)
  })
})
test('completed workflow runs collect newly requested jobs and steps instead of reusing incomplete samples',async()=>{
  await fake({
    'repos/o/r/actions/workflows/9/runs':{data:{workflow_runs:[{id:3,run_attempt:1,status:'completed',conclusion:'success'}]}},
    'repos/o/r/actions/runs/3/attempts/1/jobs':{data:{jobs:[{id:8,status:'completed',conclusion:'success',steps:[{number:1,status:'completed',conclusion:'success'}]}]}},
  },async gh=>{
    for(const events of [['run'],['run','job']]) {
      const narrow=normalizeSubscription({targets:[{kind:'workflow',repo:'o/r',workflow_id:'9',events}]}).targets[0]!
      let previous=await gh.sample(narrow)
      // Even a previously stabilized narrower scope must not suppress newly requested children.
      previous=await gh.sample(narrow,previous)
      const expanded=normalizeSubscription({targets:[{kind:'workflow',repo:'o/r',workflow_id:'9',events:['run','job','step']}]}).targets[0]!
      const next=await gh.sample(expanded,previous)
      expect(next.records['run:3:attempt:1/job:8/step:1']?.status).toBe('completed')
    }
  })
})
test('fixed-attempt collection proof waits for child completion and one final successful read',async()=>{
  const routes={
    'repos/o/r/actions/runs/3/attempts/1':{data:{id:3,run_attempt:1,status:'completed',conclusion:'failure'}},
    'repos/o/r/actions/runs/3/attempts/1/jobs':{data:{jobs:[{id:8,status:'in_progress',conclusion:null as string|null,steps:[{number:1,status:'in_progress',conclusion:null as string|null}]}]}},
  }
  await fake(routes,async gh=>{
    const s=new Store(':memory:')
    try {
      const consumer=s.session(),rule=normalizeSubscription({targets:[{kind:'run',repo:'o/r',run_id:'3',attempt:1}]})
      const t=rule.targets[0]!,key=targetKey(t)
      let previous=await gh.sample(t)
      expect(previous.meta?.action_events).toEqual(['job','step'])
      s.register(consumer.id,rule,new Map([[key,previous]]))
      expect(s.get('SELECT next_poll FROM targets WHERE key=?',key).next_poll).toBeLessThan(Number.MAX_SAFE_INTEGER)
      const job=routes['repos/o/r/actions/runs/3/attempts/1/jobs'].data.jobs[0]!
      job.status='completed';job.conclusion='failure';job.steps[0]!.status='completed';job.steps[0]!.conclusion='failure'
      await writeFile(process.env.GHC_FIXTURE_FILE!,JSON.stringify(routes))
      previous=await gh.sample(t,previous);s.commitSample(t,previous)
      expect(s.get('SELECT next_poll FROM targets WHERE key=?',key).next_poll).toBeLessThan(Number.MAX_SAFE_INTEGER)
      s.commitSample(t,await gh.sample(t,previous))
      expect(s.get('SELECT next_poll FROM targets WHERE key=?',key).next_poll).toBe(Number.MAX_SAFE_INTEGER)
    } finally{s.close()}
  })
})

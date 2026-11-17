import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const entry=process.env.GHC_TEST_ENTRY?resolve(process.env.GHC_TEST_ENTRY):resolve(import.meta.dir,'../src/cli.ts')
const fake=resolve(import.meta.dir,'fixtures/gh.ts')
async function until<T>(f:()=>Promise<T|undefined>,timeout=10000):Promise<T> {
  const end=Date.now()+timeout
  while(Date.now()<end){const found=await f();if(found!==undefined)return found;await Bun.sleep(30)}
  throw new Error('condition_timeout')
}
async function context(routes:Record<string,any>,overrides:Record<string,string>={}) {
  const root=await mkdtemp(join(tmpdir(),'ghc-test-'))
  const fixture=join(root,'fixture.json'),trace=join(root,'gh.jsonl')
  const env:Record<string,string>={PATH:process.env.PATH!,HOME:root,GHC_STATE_DIR:join(root,'state'),GHC_GH:fake,GHC_FIXTURE_FILE:fixture,GHC_TRACE_FILE:trace,GHC_POLL_MS:'150',GHC_IDLE_MS:'2000',GHC_GH_INTERVAL_MS:'0',GH_CONFIG_DIR:join(root,'gh'),GH_PROMPT_DISABLED:'1',...overrides}
  await writeFile(fixture,JSON.stringify(routes))
  const p=Bun.spawn([process.execPath,entry,'daemon'],{env,stdout:'pipe',stderr:'pipe'})
  const stderr=new Response(p.stderr).text(),stdout=new Response(p.stdout).text()
  const clients:Client[]=[];const extras:Bun.Subprocess[]=[];const adapterPids:number[]=[]
  let socket=''
  try {
    socket=await until(async()=>{
      if(p.exitCode!==null)throw new Error('daemon exited before ready')
      try {const dirs=await readdir(env.GHC_STATE_DIR!);return JSON.parse(await readFile(join(env.GHC_STATE_DIR!,dirs[0]!,'daemon.json'),'utf8')).socket}catch{return undefined}
    })
  } catch(error){p.kill();await p.exited;await rm(root,{recursive:true,force:true});throw error}
  async function client(file?:string) {
    const c=new Client({name:'fixture-client',version:'1'})
    const notifications:any[]=[]
    c.setNotificationHandler(z.object({method:z.literal('notifications/claude/channel'),params:z.object({content:z.string(),meta:z.record(z.string(),z.string()).optional()})}),n=>{notifications.push(n.params)})
    const transport=new StdioClientTransport({command:process.execPath,args:[entry,'stdio'],env:{...env,...(file?{GHC_CONSUMER_FILE:file}:{})},stderr:'pipe'})
    clients.push(c);await c.connect(transport)
    if(transport.pid)adapterPids.push(transport.pid)
    const call=async(name:string,args:Record<string,any>={})=>{
      const r=await c.callTool({name,arguments:args})
      const text=(r.content as any[])[0]?.text
      if(r.isError)throw new Error(text)
      return JSON.parse(text)
    }
    return {c,call,notifications,pid:transport.pid}
  }
  async function update(next:Record<string,any>) {await writeFile(fixture+'.next',JSON.stringify(next));await rename(fixture+'.next',fixture)}
  async function api(path:string,body:any={},session?:any) {
    const res=await fetch('http://localhost'+path,{unix:socket,method:'POST',headers:{'content-type':'application/json',...(session?{'x-consumer':session.id,'x-secret':session.secret,'x-epoch':String(session.epoch)}:{})},body:JSON.stringify(body)})
    const data=await res.json() as any
    return {status:res.status,data}
  }
  async function cleanup() {
    for(const c of clients)await c.close().catch(()=>{})
    for(const extra of extras){if(extra.exitCode===null)extra.kill();await extra.exited}
    if(p.exitCode===null)p.kill()
    await Promise.race([p.exited,Bun.sleep(5000).then(()=>{if(p.exitCode===null)p.kill('SIGKILL')})])
    const logs={pid:p.pid,stdout:await stdout,stderr:await stderr}
    // Credentials/runtime fixtures are always reclaimed. Evidence contains only lifecycle metadata.
    await mkdir(resolve(import.meta.dir,'../docs/evidence'),{recursive:true})
    const ghPids=await readFile(trace,'utf8').then(s=>[...new Set(s.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x).pid))]).catch(()=>[])
    const started=[p.pid,...adapterPids,...extras.map(p=>p.pid),...ghPids]
    const remaining=started.filter(pid=>{try{process.kill(pid,0);return true}catch{return false}})
    await writeFile(resolve(import.meta.dir,`../docs/evidence/integration-${p.pid}-resources.json`),JSON.stringify({...logs,socket,temporary_root:root,adapter_pids:adapterPids,stream_pids:extras.map(p=>p.pid),gh_pids:ghPids,reclaimed:remaining.length===0,remaining_pids:remaining},null,2)+'\n')
    await rm(root,{recursive:true,force:true})
    expect(remaining).toEqual([])
  }
  return {root,env,p,client,update,api,cleanup,trace,extras}
}
const issueRoutes=()=>({
  'repos/o/r/issues/1':{data:{id:1,number:1,state:'open',title:'test issue',created_at:'2020-01-01T00:00:00Z'}},
  'repos/o/r/issues/1/comments':{data:[{id:1,body:'baseline',created_at:'2020-01-01T00:00:00Z'}]},
  'repos/o/r/issues/1/timeline':{data:[]},
})

test('dual real MCP clients share daemon, isolate watches/ACK, Channels evidence and replay',async()=>{
  const routes:Record<string,any>=issueRoutes(),ctx=await context(routes)
  try {
    const a=await ctx.client(),b=await ctx.client()
    const args={targets:[{kind:'issue',repo:'o/r',number:1}]}
    const x=await a.call('subscribe',args),y=await b.call('subscribe',args)
    expect(x.watch_id).not.toBe(y.watch_id)
    expect(x.delivery.status).toBe('pending_confirmation')
    expect((await a.call('subscribe',args)).watch_id).toBe(x.watch_id)
    const sub=x.subscriptions[0].subscription_id,other=y.subscriptions[0].subscription_id
    await expect(a.call('events',{subscription_id:other})).rejects.toThrow('subscription_not_found')
    await a.call('delivery',{channels:'enabled',monitor:'available',evidence:'test host explicit enablement'})
    routes['repos/o/r/issues/1/comments'].data.push({id:2,body:'new comment',created_at:new Date().toISOString()})
    await ctx.update(routes)
    await until(async()=>a.notifications.length?a.notifications:undefined)
    expect(b.notifications).toHaveLength(0)
    const events=await a.call('events',{subscription_id:sub})
    expect(events.events).toHaveLength(1)
    expect(events.events[0].event.type).toBe('issue.comment.created')
    const bEvents=await b.call('events',{subscription_id:other})
    expect(bEvents.events[0].event.event_id).toBe(events.events[0].event.event_id)
    await expect(a.call('ack',{subscription_id:sub,through_seq:2})).rejects.toThrow('ack_exceeds')
    await a.call('ack',{subscription_id:sub,through_seq:1})
    expect((await b.call('subscriptions')).watches[0].subscriptions[0].acked_seq).toBe(0)
    await a.call('unsubscribe',{watch_id:x.watch_id})
    expect((await a.call('subscriptions')).message).toBe('无订阅')
    expect((await b.call('subscriptions')).watches).toHaveLength(1)
    const trace=(await readFile(ctx.trace,'utf8')).trim().split('\n').map(x=>JSON.parse(x))
    expect(trace.every(x=>x.method==='GET')).toBe(true)
    // Both consumers refer to a single persisted target collector, not two watcher processes.
    expect((await ctx.api('/health')).data.pid).toBe(ctx.p.pid)
  } finally {await ctx.cleanup()}
},30000)

test('Monitor CLI stream requires fallback evidence, expires detached and keeps watches; IPC fences old lease',async()=>{
  const routes:Record<string,any>=issueRoutes(),ctx=await context(routes)
  try {
    const file=join(ctx.root,'consumer.json'),a=await ctx.client(file)
    const x=await a.call('subscribe',{targets:[{kind:'issue',repo:'o/r',number:1}]})
    const session=JSON.parse(await readFile(file,'utf8'))
    expect((await ctx.api('/attach',{mode:'monitor'},session)).status).toBe(400)
    await a.call('delivery',{channels:'unavailable',monitor:'available',evidence:'host disabled Channels, host Monitor available'})
    const old=(await ctx.api('/attach',{mode:'monitor'},session)).data.lease
    // Host Monitor need not inherit MCP-scoped profile variables: the private handle binds the socket.
    const p=Bun.spawn([process.execPath,entry,'stream','--consumer-file',file,'--duration-ms','1800'],{env:{PATH:process.env.PATH!,HOME:ctx.root},stdout:'pipe',stderr:'pipe'})
    ctx.extras.push(p)
    const out=new Response(p.stdout).text(),err=new Response(p.stderr).text()
    await until(async()=> (await ctx.api('/validate',{mode:'monitor',lease:old},session)).status===400?true:undefined)
    routes['repos/o/r/issues/1/comments'].data.push({id:2,body:'monitor event',created_at:new Date().toISOString()});await ctx.update(routes)
    expect(await p.exited).toBe(0)
    const rows=(await out).trim().split('\n').map(x=>JSON.parse(x))
    expect(rows).toHaveLength(1)
    expect(rows[0].event.type).toBe('issue.comment.created')
    expect(await err).toContain('detached')
    expect((await a.call('subscriptions')).watches[0].delivery.status).toBe('detached')
    expect((await a.call('subscriptions')).watches[0].watch_id).toBe(x.watch_id)
    const replay=await a.call('events',{subscription_id:x.subscriptions[0].subscription_id})
    expect(replay.events[0].event.event_id).toBe(rows[0].event.event_id)
    expect(a.notifications).toHaveLength(0)
  } finally {await ctx.cleanup()}
},30000)

test('pagination, PR lifecycle/reviews/inline, run attempt/jobs/steps and repo discovery through fake gh',async()=>{
  const routes:Record<string,any>={
    'repos/o/r/pulls/2':{data:{id:2,number:2,state:'open',draft:true,head:{sha:'a'},created_at:'2020-01-01T00:00:00Z'}},
    'repos/o/r/issues/2/comments':{data:Array.from({length:101},(_,i)=>({id:i+1,body:'baseline '+i}))},
    'repos/o/r/issues/2/timeline':{data:[]},
    'repos/o/r/pulls/2/reviews':{data:[{id:1,body:'old',state:'COMMENTED'}]},
    'repos/o/r/pulls/2/comments':{data:[]},
    'repos/o/r/actions/runs/3':{data:{id:3,run_attempt:1,status:'in_progress',conclusion:null}},
    'repos/o/r/actions/runs/3/attempts/1/jobs':{data:{jobs:[{id:5,status:'in_progress',steps:[{number:1,name:'test',status:'in_progress'}]}]}},
    'repos/o/r/issues':{data:[]},
  }
  const ctx=await context(routes)
  try {
    const a=await ctx.client()
    const w=await a.call('subscribe',{targets:[{kind:'pr',repo:'o/r',number:2},{kind:'run',repo:'o/r',run_id:'3'},{kind:'repository',repo:'o/r'}]})
    const pr=w.subscriptions.find((s:any)=>s.target.kind==='pr'),run=w.subscriptions.find((s:any)=>s.target.kind==='run'),repo=w.subscriptions.find((s:any)=>s.target.kind==='repository')
    expect(Object.keys((await a.call('snapshot',{subscription_id:pr.subscription_id})).snapshot.records).filter(k=>k.startsWith('comment:'))).toHaveLength(101)
    routes['repos/o/r/pulls/2'].data={...routes['repos/o/r/pulls/2'].data,state:'closed',merged:true,draft:false,head:{sha:'b'}}
    routes['repos/o/r/pulls/2/reviews'].data[0]={id:1,body:'please fix',state:'CHANGES_REQUESTED'}
    routes['repos/o/r/pulls/2/comments'].data=[{id:9,body:'inline fix',path:'src/x.ts',line:2,side:'RIGHT',diff_hunk:'@@'}]
    routes['repos/o/r/actions/runs/3'].data={id:3,run_attempt:2,status:'completed',conclusion:'failure'}
    routes['repos/o/r/actions/runs/3/attempts/2/jobs']={data:{jobs:[{id:6,status:'completed',conclusion:'failure',steps:[{number:1,name:'test',status:'completed',conclusion:'failure'}]}]}}
    routes['repos/o/r/issues'].data=[{id:10,number:10,state:'open',title:'new issue',created_at:new Date().toISOString()}]
    await ctx.update(routes)
    const pull=async(sub:string)=>a.call('events',{subscription_id:sub})
    await until(async()=> (await pull(pr.subscription_id)).events.some((x:any)=>x.event.type==='pr.merged')?true:undefined)
    const types=(await pull(pr.subscription_id)).events.map((r:any)=>r.event.type)
    expect(types).toContain('pr.review.changed');expect(types).toContain('pr.review_comment.created');expect(types).not.toContain('pr.closed')
    await until(async()=> (await pull(run.subscription_id)).events.some((x:any)=>x.event.type==='actions.step.changed')?true:undefined)
    const re=(await pull(run.subscription_id)).events
    expect(re.some((x:any)=>x.event.type==='actions.run.completed')).toBe(true)
    expect(re.filter((x:any)=>x.event.type==='actions.step.changed')[0].event.data._attempt).toBe(2)
    await until(async()=> (await pull(repo.subscription_id)).events.some((x:any)=>x.event.type==='issue.opened')?true:undefined)
    const trace=await readFile(ctx.trace,'utf8');expect(trace).toContain('page=2')
  } finally {await ctx.cleanup()}
},30000)

test('multi-target initialization failure is atomic and account switch pauses private reads',async()=>{
  const routes:Record<string,any>=issueRoutes(),ctx=await context(routes)
  try {
    const a=await ctx.client()
    await expect(a.call('subscribe',{targets:[{kind:'issue',repo:'o/r',number:1},{kind:'issue',repo:'o/r',number:404}]})).rejects.toThrow('not_found_or_invisible')
    expect((await a.call('subscriptions')).watches).toHaveLength(0)
    const w=await a.call('subscribe',{targets:[{kind:'issue',repo:'o/r',number:1}]})
    routes.user={data:{id:200,login:'different-account'}}
    await ctx.update(routes)
    await expect(a.call('subscribe',{targets:[{kind:'issue',repo:'o/r',number:1}],delivery:{mode:'pull'}})).rejects.toThrow('authentication_identity_changed')
    await expect(a.call('snapshot',{subscription_id:w.subscriptions[0].subscription_id})).rejects.toThrow('authentication_identity_changed')
    expect((await a.call('subscriptions')).authentication_error).toContain('authentication_identity_changed')
    expect((await a.call('unsubscribe',{watch_id:w.watch_id})).state).toBe('unsubscribed')
  } finally{await ctx.cleanup()}
},30000)

test('private daemon admin stop/clean and unauthenticated consumer access are bounded',async()=>{
  const ctx=await context(issueRoutes())
  try {
    expect((await ctx.api('/tool',{name:'subscriptions'})).status).toBe(400)
    const clean=await ctx.api('/admin',{operation:'clean'})
    expect(clean.status).toBe(200)
    const stop=await ctx.api('/admin',{operation:'stop'})
    expect(stop.data.pid).toBe(ctx.p.pid)
    expect(await ctx.p.exited).toBe(0)
  } finally{await ctx.cleanup()}
},30000)

test('temporary authentication failure blocks cache until explicit authenticated retry succeeds',async()=>{
  const routes:Record<string,any>=issueRoutes(),ctx=await context(routes)
  try {
    const a=await ctx.client(),args={targets:[{kind:'issue',repo:'o/r',number:1}]}
    const w=await a.call('subscribe',args)
    routes.user={status:401,data:{message:'invalid test credential'}};await ctx.update(routes)
    await expect(a.call('subscribe',args)).rejects.toThrow('authentication_failed')
    await expect(a.call('snapshot',{subscription_id:w.subscriptions[0].subscription_id})).rejects.toThrow('authentication_failed')
    routes.user={data:{id:100,login:'fixture-user'}};await ctx.update(routes)
    expect((await a.call('subscribe',args)).watch_id).toBe(w.watch_id)
    expect((await a.call('snapshot',{subscription_id:w.subscriptions[0].subscription_id})).snapshot.records['issue:1'].state).toBe('open')
  } finally{await ctx.cleanup()}
},30000)

test('two adapters automatically start exactly one shared daemon; all startup-race children are reclaimed',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ghc-bootstrap-'))
  const env:Record<string,string>={PATH:process.env.PATH!,HOME:root,GHC_STATE_DIR:join(root,'state'),GH_CONFIG_DIR:join(root,'gh'),GHC_IDLE_MS:'500'}
  const clients:Client[]=[],pids:number[]=[]
  let socket='',dir=''
  try {
    await Promise.all([1,2].map(async i=>{
      const c=new Client({name:'bootstrap-'+i,version:'1'});clients.push(c)
      const transport=new StdioClientTransport({command:process.execPath,args:[entry,'stdio'],env,stderr:'pipe'})
      await c.connect(transport);if(transport.pid)pids.push(transport.pid)
      const tools=await c.listTools();expect(tools.tools.map(t=>t.name)).toContain('subscribe')
    }))
    dir=join(env.GHC_STATE_DIR!,(await readdir(env.GHC_STATE_DIR!))[0]!)
    const metadata=JSON.parse(await readFile(join(dir,'daemon.json'),'utf8'));socket=metadata.socket
    const health=await fetch('http://localhost/health',{unix:socket,method:'POST',body:'{}'}).then(r=>r.json()) as any
    expect(health.pid).toBe(metadata.pid)
  } finally {
    for(const c of clients)await c.close().catch(()=>{})
    if(!dir)dir=await readdir(env.GHC_STATE_DIR!).then(d=>d[0]?join(env.GHC_STATE_DIR!,d[0]):'').catch(()=>'')
    if(!socket&&dir)socket=await readFile(join(dir,'daemon.json'),'utf8').then(s=>JSON.parse(s).socket).catch(()=>'')
    if(socket)await fetch('http://localhost/admin',{unix:socket,method:'POST',body:JSON.stringify({operation:'stop'})}).catch(()=>{})
    const launched=dir?await readFile(join(dir,'launches.jsonl'),'utf8').then(s=>s.trim().split('\n').map(x=>JSON.parse(x).pid as number)).catch(()=>[]):[]
    pids.push(...launched)
    await until(async()=>pids.every(pid=>{try{process.kill(pid,0);return false}catch{return true}})?true:undefined)
    await writeFile(resolve(import.meta.dir,`../docs/evidence/bootstrap-${launched[0]??Date.now()}-resources.json`),JSON.stringify({pids,socket,reclaimed:true,remaining_pids:[]},null,2)+'\n')
    await rm(root,{recursive:true,force:true})
  }
},30000)

test('abrupt Monitor process death expires its delivery lease without unsubscribing',async()=>{
  const ctx=await context(issueRoutes(),{GHC_DELIVERY_LEASE_MS:'800'})
  try {
    const file=join(ctx.root,'consumer.json'),a=await ctx.client(file)
    const w=await a.call('subscribe',{targets:[{kind:'issue',repo:'o/r',number:1}]})
    await a.call('delivery',{channels:'unavailable',monitor:'available',evidence:'host fallback test'})
    const p=Bun.spawn([process.execPath,entry,'stream','--consumer-file',file,'--duration-ms','5000'],{env:ctx.env,stdout:'ignore',stderr:'ignore'});ctx.extras.push(p)
    await until(async()=> (await a.call('subscriptions')).watches[0].delivery.status==='attached'?true:undefined)
    p.kill('SIGKILL');await p.exited
    await until(async()=> (await a.call('subscriptions')).watches[0].delivery.status==='detached'?true:undefined)
    expect((await a.call('subscriptions')).watches[0].watch_id).toBe(w.watch_id)
  } finally{await ctx.cleanup()}
},30000)

for(const reverse of [false,true])test(`split issue targets share one baseline and never announce historical comments (reverse=${reverse})`,async()=>{
  const ctx=await context(issueRoutes())
  try {
    const a=await ctx.client()
    const targets=[{kind:'issue',repo:'o/r',number:1,events:['comments']},{kind:'issue',repo:'o/r',number:1,events:['lifecycle']}]
    const watch=await a.call('subscribe',{targets:reverse?targets.reverse():targets})
    const sub=watch.subscriptions.find((s:any)=>s.events.includes('comments')).subscription_id
    await until(async()=> (await a.call('snapshot',{subscription_id:sub})).snapshot.records['comment:1']?true:undefined)
    expect((await a.call('events',{subscription_id:sub})).events).toHaveLength(0)
    expect(watch.subscriptions).toHaveLength(1)
  } finally{await ctx.cleanup()}
},30000)

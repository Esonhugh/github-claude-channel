import { chmod, unlink, writeFile, lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Store } from './store.ts'
import { GitHub, GhError } from './gh.ts'
import { normalizeSubscription, ruleKey, targetKey, tools, type Target } from './schema.ts'
import { runtime, secureDir } from './runtime.ts'

export async function daemon() {
  const rt=runtime();await secureDir(rt.dir)
  // Bind before opening shared state; losing startup races must not fence the winner's sessions.
  let handle:(request:Request)=>Promise<Response> = async()=>Response.json({error:'starting'},{status:503})
  const server=Bun.serve({unix:rt.socket,fetch:r=>handle(r),maxRequestBodySize:1024*1024})
  await chmod(rt.socket,0o600)
  const socketIdentity=await lstat(rt.socket)
  let store:Store
  try{store=new Store(join(rt.dir,'state.sqlite'))}catch(error){server.stop(true);await unlink(rt.socket).catch(()=>{});throw error}
  await chmod(join(rt.dir,'state.sqlite'),0o600)
  const gh=new GitHub()
  let closing=false,lastActive=Date.now(),lastAuth=0,lastClean=0
  let queue:Promise<any>=Promise.resolve()
  const serial=<T>(fn:()=>Promise<T>):Promise<T>=>{const p=queue.then(fn);queue=p.catch(()=>{});return p}
  const leases=new Map<string,{mode:string;cursor:Record<string,number>;seen:number}>()
  let authError:string|null=null
  let authFailure:string|null=null
  async function clean() {
    const result=store.clean()
    for(const id of result.expired_consumers) {
      for(const key of leases.keys())if(key.startsWith(id+':'))leases.delete(key)
      await unlink(join(rt.dir,'consumers',id+'.json')).catch(error=>{if(error.code!=='ENOENT')console.error('expired recovery file cleanup failed')})
    }
    return result
  }
  async function auth(host:string) {
    if(authError)throw new Error(authError)
    let identity:any
    try{identity=await gh.request(host,'user')}catch(error){
      if(error instanceof GhError&&(error.status===401||error.status===403)){authFailure=error.message;store.db.exec('UPDATE consumers SET attached=0,delivery_epoch=delivery_epoch+1')}
      throw error
    }
    if(!identity||!/^[1-9][0-9]*$/.test(String(identity.id)))throw new Error('invalid_authenticated_identity')
    const k='identity:'+host
    const old=store.get('SELECT value FROM metadata WHERE key=?',k)?.value
    if(old&&old!==String(identity.id)) {
      authError='authentication_identity_changed_restart_with_new_profile'
      store.run('UPDATE targets SET last_error=?',authError)
      store.db.exec('UPDATE consumers SET attached=0,delivery_epoch=delivery_epoch+1')
      throw new Error(authError)
    }
    store.run('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)',k,String(identity.id))
    authFailure=null
  }
  function fail(error:unknown){return error instanceof Error?error.message:'operation_failed'}
  async function collect(t:Target) {
    const key=targetKey(t)
    try {
      const sample=await gh.sample(t,store.sample(key))
      store.db.transaction(()=>store.commitSample(t,sample))()
    }catch(error){store.run('UPDATE targets SET last_error=?,next_poll=? WHERE key=?',fail(error),Math.max(Date.now()+60000,gh.blockedUntil),key)}
  }
  async function tool(id:string,name:string,input:any,epoch:number) {
    const spec=tools.find(t=>t.name===name);if(!spec)throw new Error('unknown_tool')
    const a=spec.schema.parse(input) as any
    if(authError&&!['unsubscribe','subscriptions','delivery'].includes(name))throw new Error(authError)
    if(authFailure&&!['unsubscribe','subscriptions','delivery','subscribe'].includes(name))throw new Error(authFailure)
    if(name==='subscribe')return serial(async()=>{
      if(store.get('SELECT epoch FROM consumers WHERE id=?',id)?.epoch!==epoch)throw new Error('fenced_consumer')
      const rule=normalizeSubscription(a)
      for(const host of new Set(rule.targets.map(t=>t.host)))await auth(host)
      const existing=store.get("SELECT id FROM watches WHERE consumer_id=? AND rule_key=? AND state='active'",id,ruleKey(rule))
      if(existing)return {watch_id:existing.id,state:'already_subscribed',...store.watchDetail(id,existing.id)}
      const samples=new Map()
      const expanded=store.activeTargets()
      for(const t of rule.targets) {
        const same=expanded.find(e=>targetKey(e)===targetKey(t))
        const union={...t,events:[...new Set([...t.events,...(same?.events??[])])]} as Target
        samples.set(targetKey(t),await gh.sample(union,store.sample(targetKey(t))))
      }
      if(store.get('SELECT epoch FROM consumers WHERE id=?',id)?.epoch!==epoch)throw new Error('fenced_consumer')
      return store.register(id,rule,samples)
    })
    if(name==='subscriptions')return {...store.list(id,a.cursor,a.limit,a.watch_id),quota:{remaining:gh.remaining,reset:gh.reset},authentication_error:authError||authFailure}
    if(name==='unsubscribe')return store.unsubscribe(id,a.watch_id)
    if(name==='snapshot') {const sub=store.sub(id,a.subscription_id);const row=store.get('SELECT * FROM targets WHERE key=?',sub.target_key);if(!row)throw new Error('snapshot_expired');return {subscription_id:sub.id,snapshot:row.sample?JSON.parse(row.sample):null,observed_at:row.last_success,last_error:row.last_error,stale:!row.last_success||Date.now()-Date.parse(row.last_success)>60000}}
    if(name==='events')return store.events(id,a.subscription_id,a.after_seq,a.limit)
    if(name==='ack')return store.ack(id,a.subscription_id,a.through_seq)
    if(name==='delivery'){for(const key of leases.keys())if(key.startsWith(id+':'))leases.delete(key);return store.configure(id,a)}
  }
  handle=async(req)=>{
    try {
      if(closing)return Response.json({error:'daemon_stopping'},{status:503})
      const path=new URL(req.url).pathname
      if(req.method!=='POST')return Response.json({error:'method_not_allowed'},{status:405})
      if(path==='/health')return Response.json({pid:process.pid,profile:rt.profile,authentication_error:authError||authFailure})
      const body=await req.json() as any
      lastActive=Date.now()
      if(path==='/admin'&&body.operation==='clean')return Response.json(await clean())
      if(path==='/admin'&&body.operation==='stop') {setTimeout(()=>void shutdown(),50);return Response.json({state:'stopping',pid:process.pid})}
      if(path==='/session')return Response.json(store.session(body.id?body:undefined))
      const id=req.headers.get('x-consumer')??'',secret=req.headers.get('x-secret')??'',epoch=Number(req.headers.get('x-epoch'))
      store.authenticate(id,secret,epoch);store.heartbeat(id)
      if(path==='/heartbeat')return Response.json({state:'alive'})
      if(path==='/disconnect'){store.disconnect(id,epoch);for(const key of leases.keys())if(key.startsWith(id+':'))leases.delete(key);return Response.json({state:'disconnected'})}
      if(path==='/tool')return Response.json(await tool(id,body.name,body.arguments??{},epoch))
      if(authError||authFailure)throw new Error((authError||authFailure)!)
      if(path==='/attach') {
        const result=store.attach(id,body.mode)
        for(const key of leases.keys())if(key.startsWith(id+':'))leases.delete(key)
        leases.set(id+':'+result.lease,{mode:body.mode,cursor:{},seen:Date.now()})
        return Response.json(result)
      }
      if(path==='/detach'){store.detach(id,body.lease);leases.delete(id+':'+body.lease);return Response.json({state:'detached'})}
      if(path==='/validate'){store.validateLease(id,body.lease,body.mode);return Response.json({valid:true})}
      if(path==='/deliver') {
        store.validateLease(id,body.lease,body.mode)
        const lease=leases.get(id+':'+body.lease);if(!lease)throw new Error('unknown_delivery_lease')
        lease.seen=Date.now()
        const events=store.pending(id,lease.cursor)
        for(const row of events)for(const d of row.deliveries)lease.cursor[d.subscription_id]=d.seq
        return Response.json({events})
      }
      return Response.json({error:'unknown_route'},{status:404})
    }catch(error){return Response.json({error:fail(error)},{status:400})}
  }
  await writeFile(join(rt.dir,'daemon.json'),JSON.stringify({pid:process.pid,socket:rt.socket,started_at:new Date().toISOString()}),{mode:0o600})
  const shutdown=async()=>{
    if(closing)return;closing=true;clearInterval(timer)
    await gh.close();await queue;store.close();server.stop(true)
    const current=await lstat(rt.socket).catch(()=>null)
    if(current?.ino===socketIdentity.ino&&current.dev===socketIdentity.dev)await unlink(rt.socket).catch(()=>{})
    const metadata=join(rt.dir,'daemon.json')
    if(await readFile(metadata,'utf8').then(s=>JSON.parse(s).pid===process.pid).catch(()=>false))await unlink(metadata).catch(()=>{})
  }
  const timer=setInterval(()=>{
    if(closing)return
    for(const [key,lease]of leases)if(Date.now()-lease.seen>Number(process.env.GHC_DELIVERY_LEASE_MS??15000)) {
      const split=key.lastIndexOf(':');store.detach(key.slice(0,split),Number(key.slice(split+1)));leases.delete(key)
    }
    if(Date.now()-lastClean>60000&&!busy) {void clean().catch(()=>console.error('expired state cleanup failed'));lastClean=Date.now()}
    const active=store.activeTargets()
    if(active.length)lastActive=Date.now()
    if(!active.length&&Date.now()-lastActive>Number(process.env.GHC_IDLE_MS??300000))void shutdown()
    if(busy||!active.length)return
    busy=true
    void serial(async()=>{
      if(Date.now()-lastAuth>60000) {lastAuth=Date.now();for(const host of new Set(active.map(t=>t.host)))await auth(host)}
      if(authFailure)return
      for(const t of active) {
        if(closing||authError)break
        const row=store.get('SELECT next_poll FROM targets WHERE key=?',targetKey(t))
        if(Date.now()>=(process.env.GHC_POLL_MS?0:row?.next_poll??0))await collect(t)
      }
    }).catch(error=>{console.error('collector:',fail(error));store.run('UPDATE targets SET last_error=?',fail(error))}).finally(()=>{busy=false})
  },Number(process.env.GHC_POLL_MS??1000))
  let busy=false
  process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown())
  return {server,store,shutdown}
}

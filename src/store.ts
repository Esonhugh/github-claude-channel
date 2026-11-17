import { Database } from 'bun:sqlite'
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto'
import { deliveryMode, hash, normalizeSubscription, ruleKey, targetKey, type Evidence, type Rule, type Target } from './schema.ts'
import { changes, type Change } from './events.ts'
import type { Sample } from './gh.ts'

const uid=(prefix:string)=>prefix+'_'+randomUUID()
export class Store {
  db:Database
  constructor(path:string) {
    this.db=new Database(path,{create:true})
    const version=this.get('PRAGMA user_version').user_version
    if(version>1){this.db.close();throw new Error('database_schema_newer_than_this_plugin')}
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS consumers(id TEXT PRIMARY KEY,secret_hash TEXT NOT NULL,epoch INTEGER NOT NULL DEFAULT 0,connected INTEGER NOT NULL DEFAULT 0,last_seen INTEGER NOT NULL,evidence TEXT NOT NULL,mode TEXT NOT NULL DEFAULT 'unknown',delivery_epoch INTEGER NOT NULL DEFAULT 0,attached INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS watches(id TEXT PRIMARY KEY,consumer_id TEXT NOT NULL,rule_key TEXT NOT NULL,rule TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS active_rule ON watches(consumer_id,rule_key) WHERE state='active';
      CREATE TABLE IF NOT EXISTS targets(key TEXT PRIMARY KEY,target TEXT NOT NULL,sample TEXT,last_success TEXT,last_error TEXT,next_poll INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY,watch_id TEXT NOT NULL,consumer_id TEXT NOT NULL,target_key TEXT NOT NULL,events TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'active',acked_seq INTEGER NOT NULL DEFAULT 0,sent_seq INTEGER NOT NULL DEFAULT 0,next_seq INTEGER NOT NULL DEFAULT 1,oldest_seq INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,target_key TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries(sub_id TEXT NOT NULL,seq INTEGER NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(sub_id,seq),UNIQUE(sub_id,event_id));
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`)
    if(!this.all('PRAGMA table_info(subscriptions)').some(r=>r.name==='oldest_seq'))this.db.exec('ALTER TABLE subscriptions ADD COLUMN oldest_seq INTEGER NOT NULL DEFAULT 1')
    this.db.exec('PRAGMA user_version=1')
    // A restarted daemon cannot retain an active transport lease.
    this.db.exec('UPDATE consumers SET attached=0,connected=0,epoch=epoch+1,delivery_epoch=delivery_epoch+1')
    this.db.exec('UPDATE subscriptions SET sent_seq=acked_seq')
  }
  all(sql:string,...args:any[]):any[]{return this.db.query(sql).all(...args)}
  get(sql:string,...args:any[]):any{return this.db.query(sql).get(...args)}
  run(sql:string,...args:any[]){return this.db.query(sql).run(...args)}
  session(recovery?:{id:string;secret:string}) {
    if(recovery) {
      this.authenticate(recovery.id,recovery.secret)
      this.run('UPDATE consumers SET epoch=epoch+1,connected=1,last_seen=?,attached=0,delivery_epoch=delivery_epoch+1 WHERE id=?',Date.now(),recovery.id)
      this.run('UPDATE subscriptions SET sent_seq=acked_seq WHERE consumer_id=?',recovery.id)
      return {...recovery,epoch:this.get('SELECT epoch FROM consumers WHERE id=?',recovery.id).epoch}
    }
    const id=uid('consumer'),secret=randomBytes(32).toString('hex')
    this.run('INSERT INTO consumers(id,secret_hash,epoch,connected,last_seen,evidence) VALUES(?,?,1,1,?,?)',id,hash(secret),Date.now(),JSON.stringify({channels:'unknown',monitor:'unknown',evidence:'No host evidence provided'}))
    return {id,secret,epoch:1}
  }
  authenticate(id:string,secret:string,epoch?:number) {
    const c=this.get('SELECT * FROM consumers WHERE id=?',id)
    const expected=c?.secret_hash??'0'.repeat(64)
    if(typeof secret!=='string'||!timingSafeEqual(Buffer.from(hash(secret)),Buffer.from(expected))||!c||(epoch!==undefined&&epoch!==c.epoch))throw new Error('invalid_or_fenced_consumer')
    return c
  }
  heartbeat(id:string){this.run('UPDATE consumers SET last_seen=? WHERE id=?',Date.now(),id)}
  configure(id:string,e:Evidence) {
    const mode=deliveryMode(e)
    this.run('UPDATE consumers SET evidence=?,mode=?,delivery_epoch=delivery_epoch+1,attached=0 WHERE id=?',JSON.stringify(e),mode,id)
    return {mode,status:mode==='unknown'?'pending_confirmation':mode==='unavailable'?'delivery unavailable':'detached',evidence:e.evidence}
  }
  attach(id:string,mode:string) {
    const c=this.get('SELECT * FROM consumers WHERE id=?',id)
    if(c.mode!==mode||!['channel','monitor'].includes(mode))throw new Error('delivery_mode_not_authorized')
    this.run('UPDATE consumers SET attached=1,delivery_epoch=delivery_epoch+1 WHERE id=?',id)
    return {lease:this.get('SELECT delivery_epoch FROM consumers WHERE id=?',id).delivery_epoch,mode}
  }
  detach(id:string,lease?:number) {
    if(lease!==undefined)this.run('UPDATE consumers SET attached=0,delivery_epoch=delivery_epoch+1 WHERE id=? AND delivery_epoch=?',id,lease)
  }
  disconnect(id:string,epoch:number) {
    this.run('UPDATE consumers SET connected=0,last_seen=?,attached=0,delivery_epoch=delivery_epoch+1 WHERE id=? AND epoch=?',Date.now(),id,epoch)
  }
  validateLease(id:string,lease:number,mode:string) {
    const c=this.get('SELECT * FROM consumers WHERE id=?',id)
    if(!c?.attached||c.delivery_epoch!==lease||c.mode!==mode)throw new Error('fenced_delivery')
  }
  sample(key:string):Sample|undefined {const row=this.get('SELECT sample FROM targets WHERE key=?',key);return row?.sample?JSON.parse(row.sample):undefined}
  activeTargets():Target[] {
    const result=new Map<string,Target>()
    for(const row of this.all(`SELECT t.key,t.target,s.events FROM targets t JOIN subscriptions s ON s.target_key=t.key JOIN consumers c ON c.id=s.consumer_id WHERE s.state='active' AND (c.connected=1 OR c.attached=1) AND c.last_seen>?`,Date.now()-60000)) {
      const target=JSON.parse(row.target) as Target
      target.events=JSON.parse(row.events)
      const existing=result.get(row.key)
      if(existing)existing.events=[...new Set([...existing.events,...target.events])] as typeof existing.events
      else result.set(row.key,target)
    }
    return [...result.values()]
  }
  register(id:string,rule:Rule,samples:Map<string,Sample>) {
    return this.db.transaction(()=>{
      const existing=this.get("SELECT id FROM watches WHERE consumer_id=? AND rule_key=? AND state='active'",id,ruleKey(rule))
      if(existing)return {watch_id:existing.id,state:'already_subscribed',...this.watchDetail(id,existing.id)}
      const watch=uid('watch')
      this.run('INSERT INTO watches(id,consumer_id,rule_key,rule,created_at) VALUES(?,?,?,?,?)',watch,id,ruleKey(rule),JSON.stringify(rule),new Date().toISOString())
      for(const target of rule.targets) {
        const key=targetKey(target),sample=samples.get(key)!
        this.run('INSERT OR IGNORE INTO targets(key,target) VALUES(?,?)',key,JSON.stringify(target))
        this.commitSample(target,sample)
        this.run('INSERT INTO subscriptions(id,watch_id,consumer_id,target_key,events) VALUES(?,?,?,?,?)',uid('sub'),watch,id,key,JSON.stringify(target.events))
      }
      return {watch_id:watch,state:'subscribed',...this.watchDetail(id,watch)}
    })()
  }
  commitSample(target:Target,sample:Sample) {
    const key=targetKey(target),previous=this.sample(key)
    for(const change of changes(target,previous,sample))this.emit(target,change,sample.observed_at)
    let interval=60000
    if(target.kind==='run') {
      const entry=Object.entries(sample.records).find(([key])=>key.startsWith('run:')&&!key.includes('/'))
      const prefix=entry?.[0],run=entry?.[1]
      const steps=target.events.includes('step')||sample.meta?.action_events.includes('step')===true
      const children=target.events.includes('job')||steps||sample.meta?.action_events.includes('job')===true
      const finalSnapshots=[previous,sample].map(candidate=>{
        if(!prefix||!candidate||candidate.records[prefix]?.status!=='completed'||candidate.records[prefix]?.conclusion==null)return null
        if(children&&!candidate.meta?.action_events.includes('job'))return null
        if(steps&&!candidate.meta?.action_events.includes('step'))return null
        const rows=Object.entries(candidate.records).filter(([key])=>children&&key.startsWith(prefix+'/')&&(steps||!key.includes('/step:')))
        if(rows.some(([,row])=>row.status!=='completed'||row.conclusion==null))return null
        return hash([candidate.records[prefix].conclusion,rows.map(([key,row])=>[key,row.status,row.conclusion]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))])
      })
      const settled=finalSnapshots[0]!==null&&finalSnapshots[0]===finalSnapshots[1]
      interval=settled?(target.attempt==='latest'?300000:Number.MAX_SAFE_INTEGER):run?.status==='queued'?30000:15000
    }
    this.run('UPDATE targets SET sample=?,last_success=?,last_error=NULL,next_poll=? WHERE key=?',JSON.stringify(sample),sample.observed_at,interval===Number.MAX_SAFE_INTEGER?interval:Date.now()+interval,key)
  }
  emit(target:Target,change:Change,observed:string) {
    const key=targetKey(target)
    const event_id='evt_'+hash([target.host,target.repo,change.type,change.source_key,change.data])
    const subject=target.kind==='repository'?{kind:change.source_key.startsWith('pr:')?'pr':'issue',number:change.data.number}:target
    const payload={schema_version:1,event_id,type:change.type,host:target.host,repository:target.repo,subject,source_id:change.source_key,occurred_at:change.occurred_at,observed_at:observed,evidence:change.evidence,actor:change.actor,data:change.data}
    this.run('INSERT OR IGNORE INTO events(id,target_key,payload,created_at) VALUES(?,?,?,?)',event_id,key,JSON.stringify(payload),Date.now())
    for(const sub of this.all("SELECT s.*,w.rule FROM subscriptions s JOIN watches w ON w.id=s.watch_id WHERE s.target_key=? AND s.state='active'",key)) {
      const events:string[]=JSON.parse(sub.events)
      const rule=JSON.parse(sub.rule) as Rule
      if(!events.includes(change.family))continue
      if(change.family==='step'&&rule.delivery.detail!=='steps')continue
      if(change.family==='job'&&rule.delivery.detail==='summary')continue
      if(this.run('INSERT OR IGNORE INTO deliveries(sub_id,seq,event_id) VALUES(?,?,?)',sub.id,sub.next_seq,event_id).changes)this.run('UPDATE subscriptions SET next_seq=next_seq+1 WHERE id=?',sub.id)
    }
  }
  watchDetail(id:string,watch:string) {
    const c=this.get('SELECT mode,attached,evidence FROM consumers WHERE id=?',id)
    const subscriptions=this.all('SELECT s.*,t.target,t.last_success,t.last_error,t.next_poll FROM subscriptions s JOIN targets t ON t.key=s.target_key WHERE s.consumer_id=? AND s.watch_id=?',id,watch).map(s=>({subscription_id:s.id,target:JSON.parse(s.target),events:JSON.parse(s.events),state:s.last_error?'degraded':s.state,last_successful_poll:s.last_success,last_error:s.last_error,next_poll_at:s.next_poll,pending_deliveries:this.get('SELECT COUNT(*) AS n FROM deliveries WHERE sub_id=? AND seq>?',s.id,s.acked_seq).n,acked_seq:s.acked_seq,gap:s.acked_seq<s.oldest_seq-1?{earliest_seq:s.oldest_seq}:null}))
    const rule=JSON.parse(this.get('SELECT rule FROM watches WHERE id=? AND consumer_id=?',watch,id).rule) as Rule
    return {subscriptions,delivery:{mode:rule.delivery.mode==='pull'?'pull':c.mode,status:rule.delivery.mode==='pull'?'pull':c.mode==='unknown'?'pending_confirmation':c.mode==='unavailable'?'delivery unavailable':c.attached?'attached':'detached',evidence:JSON.parse(c.evidence).evidence}}
  }
  list(id:string,cursor='',limit=20,watch?:string) {
    const rows=this.all("SELECT * FROM watches WHERE consumer_id=? AND state='active' AND id>? AND (? IS NULL OR id=?) ORDER BY id LIMIT ?",id,cursor,watch??null,watch??null,limit+1)
    return {watches:rows.slice(0,limit).map(w=>({watch_id:w.id,description:JSON.parse(w.rule).description,...this.watchDetail(id,w.id)})),next_cursor:rows.length>limit?rows[limit-1].id:null,message:rows.length?'Current consumer subscriptions':'无订阅'}
  }
  unsubscribe(id:string,watch:string) {
    return this.db.transaction(()=>{
      const n=this.run("UPDATE watches SET state='cancelled' WHERE id=? AND consumer_id=? AND state='active'",watch,id).changes
      if(n)this.run("UPDATE subscriptions SET state='cancelled' WHERE watch_id=? AND consumer_id=?",watch,id)
      return {watch_id:watch,state:n?'unsubscribed':'already_absent'}
    })()
  }
  sub(id:string,sub:string) {const row=this.get('SELECT * FROM subscriptions WHERE id=? AND consumer_id=?',sub,id);if(!row)throw new Error('subscription_not_found');return row}
  events(id:string,sub:string,after:number,limit:number) {
    const s=this.sub(id,sub)
    if(after>s.next_seq-1)throw new Error('cursor_ahead')
    if(after<s.oldest_seq-1){this.run('UPDATE subscriptions SET sent_seq=MAX(sent_seq,?) WHERE id=?',s.oldest_seq-1,sub);return {subscription_id:sub,gap:{requested_after:after,earliest_seq:s.oldest_seq,message:'Retention gap. Reconcile snapshot and explicitly resume at earliest_seq - 1.'},events:[],next_seq:s.oldest_seq-1}}
    const rows=this.all('SELECT d.seq,e.payload FROM deliveries d JOIN events e ON e.id=d.event_id WHERE d.sub_id=? AND d.seq>? ORDER BY d.seq LIMIT ?',sub,after,limit)
    if(rows.length)this.run('UPDATE subscriptions SET sent_seq=MAX(sent_seq,?) WHERE id=?',rows.at(-1).seq,sub)
    return {subscription_id:sub,events:rows.map(r=>({seq:r.seq,event:JSON.parse(r.payload)})),next_seq:rows.at(-1)?.seq??after}
  }
  ack(id:string,sub:string,seq:number) {
    const s=this.sub(id,sub)
    if(seq>s.sent_seq)throw new Error('ack_exceeds_supplied_seq')
    this.run('UPDATE subscriptions SET acked_seq=MAX(acked_seq,?) WHERE id=?',seq,sub)
    return {subscription_id:sub,acked_seq:Math.max(s.acked_seq,seq)}
  }
  pending(id:string,cursors:Record<string,number>) {
    const grouped=new Map<string,{event:any;deliveries:any[]}>()
    for(const sub of this.all("SELECT s.* FROM subscriptions s JOIN watches w ON s.watch_id=w.id WHERE s.consumer_id=? AND s.state='active'",id)) {
      if((JSON.parse(this.get('SELECT rule FROM watches WHERE id=?',sub.watch_id).rule) as Rule).delivery.mode==='pull')continue
      const found=this.events(id,sub.id,Math.max(sub.acked_seq,cursors[sub.id]??0),50)
      if(found.gap) {
        const target=JSON.parse(this.get('SELECT target FROM targets WHERE key=?',sub.target_key).target)
        grouped.set('gap:'+sub.id,{event:{event_id:'gap_'+sub.id+'_'+found.next_seq,type:'delivery.gap',repository:target.repo,data:found.gap},deliveries:[{watch_id:sub.watch_id,subscription_id:sub.id,seq:found.next_seq}]})
      }
      for(const row of found.events){const g=grouped.get(row.event.event_id)??{event:row.event,deliveries:[]};g.deliveries.push({watch_id:sub.watch_id,subscription_id:sub.id,seq:row.seq});grouped.set(row.event.event_id,g)}
    }
    return [...grouped.values()]
  }
  close(){this.db.close()}
  clean(now=Date.now()) {
    return this.db.transaction(()=>{
      const cutoff=now-Number(process.env.GHC_RETENTION_MS??7*86400000)
      for(const row of this.all('SELECT d.sub_id,MAX(d.seq) AS last FROM deliveries d JOIN events e ON d.event_id=e.id WHERE e.created_at<? GROUP BY d.sub_id',cutoff))this.run('UPDATE subscriptions SET oldest_seq=MAX(oldest_seq,?) WHERE id=?',row.last+1,row.sub_id)
      this.run('DELETE FROM deliveries WHERE event_id IN (SELECT id FROM events WHERE created_at<?)',cutoff)
      this.run('DELETE FROM events WHERE created_at<?',cutoff)
      const expired=this.all('SELECT id FROM consumers WHERE connected=0 AND attached=0 AND last_seen<?',now-86400000).map(r=>r.id as string)
      for(const id of expired){this.run("UPDATE watches SET state='expired' WHERE consumer_id=?",id);this.run("UPDATE subscriptions SET state='expired' WHERE consumer_id=?",id);this.run('DELETE FROM consumers WHERE id=?',id)}
      this.db.exec("DELETE FROM targets WHERE key NOT IN (SELECT target_key FROM subscriptions WHERE state='active') AND key NOT IN (SELECT target_key FROM events)")
      return {expired_consumers:expired}
    })()
  }
}

import type { Target } from './schema.ts'

export class GhError extends Error {
  constructor(public status: number, public category: string, public retryAt?: number) { super(category + (status ? ` (HTTP ${status})` : '')) }
}
export type Sample = { observed_at:string; records:Record<string, Record<string, any>>; meta?:{action_events:('job'|'step')[]} }
export class GitHub {
  children = new Set<Bun.Subprocess>()
  remaining: number | null = null
  reset: number | null = null
  blockedUntil = 0
  private requests:number[]=[]
  private lastRequest=0
  private closed=false
  private cache=new Map<string,{etag:string;value:any}>()
  constructor(public executable = process.env.GHC_GH ?? 'gh') {}
  async request(host:string, endpoint:string): Promise<any> {
    if(this.closed)throw new GhError(0,'collector_closed')
    const allowed=(process.env.GHC_ALLOWED_HOSTS??process.env.GH_HOST??'github.com').split(',').map(h=>h.trim().toLowerCase())
    if(!allowed.includes(host.toLowerCase()))throw new GhError(0,'host_not_in_profile_allowlist')
    if(Date.now() < this.blockedUntil) throw new GhError(429, 'rate_limited', this.blockedUntil)
    this.requests=this.requests.filter(t=>Date.now()-t<3600000)
    if(this.requests.length>=Number(process.env.GHC_REQUESTS_PER_HOUR??3500)){this.blockedUntil=this.requests[0]!+3600000;throw new GhError(429,'local_request_budget_exhausted',this.blockedUntil)}
    const wait=Number(process.env.GHC_GH_INTERVAL_MS??100)-(Date.now()-this.lastRequest)
    if(wait>0)await Bun.sleep(wait)
    if(this.closed)throw new GhError(0,'collector_closed')
    this.lastRequest=Date.now();this.requests.push(this.lastRequest)
    const cacheKey=host+':'+endpoint,cached=this.cache.get(cacheKey)
    const p = Bun.spawn([this.executable, 'api', '--hostname', host, '--method', 'GET', '--include',...(cached?['--header','If-None-Match: '+cached.etag]:[]),endpoint], {
      stdin:'ignore', stdout:'pipe', stderr:'pipe', env:{...process.env, GH_PROMPT_DISABLED:'1', GH_PAGER:'cat', GH_DEBUG:'', DEBUG:''},
    })
    this.children.add(p)
    let timeout = false
    const timer = setTimeout(()=> {timeout=true; p.kill()}, Number(process.env.GHC_GH_TIMEOUT_MS ?? 30000))
    async function bounded(stream:ReadableStream<Uint8Array>) {
      const reader=stream.getReader(); const parts:Uint8Array[]=[]; let length=0
      while(true) {const {value,done}=await reader.read(); if(done)break; length+=value.length; if(length>16*1024*1024){p.kill();throw new GhError(0,'gh_output_limit')} parts.push(value)}
      return Buffer.concat(parts).toString('utf8')
    }
    try {
      const [out,,exit] = await Promise.all([bounded(p.stdout as ReadableStream<Uint8Array>),bounded(p.stderr as ReadableStream<Uint8Array>),p.exited])
      if(timeout) throw new GhError(0,'gh_timeout')
      const split = out.search(/\r?\n\r?\n/)
      const headers = split >= 0 ? out.slice(0,split) : ''
      const body = split >= 0 ? out.slice(split).trim() : out.trim()
      const status=Number(/^HTTP\/\S+\s+(\d+)/.exec(headers)?.[1] ?? (exit===0?200:0))
      const header = (name:string) => new RegExp(`^${name}:\\s*(.+)$`,'im').exec(headers)?.[1]?.trim()
      if(header('x-ratelimit-remaining')) this.remaining=Number(header('x-ratelimit-remaining'))
      if(header('x-ratelimit-reset')) this.reset=Number(header('x-ratelimit-reset'))*1000
      const primaryLimit=Number(header('x-ratelimit-limit')??0)
      if(primaryLimit>0&&this.remaining!==null&&this.remaining<=Math.floor(primaryLimit*0.3)&&this.reset)this.blockedUntil=this.reset
      if(this.remaining !== null && this.remaining <= 5 && this.reset) this.blockedUntil=this.reset
      if(status===429 || (status===403 && (header('retry-after') || this.remaining===0))) {
        this.blockedUntil=Math.max(Date.now()+60000, header('retry-after')?Date.now()+Number(header('retry-after'))*1000:0,this.remaining===0?(this.reset??0):0)
        throw new GhError(status,'rate_limited',this.blockedUntil)
      }
      if(status===304){if(cached)return cached.value;throw new GhError(304,'unexpected_not_modified')}
      if(status>=400 || exit!==0) throw new GhError(status, status===401?'authentication_failed':status===404?'not_found_or_invisible':status===403?'forbidden':'gh_failed')
      let value:any
      try{value=JSON.parse(body)}catch{throw new GhError(status,'invalid_gh_json')}
      const etag=header('etag')
      if(etag){if(this.cache.size>=1000)this.cache.delete(this.cache.keys().next().value!);this.cache.set(cacheKey,{etag,value})}
      return value
    } finally {clearTimeout(timer);this.children.delete(p); if(p.exitCode===null){p.kill();await p.exited}}
  }
  async pages(host:string, endpoint:string, field?:string):Promise<any[]> {
    const all:any[]=[]
    let bytes=0
    for(let page=1;page<=1000;page++) {
      const data=await this.request(host,endpoint+(endpoint.includes('?')?'&':'?')+`per_page=100&page=${page}`)
      const rows=field?data[field]:data
      if(!Array.isArray(rows)) throw new GhError(0,'invalid_list_shape')
      bytes+=Buffer.byteLength(JSON.stringify(rows))
      if(bytes>32*1024*1024)throw new GhError(0,'collection_size_limit_no_watermark_advance')
      all.push(...rows)
      if(rows.length<100) return all
    }
    throw new GhError(0,'pagination_limit_no_watermark_advance')
  }
  async sample(t:Target, previous?:Sample):Promise<Sample> {
    const root=`repos/${t.repo}`; const host=t.host
    const records:Sample['records']={}
    let jobsCollected=false,stepsComplete=true
    const put=(key:string, value:any)=>{records[key]=value}
    const runJobs=async(run:any, prefix:string, attempt:number)=>{
      if(!t.events.includes('job' as never)&&!t.events.includes('step' as never))return
      const jobs=await this.pages(host,`${root}/actions/runs/${run.id}/attempts/${attempt}/jobs`,'jobs')
      jobsCollected=true
      for(const job of jobs) {
        put(`${prefix}/job:${job.id}`, {...job, steps:undefined, _run_id:String(run.id),_attempt:attempt})
        if(t.events.includes('step' as never)) {
          if(!Array.isArray(job.steps))stepsComplete=false
          for(const step of job.steps??[])put(`${prefix}/job:${job.id}/step:${step.number}`,{...step,_job_id:String(job.id),_run_id:String(run.id),_attempt:attempt})
        }
      }
    }
    if(t.kind==='run') {
      const run=await this.request(host,`${root}/actions/runs/${t.run_id}${t.attempt==='latest'?'':`/attempts/${t.attempt}`}`)
      if(String(run.id)!==t.run_id||!Number.isInteger(run.run_attempt??1))throw new GhError(0,'invalid_run_identity')
      const attempt=Number(run.run_attempt??1); const prefix=`run:${run.id}:attempt:${attempt}`
      put(prefix,run); await runJobs(run,prefix,attempt)
    } else if(t.kind==='workflow') {
      const endpoint=`${root}/actions/workflows/${t.workflow_id}/runs`+(t.branch?`?branch=${encodeURIComponent(t.branch)}`:'')
      for(const run of await this.pages(host,endpoint,'workflow_runs')) {
        const attempt=Number(run.run_attempt??1);const prefix=`run:${run.id}:attempt:${attempt}`
        put(prefix,run)
        await runJobs(run,prefix,attempt)
      }
    } else if(t.kind==='repository') {
      const since=previous?'&since='+encodeURIComponent(new Date(Date.parse(previous.observed_at)-120000).toISOString()):''
      Object.assign(records,previous?.records??{})
      for(const issue of await this.pages(host,`${root}/issues?state=all&sort=updated&direction=asc${since}`)) {
        const kind=issue.pull_request?'pr':'issue'
        if(!t.objects.includes(kind))continue
        put(`${kind}:${issue.number}`,kind==='pr'?await this.request(host,`${root}/pulls/${issue.number}`):issue)
      }
    } else {
      const kind=t.kind
      put(`${kind}:${t.number}`,await this.request(host,`${root}/${kind==='pr'?'pulls':'issues'}/${t.number}`))
      if(t.events.includes('comments'))for(const row of await this.pages(host,`${root}/issues/${t.number}/comments`))put(`comment:${row.id}`,row)
      if(kind==='pr'&&t.events.includes('reviews' as never))for(const row of await this.pages(host,`${root}/pulls/${t.number}/reviews`))if(row.state!=='PENDING')put(`review:${row.id}`,row)
      if(kind==='pr'&&t.events.includes('review_comments' as never))for(const row of await this.pages(host,`${root}/pulls/${t.number}/comments`))put(`review_comment:${row.id}`,row)
      if(t.events.includes('lifecycle'))for(const row of await this.pages(host,`${root}/issues/${t.number}/timeline`))if(['closed','reopened','merged','ready_for_review','convert_to_draft'].includes(row.event))put(`timeline:${row.id??`${row.event}:${row.created_at}`}`,row)
    }
    const action_events:('job'|'step')[]=jobsCollected?['job']:[]
    if(jobsCollected&&stepsComplete&&t.events.includes('step' as never))action_events.push('step')
    return {records, observed_at:new Date().toISOString(),meta:{action_events}}
  }
  async close(){this.closed=true;for(const p of this.children)p.kill();await Promise.all([...this.children].map(p=>p.exited));this.children.clear()}
}

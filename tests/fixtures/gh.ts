#!/usr/bin/env bun
import { appendFileSync, readFileSync } from 'node:fs'
const args=process.argv.slice(2)
const source=JSON.parse(readFileSync(process.env.GHC_FIXTURE_FILE!,'utf8'))
const endpoint=args.at(-1)!
if(args[0]!=='api'||args[args.indexOf('--method')+1]!=='GET')throw new Error('fake gh only accepts explicit GET')
const url=new URL('https://fixture.invalid/'+endpoint)
if(process.env.GHC_TRACE_FILE)appendFileSync(process.env.GHC_TRACE_FILE,JSON.stringify({endpoint,method:'GET',pid:process.pid,conditional:args.includes('--header')})+'\n')
const configured=source[url.pathname.slice(1)]
if(configured?.delay_ms)await Bun.sleep(configured.delay_ms)
const conditional=configured?.etag&&args.includes('If-None-Match: '+configured.etag)
const status=conditional?304:configured?.status??(configured===undefined&&url.pathname!=='/user'?404:200)
let data=configured?.data??(url.pathname==='/user'?{id:100,login:'fixture-user'}:{message:'fixture route missing'})
const page=Number(url.searchParams.get('page')??1),size=Number(url.searchParams.get('per_page')??100)
if(Array.isArray(data))data=data.slice((page-1)*size,page*size)
else if(data.jobs)data={...data,jobs:data.jobs.slice((page-1)*size,page*size)}
else if(data.workflow_runs)data={...data,workflow_runs:data.workflow_runs.slice((page-1)*size,page*size)}
process.stdout.write(`HTTP/2 ${status}\r\nx-ratelimit-remaining: ${configured?.remaining??4500}\r\nx-ratelimit-reset: ${Math.floor(Date.now()/1000)+3600}\r\n${configured?.etag?'etag: '+configured.etag+'\r\n':''}${configured?.retry_after?'retry-after: '+configured.retry_after+'\r\n':''}\r\n`+(status===304?'':JSON.stringify(data)))
process.exitCode=status>=400?1:0

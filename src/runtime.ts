import { mkdir, chmod, readFile, writeFile, stat, lstat, appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { hash } from './schema.ts'

export function runtime() {
  const root=resolve(process.env.GHC_STATE_DIR??join(homedir(),'.local/state/github-claude-channel'))
  const configDir=resolve(process.env.GH_CONFIG_DIR??join(process.env.XDG_CONFIG_HOME??join(homedir(),'.config'),'gh'))
  const profile=hash([process.env.GHC_PROFILE??'default',configDir,process.env.GH_HOST??'',process.env.GH_TOKEN??'',process.env.GITHUB_TOKEN??'',process.env.GH_ENTERPRISE_TOKEN??'',process.env.GITHUB_ENTERPRISE_TOKEN??'',process.env.GHC_GH??'gh',process.env.GHC_ALLOWED_HOSTS??'']).slice(0,20)
  const dir=join(root,profile)
  const socket=join('/tmp',`ghc-${process.getuid?.()??'user'}-${hash([root,profile]).slice(0,20)}.sock`)
  return {root,profile,dir,socket}
}
export async function secureDir(dir:string) {await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700)}
export async function rpc(path:string,body:any={},session?:Session):Promise<any> {
  const socketPath=session?.socket??runtime().socket
  const socket=await lstat(socketPath)
  if(!socket.isSocket()||(process.getuid&&socket.uid!==process.getuid())||(socket.mode&0o077)!==0)throw new Error('daemon_socket_must_be_private_and_owned')
  const res=await fetch('http://localhost'+path,{unix:socketPath,method:'POST',headers:{'content-type':'application/json',...(session?{'x-consumer':session.id,'x-secret':session.secret,'x-epoch':String(session.epoch)}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(Number(process.env.GHC_IPC_TIMEOUT_MS??180000))})
  const value=await res.json() as any
  if(!res.ok)throw new Error(value.error??'daemon_request_failed')
  return value
}
export type Session={id:string;secret:string;epoch:number;file?:string;socket?:string}
export async function ensureDaemon() {
  try {await rpc('/health');return}catch{}
  const {dir,socket}=runtime();await secureDir(dir)
  // Binding the socket is the single-winner primitive. Never unlink an unresponsive existing socket here.
  const entry=process.argv[1]!
  const logfile=join(dir,'daemon.log')
  const fd=openSync(logfile,'a',0o600)
  const child=spawn(process.execPath,[entry,'daemon'],{env:process.env,detached:true,stdio:['ignore',fd,fd]})
  child.unref();closeSync(fd)
  await appendFile(join(dir,'launches.jsonl'),JSON.stringify({pid:child.pid,started_at:new Date().toISOString()})+'\n',{mode:0o600})
  const until=Date.now()+10000
  while(Date.now()<until){try{await rpc('/health');return}catch{await Bun.sleep(50)}}
  throw new Error(`daemon_start_failed; inspect ${logfile}; socket=${socket}. Existing sockets are not removed automatically.`)
}
export async function loadSession(file:string):Promise<Session> {
  const st=await stat(file)
  if((st.mode&0o077)!==0 || (process.getuid&&st.uid!==process.getuid()))throw new Error('recovery_file_must_be_private_and_owned')
  const s=JSON.parse(await readFile(file,'utf8'))
  if(typeof s.id!=='string'||typeof s.secret!=='string'||!Number.isInteger(s.epoch))throw new Error('invalid_recovery_file')
  if(s.socket!==undefined&&(typeof s.socket!=='string'||!s.socket.startsWith('/')||s.socket.includes('\0')))throw new Error('invalid_recovery_socket')
  return s
}
export async function openSession() {
  let file=process.env.GHC_CONSUMER_FILE
  let recovered:Session|undefined
  if(file&&await Bun.file(file).exists()) recovered=await loadSession(file)
  if(recovered?.socket&&recovered.socket!==runtime().socket)throw new Error('recovery_file_belongs_to_different_profile')
  await ensureDaemon()
  const s=await rpc('/session',recovered?{id:recovered.id,secret:recovered.secret}:{}) as Session
  s.socket=runtime().socket
  file??=join(runtime().dir,'consumers',s.id+'.json')
  await mkdir(resolve(file,'..'),{recursive:true,mode:0o700});await writeFile(file,JSON.stringify(s),{mode:0o600});await chmod(file,0o600)
  return {...s,file}
}

import { hash, type Target } from './schema.ts'
import type { Sample } from './gh.ts'

export type Change = { type:string; family:string; source_key:string; evidence:'source_record'|'snapshot_diff'; occurred_at:string|null; actor?:unknown; data:Record<string, any> }
export function changes(t:Target, before:Sample|undefined, after:Sample):Change[] {
  if(!before)return []
  const out:Change[]=[]
  function emit(type:string,family:string,key:string,data:any,source=false) {
    const modified=/\.(edited|changed)$/.test(type)
    out.push({type,family,source_key:key,evidence:source?'source_record':'snapshot_diff',occurred_at:source?(modified?(data.updated_at??null):(data.created_at??data.submitted_at??null)):null,actor:source?(data.actor??(modified?undefined:data.user)):undefined,data})
  }
  const timelineTypes=new Set<string>()
  for(const [key,row] of Object.entries(after.records))if(key.startsWith('timeline:')&&!before.records[key]) {
    const suffix=({closed:'closed',reopened:'reopened',merged:'merged',ready_for_review:'ready_for_review',convert_to_draft:'converted_to_draft'} as Record<string,string>)[row.event]
    if(!suffix)continue
    // GitHub records closed + merged for a merge. One merged event is sufficient.
    if(row.event==='closed'&&Object.values(after.records).some(r=>r.event==='merged'&&r.created_at===row.created_at))continue
    const type=`${t.kind}.${suffix}`;timelineTypes.add(type);emit(type,'lifecycle',key,row,true)
  }
  for(const [key,row] of Object.entries(after.records)) {
    if(key.startsWith('timeline:'))continue
    const old=before.records[key]
    if(key.includes('/step:')||key.includes('/job:')||key.startsWith('run:')) {
      const family=key.includes('/step:')?'step':key.includes('/job:')?'job':'run'
      if(!old || old.status!==row.status || old.conclusion!==row.conclusion) {
        emit(`actions.${family}.${!old&&family==='run'?'discovered':family==='run'&&row.status==='completed'?'completed':'changed'}`,family,key,row)
        if(!old&&family==='run'&&row.status==='completed')emit('actions.run.completed','run',key,row)
      }
      continue
    }
    if(key.startsWith('comment:')||key.startsWith('review:')||key.startsWith('review_comment:')) {
      const family=key.startsWith('review_comment:')?'review_comments':key.startsWith('review:')?'reviews':'comments'
      if(!old || hash([old.body,old.state,old.updated_at])!==hash([row.body,row.state,row.updated_at])) {
        const name=family==='reviews'?'review':family==='review_comments'?'review_comment':'comment'
        emit(`${t.kind}.${name}.${!old?(family==='reviews'?'submitted':'created'):(family==='reviews'?'changed':'edited')}`,family,key,row,true)
      }
      continue
    }
    const kind=key.startsWith('pr:')?'pr':'issue'
    if(!old) {
      if(Date.parse(row.created_at??'')>=Date.parse(before.observed_at)-120000)emit(`${kind}.opened`,'lifecycle',key,row,true)
      continue
    }
    const previousState=old.merged?'merged':old.state
    const nextState=row.merged?'merged':row.state
    if(previousState!==nextState) {
      const suffix=nextState==='merged'?'merged':nextState==='closed'?'closed':'reopened'
      if(!timelineTypes.has(`${kind}.${suffix}`))emit(`${kind}.${suffix}`,'lifecycle',key,row)
    }
    if(kind==='pr') {
      if(old.draft!==row.draft&&!timelineTypes.has(`pr.${row.draft?'converted_to_draft':'ready_for_review'}`))emit(`pr.${row.draft?'converted_to_draft':'ready_for_review'}`,'lifecycle',key,row)
      if(old.head?.sha!==row.head?.sha)emit('pr.head.changed','lifecycle',key,{...row,previous_head_sha:old.head?.sha})
    }
  }
  return out
}

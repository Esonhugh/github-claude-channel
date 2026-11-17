import { expect, test } from 'bun:test'
import { normalizeSubscription } from '../src/schema.ts'

test('canonical subscription ignores target order and duplicate entries', () => {
  const a = { kind: 'issue', repo: 'owner/repo', number: 17, events: ['comments', 'lifecycle'] }
  const b = { kind: 'run', repo: 'owner/repo', run_id: '123', events: ['run'] }
  expect(normalizeSubscription({ targets: [a, b, a] })).toEqual(normalizeSubscription({ targets: [b, a] }))
})

test('GitHub path and event family boundaries are validated', () => {
  expect(() => normalizeSubscription({ targets: [{kind:'issue', repo:'../secrets', number:1}] })).toThrow()
  expect(() => normalizeSubscription({ targets: [{kind:'issue', repo:'o/r', number:1, events:['step']}] })).toThrow()
  expect(() => normalizeSubscription({targets:[{kind:'issue',repo:'owner/..',number:1}]})).toThrow()
  expect(normalizeSubscription({targets:[{kind:'issue',repo:'owner/.github',number:1}]}).targets[0]!.repo).toBe('owner/.github')
})
test('same target identity merges event families before canonical deduplication, in either order',()=>{
  const comments={kind:'issue',repo:'o/r',number:1,events:['comments']}
  const lifecycle={kind:'issue',repo:'o/r',number:1,events:['lifecycle']}
  const merged=normalizeSubscription({targets:[{...comments,events:['comments','lifecycle']}]})
  expect(normalizeSubscription({targets:[comments,lifecycle]})).toEqual(merged)
  expect(normalizeSubscription({targets:[lifecycle,comments]})).toEqual(merged)
})

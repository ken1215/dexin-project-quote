/**
 * 草稿暫存的自我檢查。
 * 執行：node --experimental-strip-types src/lib/draftStorage.test.ts
 */
import assert from 'node:assert/strict'
import { decodeDraft, draftKey, encodeDraft } from './draftStorage.ts'
import type { DraftQuote } from '../types.ts'

const draft: DraftQuote = {
  project: '3F 復健科天花板修繕', dept: '工務處-黃耀輝', contact: '',
  quote_date: '2026-09-13', status: 'draft',
  sections: [{ key: 'k1', title: '裝修工程', lines: [] }],
}

// ── 1. key 要同時綁使用者與單據，換人或換單都不得互相汙染 ────────
assert.equal(draftKey('u1'), 'dexin-quote-draft:u1:new')
assert.equal(draftKey('u1', 'q1'), 'dexin-quote-draft:u1:q1')
assert.notEqual(draftKey('u1', 'q1'), draftKey('u2', 'q1'))
assert.notEqual(draftKey('u1'), draftKey('u1', 'q1'))

// ── 2. 編解碼往返 ──────────────────────────────────────────────
{
  const raw = encodeDraft(draft, 1_760_000_000_000)
  const back = decodeDraft(raw)
  assert.ok(back)
  assert.equal(back.savedAt, 1_760_000_000_000)
  assert.deepEqual(back.draft, draft)
}

// ── 3. 壞資料一律回 null，不得讓畫面炸掉 ────────────────────────
assert.equal(decodeDraft(null), null)
assert.equal(decodeDraft(''), null)
assert.equal(decodeDraft('not json'), null, '亂碼要吞掉')
assert.equal(decodeDraft('{"savedAt":1}'), null, '缺 draft 要當作沒有')
assert.equal(decodeDraft('{"draft":{}}'), null, '缺 savedAt 要當作沒有')
assert.equal(decodeDraft('[]'), null, '型別不對要當作沒有')

// ── 4. 不得暫存任何機敏欄位 ────────────────────────────────────
{
  const raw = encodeDraft(draft, 1)
  for (const bad of ['password', 'token', 'apikey', 'access_token']) {
    assert.equal(raw.toLowerCase().includes(bad), false, `暫存內容不得含 ${bad}`)
  }
}

console.log('draftStorage.ts 自我檢查全數通過')

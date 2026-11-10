#!/usr/bin/env node
// Sector upgrades: every `UpgradeSectorQuality` message on this network (the miner method FIP-0118 §1.2 adds, number 37,
// which raises committed-capacity sectors to the 10x quality against a pledge top-up), with what each one added to the
// miner's power and pledge. The method emits no event (decided 2026-08-25), so the trace is the message and its two
// subcalls to f04: UpdateClaimedPower (QualityAdjustedDelta, bytes) and UpdatePledgeTotal (the pledge delta, attoFIL).
// Source: Filfox's public API. Written to <dataDir>/upgrades.json and committed with the record; the page sums it.
// Cached per message cid, so a run fetches only the new messages; a failed Filfox read keeps the last good file.
// Molly's question (2026-11-10): how many SPs converted CC sectors to 10x, and how much extra FIL they locked.
// ponytail: Filfox is the only source, with no node cross-check in the job. One message was replayed by hand on Glif
// (Filecoin.StateReplay, 2026-11-10): f0137489 at height 6531055, 2.81 TiB QAP, 25.4378 FIL, same as Filfox.
// Usage: node bin/upgrades.js config/mainnet.json
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { epochToTime } from '../lib/chain.js'

const cfg = JSON.parse(readFileSync(process.argv[2] ?? 'config/mainnet.json', 'utf8'))
const API = cfg.network === 'mainnet' ? 'https://filfox.info/api/v1' : 'https://calibration.filfox.info/api/v1'
const path = join(cfg.dataDir, 'upgrades.json')
const data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { messages: {}, miners: {} }
const get = async (p) => {
  const r = await fetch(API + p, { headers: { 'user-agent': 'solstice-watchtower (github.com/FilOzone/solstice-watchtower)' } }) // Filfox answers 403 to a bare client
  if (!r.ok) throw new Error(`${r.status} on ${p}`)
  return r.json()
}

// 1. the list, newest first; stop at the first page with nothing new (a list that cannot be read ends the run here, file untouched)
const listed = []
for (let page = 0; ; page++) {
  const { messages, totalCount } = await get(`/message/list?pageSize=100&page=${page}&method=UpgradeSectorQuality`)
  listed.push(...messages)
  if (!messages.length || listed.length >= totalCount || messages.every((m) => data.messages[m.cid])) break
}

// 2. the two f04 subcalls of each new successful message; a message whose subcalls could not be read is tried again next run
let unread = 0
for (const m of listed) {
  if (data.messages[m.cid]) continue
  const row = { height: m.height, time: epochToTime(cfg, m.height), miner: m.to, exitCode: m.receipt.exitCode }
  if (m.receipt.exitCode === 0) {
    try {
      const sub = await get(`/message/${m.cid}/subcalls`)
      const f04 = (name) => sub.find((s) => s.to === 'f04' && s.method === name).decodedParams
      row.qapDeltaBytes = f04('UpdateClaimedPower').QualityAdjustedDelta
      row.pledgeDeltaAttoFil = f04('UpdatePledgeTotal')
    } catch (err) { console.log(`${m.cid}: ${err.message.slice(0, 120)}`); unread++; continue }
  }
  data.messages[m.cid] = row
}

// 3. owner and sector size of each new miner
for (const miner of new Set(Object.values(data.messages).map((r) => r.miner))) {
  if (data.miners[miner]) continue
  try {
    const { miner: info } = await get(`/address/${miner}`)
    data.miners[miner] = { owner: info.owner.address, sectorSize: info.sectorSize }
  } catch (err) { console.log(`${miner}: ${err.message.slice(0, 120)}`); unread++ }
}

const messages = Object.fromEntries(Object.entries(data.messages).sort(([, a], [, b]) => a.height - b.height))
writeFileSync(path, JSON.stringify({ network: cfg.network, lastRun: new Date().toISOString(), source: `${API}/message/list?method=UpgradeSectorQuality, then /message/<cid>/subcalls and /address/<miner>`, unread, messages, miners: data.miners }, null, 2))
console.log(`${cfg.network} upgrades: ${listed.length} listed, ${Object.keys(messages).length} in the file, ${unread} not read this run -> ${path}`)

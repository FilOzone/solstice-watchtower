#!/usr/bin/env node
// Backup cranker: sends the two permissionless Solstice calls when they are due and nobody else sent them.
//   submitShares(q)       on the SRA, once quarter q is bound and lastSubmittedQuarter < q
//   quarterlyGateCheck()  on the SWA, once the next quarter is bound and the hold is over
// Each call is simulated first (Filecoin.StateCall); a call that would revert is never sent, so a run with nothing due
// costs nothing. Backup, not a race: a call is sent only when its simulation has passed for CRANK_DELAY epochs
// (30 minutes on calibnet), which leaves the primary cranker (decentramike/solstice-cranker) time to act first.
// The "possible since" epoch is kept in <dataDir>/crank.json between runs.
// The sender is the network's one f1 account (lib/sender.js), the same one that sends the f02 Claim: each call goes
// out as a native InvokeEVM message to the contract (an f1 cannot sign an Ethereum transaction). Without SENDER_KEY,
// with a placeholder in the config, or while the sender has no FIL, the run is a dry run.
// --now skips the delay (for a manual test: the call is sent as soon as its simulation passes).
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, http, encodeFunctionData } from 'viem'
import { RPC } from 'iso-filecoin/rpc'
import { from as fromAddress } from 'iso-filecoin/address'
import { abi, decodeRevert } from '../lib/evm.js'
import { makeRpc } from '../lib/chain.js'
import { prepareSender, isoNetwork, INVOKE_EVM, invokeEvmParams, evmReturnHex, lotusMessage, signAndPush, waitForMessage } from '../lib/sender.js'

const cfg = JSON.parse(readFileSync(process.argv[2] ?? 'config/calibnet.json', 'utf8'))
const DELAY = process.argv.includes('--now') ? 0 : (cfg.crankDelayEpochs ?? 60) // 60 = 30 minutes at 30 s per epoch
const pub = createPublicClient({ transport: http(cfg.rpcUrl) })
const rpc = makeRpc(cfg.rpcUrl)
const sender = await prepareSender(cfg, rpc)
const { why, simFrom } = sender
const statePath = join(cfg.dataDir, 'crank.json')
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { possibleSince: {} }

const head = Number(await pub.getBlockNumber())
const word = async (address, slot) => BigInt(await pub.getStorageAt({ address, slot }))
// SRA: SraStorageQuarter at QUARTER_SLOT, lastSubmittedQuarter in the low 8 bytes (SraStorage.sol).
const lastSubmitted = Number((await word(cfg.sra, '0x347e624280399e1e720d839edbd7cd00c80c69bf34cd8ee59e27f691732af300')) & 0xffffffffffffffffn)
// SWA: GateParamsInfo at GATE_PARAMS_SLOT: lastCheckedQuarter, then target.base, target.stepRatio, steps (GateParams.sol).
const GATE = 0xf9abab00248d945495524c8caf6be2b837274c1becd1964fb3775f62fd6e4600n
const lastChecked = Number(await word(cfg.swa, '0x' + GATE.toString(16)))
const steps = Number(await word(cfg.swa, '0x' + (GATE + 3n).toString(16)))
const bound = (q) => cfg.activationEpoch + q * cfg.epochsPerQuarter + cfg.postPeriod + cfg.verificationWindow // quarter q binds here
const quarterNow = Math.floor((head - cfg.activationEpoch) / cfg.epochsPerQuarter) + 1
console.log(`${cfg.network} epoch ${head} (quarter ${quarterNow}) · lastSubmittedQuarter ${lastSubmitted} · gate lastCheckedQuarter ${lastChecked}, steps ${steps} · ${why || 'sender ' + sender.address}`)

// The calls that may be due. submitShares(q) for the newest bound quarter the SRA has not submitted (the SRA counts
// skipped quarters as submitted when a later one lands); quarterlyGateCheck if the quarter it would read is bound.
const due = []
for (let q = lastSubmitted + 1; q < quarterNow; q++) if (head >= bound(q)) due.push({ name: 'submitShares', to: cfg.sra, args: [BigInt(q)], key: `submitShares(${q})` })
if (steps < 8 && head >= bound(lastChecked + 1)) due.push({ name: 'quarterlyGateCheck', to: cfg.swa, args: [], key: `quarterlyGateCheck(${lastChecked + 1})` })
if (!due.length) console.log('nothing due')

const iso = new RPC({ api: cfg.rpcUrl, network: isoNetwork(cfg) })
for (const call of due) {
  // The exact message that would be sent, run against the current state: a revert comes back as exit code 33 with the
  // revert data as the return, decoded with the contracts' ABI.
  const message = { to: fromAddress(call.to, isoNetwork(cfg)).toString(), method: INVOKE_EVM, params: invokeEvmParams(encodeFunctionData({ abi, functionName: call.name, args: call.args })) }
  const { MsgRct } = await rpc('Filecoin.StateCall', [lotusMessage({ ...message, from: simFrom }), null])
  if (MsgRct.ExitCode !== 0) { delete state.possibleSince[call.key]; console.log(`${call.key}: not possible yet (${MsgRct.ExitCode === 33 ? decodeRevert(evmReturnHex(MsgRct.Return)) : 'exit code ' + MsgRct.ExitCode})`); continue }
  const since = state.possibleSince[call.key] ??= head
  const waited = head - since
  if (waited < DELAY) { console.log(`${call.key}: possible since epoch ${since}, waiting for the primary cranker (${DELAY - waited} epochs left)`); continue }
  if (why) { console.log(`${call.key}: would send now (dry run)`); continue }
  const cid = await signAndPush(iso, sender.account, message)
  console.log(`${call.key}: sent ${cid}`)
  delete state.possibleSince[call.key] // a message that has not landed yet is not sent again before another full delay
  const landed = await waitForMessage(rpc, cid)
  if (!landed) { console.log(`${call.key}: not on chain after 3 minutes; the next run checks again`); continue }
  const { ExitCode, Return } = landed.receipt
  console.log(`${call.key}: ${ExitCode === 0 ? 'success' : `failed, exit code ${ExitCode}${ExitCode === 33 ? ' ' + decodeRevert(evmReturnHex(Return)) : ''}`} at epoch ${landed.height}`)
}
for (const k of Object.keys(state.possibleSince)) if (!due.some((c) => c.key === k)) delete state.possibleSince[k] // done by someone else, or no longer due
writeFileSync(statePath, JSON.stringify({ possibleSince: state.possibleSince, lastRun: new Date().toISOString(), head }, null, 2))

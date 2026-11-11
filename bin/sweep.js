#!/usr/bin/env node
// ONE-TIME, delete after use (with .github/workflows/sweep.yml): moves the FIL of the two old watchtower accounts of
// one network to the new sender (cfg.wallets["sender (watchtower backup)"], an f1), minus gas.
//   1. the old Claim account (f1, key OLD_CLAIM_KEY): a plain native send. It goes first: the new f1 has no actor
//      until it first receives FIL, and this send creates it.
//   2. the old crank account (f410, key OLD_CRANK_KEY): an f410 account can only send Ethereum transactions, and an
//      Ethereum transaction cannot name an f1 address, so the FIL goes through the FilForwarder contract,
//      forward(bytes destination) with the f1 address bytes, which sends it on as a native transfer.
// Without --send it only prints what it would do. It refuses while the destination is a placeholder or not an f1 of
// this network, and refuses a key that is not the key of the expected old account.
//   node bin/sweep.js config/<network>.json [--send]
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { RPC } from 'iso-filecoin/rpc'
import { Message } from 'iso-filecoin/message'
import { accountFromPrivateKey, signMessage } from 'iso-filecoin/wallet'
import { fromString } from 'iso-filecoin/address'
import { makeRpc } from '../lib/chain.js'
import { SENDER_LABEL, isPlaceholder, isoNetwork, waitForMessage } from '../lib/sender.js'

// The accounts being emptied (their labels in the config until 2026-11).
const OLD = {
  mainnet: { crank: '0x0f1850C4805A45cbeC8E5F42743FCBE63B61DaB8', claim: 'f1x5uqdow6zqtnrsmesuxd3gdbkze5g5iqkpc2lxq' },
  calibnet: { crank: '0x049Ba5f9551c4372E1F9dCde82146E39D6689c7E', claim: 't17onisyvqkb5h6ix43jplk45x7xfpbydvs34encq' },
}
// FilForwarder, the same address on both networks. Checked 2026-11-11 with eth_getCode on Glif mainnet and calibnet:
// identical runtime code (4696 hex chars, keccak below), which contains forward(bytes) (selector 0xd948d468).
// The run checks the code again before using it.
const FORWARDER = '0x2B3ef6906429b580b7b2080de5CA893BC282c225'
const FORWARDER_CODE_HASH = '0x6f0fb6a5fc5874b6753b042c8cac33c44ba3bf480250d7c76e1ca6fa87a4eb91'
const forwarderAbi = parseAbi(['function forward(bytes destination) payable'])

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const SEND = process.argv.includes('--send')
const old = OLD[cfg.network]
if (!old) throw new Error(`no old accounts known for network ${cfg.network}`)
const dest = cfg.wallets?.[SENDER_LABEL]
if (isPlaceholder(dest)) throw new Error(`the destination (${SENDER_LABEL}) is still a placeholder: ${dest}. Put the new address in the config first.`)
const destAddr = (() => { try { return fromString(dest) } catch { return null } })()
if (destAddr?.protocol !== 1 || !dest.startsWith(cfg.addressPrefix)) throw new Error(`the destination ${dest} is not an f1 address of ${cfg.network}`)

const rpc = makeRpc(cfg.rpcUrl)
const iso = new RPC({ api: cfg.rpcUrl, network: isoNetwork(cfg) })
const fil = (atto) => `${(Number(atto / 10n ** 12n) / 1e6).toFixed(6)} FIL`
const balanceOf = async (a) => BigInt(await rpc('Filecoin.WalletBalance', [a]))
console.log(`${cfg.network} sweep to ${dest} (balance ${fil(await balanceOf(dest))}) · ${SEND ? 'SENDING' : 'PLAN ONLY, nothing is sent (rerun with --send)'}`)

// 1. old Claim account (f1) -> new f1, native send
const claimKey = process.env.OLD_CLAIM_KEY?.trim().replace(/^0x/, '')
if (!claimKey) console.log(`1. ${old.claim}: no OLD_CLAIM_KEY, skipped`)
else {
  const acct = accountFromPrivateKey(Buffer.from(claimKey, 'hex'), 'SECP256K1', isoNetwork(cfg))
  if (acct.address.toString() !== old.claim) throw new Error(`OLD_CLAIM_KEY is the key of ${acct.address}, not of the old Claim account ${old.claim}`)
  const balance = await balanceOf(old.claim)
  // Gas first, with value 0; the value is then the balance minus the most the gas can cost (limit x fee cap).
  const m = await new Message({ to: dest, from: old.claim, value: '0', method: 0 }).prepare(iso)
  const maxGas = BigInt(m.gasLimit) * BigInt(m.gasFeeCap)
  const value = balance - maxGas
  if (value <= 0n) console.log(`1. ${old.claim}: balance ${fil(balance)}, not more than the gas (${fil(maxGas)}), skipped`)
  else {
    console.log(`1. ${old.claim} -> ${dest}: ${fil(value)} (balance ${fil(balance)}, gas at most ${fil(maxGas)})`)
    if (SEND) {
      m.value = value.toString()
      const res = await iso.pushMessage({ msg: m, signature: signMessage(acct.privateKey, 'SECP256K1', m) })
      if (res.error) throw res.error
      const cid = res.result['/']
      console.log(`   sent ${cid}`)
      const landed = await waitForMessage(rpc, cid, 600_000)
      if (!landed || landed.receipt.ExitCode !== 0) throw new Error(`   ${cid}: ${landed ? 'exit code ' + landed.receipt.ExitCode : 'not on chain after 10 minutes'}; stopping before step 2`)
      console.log(`   landed at epoch ${landed.height}`)
    }
  }
}

// 2. old crank account (f410) -> FilForwarder.forward(new f1) -> new f1
const crankKey = process.env.OLD_CRANK_KEY?.trim()
if (!crankKey) console.log(`2. ${old.crank}: no OLD_CRANK_KEY, skipped`)
else {
  const account = privateKeyToAccount(crankKey.startsWith('0x') ? crankKey : `0x${crankKey}`)
  if (account.address.toLowerCase() !== old.crank.toLowerCase()) throw new Error(`OLD_CRANK_KEY is the key of ${account.address}, not of the old crank account ${old.crank}`)
  const chain = { id: cfg.chainId, name: cfg.network, nativeCurrency: { name: 'FIL', symbol: 'FIL', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } }
  const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) })
  const code = await pub.getCode({ address: FORWARDER })
  if (!code || keccak256(code) !== FORWARDER_CODE_HASH) throw new Error(`the code at ${FORWARDER} is not the FilForwarder checked on 2026-11-11; not sending`)
  const data = encodeFunctionData({ abi: forwarderAbi, functionName: 'forward', args: [destAddr.toContractDestination()] })
  const balance = await pub.getBalance({ address: account.address })
  const gas = (await pub.estimateGas({ account, to: FORWARDER, data, value: 1n })) * 5n / 4n // a quarter more than the estimate
  const { maxFeePerGas, maxPriorityFeePerGas } = await pub.estimateFeesPerGas()
  const maxGas = gas * maxFeePerGas
  const value = balance - maxGas
  if (value <= 0n) console.log(`2. ${old.crank}: balance ${fil(balance)}, not more than the gas (${fil(maxGas)}), skipped`)
  else {
    await pub.call({ account, to: FORWARDER, data, value }) // throws if the forward would revert
    console.log(`2. ${old.crank} -> FilForwarder ${FORWARDER} -> ${dest}: ${fil(value)} (balance ${fil(balance)}, gas at most ${fil(maxGas)})`)
    if (SEND) {
      const wallet = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) })
      const hash = await wallet.sendTransaction({ to: FORWARDER, data, value, gas, maxFeePerGas, maxPriorityFeePerGas })
      console.log(`   sent ${hash}`)
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 600_000 })
      if (receipt.status !== 'success') throw new Error(`   ${hash}: ${receipt.status}`)
      console.log(`   landed in block ${receipt.blockNumber}`)
    }
  }
}
console.log(`${dest} balance now ${fil(await balanceOf(dest))}`)

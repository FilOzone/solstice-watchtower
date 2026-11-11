// The sender (lib/sender.js): how a crank call becomes a native InvokeEVM message, the key and placeholder checks.
// Everything runs against mocks: no key here holds FIL and nothing is sent to a node. Run with: npm test
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as dagCbor from '@ipld/dag-cbor'
import { encodeFunctionData, encodeErrorResult } from 'viem'
import { accountFromPrivateKey } from 'iso-filecoin/wallet'
import { from as fromAddress } from 'iso-filecoin/address'
import { abi, decodeRevert } from '../lib/evm.js'
import { SENDER_LABEL, INVOKE_EVM, isPlaceholder, loadSender, prepareSender, invokeEvmParams, evmReturnHex, lotusMessage, signAndPush } from '../lib/sender.js'

// A test key (32 bytes of 0x01): known to everyone, never to be funded.
const KEY = '01'.repeat(32)
const ADDRESS = accountFromPrivateKey(Buffer.from(KEY, 'hex'), 'SECP256K1', 'testnet').address.toString()
const cfgWith = (address) => ({ network: 'calibnet', addressPrefix: 't', wallets: { 'cranker (decentramike)': '0x170356558bd57623d3df9877319014ec9de6e263', [SENDER_LABEL]: address } })
const SRA = '0x0339f205314C8210AF7Cb075d1A96D012e7896a9'

test('InvokeEVM params: the calldata as one CBOR byte string, base64', () => {
  const calldata = encodeFunctionData({ abi, functionName: 'submitShares', args: [44n] }) // 4-byte selector + one word
  const params = Buffer.from(invokeEvmParams(calldata), 'base64')
  assert.equal(params[0], 0x58) // CBOR major type 2 (byte string), length in the next byte
  assert.equal(params[1], 36)
  assert.equal('0x' + params.subarray(2).toString('hex'), calldata)
  assert.deepEqual(dagCbor.decode(params), new Uint8Array(Buffer.from(calldata.slice(2), 'hex')))
  assert.equal(invokeEvmParams('0x'), '') // no calldata, no params
})

test('InvokeEVM return: the revert data comes back as a CBOR byte string and decodes with the contracts ABI', () => {
  const revert = encodeErrorResult({ abi, errorName: 'NotBound', args: [44n] })
  const ret = Buffer.from(dagCbor.encode(Buffer.from(revert.slice(2), 'hex'))).toString('base64')
  assert.equal(evmReturnHex(ret), revert)
  assert.equal(decodeRevert(evmReturnHex(ret)), 'NotBound(44)')
  assert.equal(evmReturnHex(''), '0x')
})

test('the message for Filecoin.StateCall', () => {
  assert.deepEqual(lotusMessage({ to: 't410fam47ebjrjsbbbl34wb25dklnaexhrfvjmgova3q', from: ADDRESS, method: INVOKE_EVM, params: 'WCQ=' }),
    { Version: 0, To: 't410fam47ebjrjsbbbl34wb25dklnaexhrfvjmgova3q', From: ADDRESS, Nonce: 0, Value: '0', GasLimit: 0, GasFeeCap: '0', GasPremium: '0', Method: 3844450837, Params: 'WCQ=' })
})

test('placeholder: never an account, even with a key', () => {
  assert.ok(isPlaceholder('PLACEHOLDER: the f1 address printed by bin/newkey.js calibration'))
  assert.ok(isPlaceholder(undefined))
  assert.ok(!isPlaceholder(ADDRESS))
  const s = loadSender(cfgWith('PLACEHOLDER: the f1 address printed by bin/newkey.js calibration'), KEY)
  assert.equal(s.account, null)
  assert.match(s.why, /^DRY RUN, the sender in the config is a placeholder/)
  assert.match(loadSender({ wallets: {} }, KEY).why, /placeholder \(missing\)/) // no label at all
})

test('key check: no key is a dry run, the right key gives the account, a wrong key throws', () => {
  assert.match(loadSender(cfgWith(ADDRESS), undefined).why, /no key/)
  assert.match(loadSender(cfgWith(ADDRESS), '  ').why, /no key/)
  const s = loadSender(cfgWith(ADDRESS), '0x' + KEY + '\n') // as pasted into a secret: 0x prefix, trailing newline
  assert.equal(s.why, '')
  assert.equal(s.account.address.toString(), ADDRESS)
  assert.throws(() => loadSender(cfgWith('t17onisyvqkb5h6ix43jplk45x7xfpbydvs34encq'), KEY), /SENDER_KEY is the key of t1.*, not of the configured sender t17onis/)
})

test('prepareSender: a sender with no FIL is a dry run, and simulations run as f099 until it has FIL', async () => {
  const calls = []
  const rpc = (balance) => async (method, params) => { calls.push([method, ...params]); return balance }
  const unfunded = await prepareSender(cfgWith(ADDRESS), rpc('0'), KEY)
  assert.match(unfunded.why, /has no FIL yet/)
  assert.equal(unfunded.simFrom, 't099')
  assert.deepEqual(calls, [['Filecoin.WalletBalance', ADDRESS]])
  const funded = await prepareSender(cfgWith(ADDRESS), rpc('5000000000000000000'), KEY)
  assert.equal(funded.why, '')
  assert.equal(funded.simFrom, ADDRESS)
  assert.equal(funded.balance, 5n * 10n ** 18n)
  calls.length = 0
  const placeholder = await prepareSender(cfgWith('PLACEHOLDER: x'), rpc('1'), KEY)
  assert.equal(placeholder.simFrom, 't099')
  assert.deepEqual(calls, []) // no account: the balance is not even read
})

test('signAndPush: the crank goes out as a signed InvokeEVM message from the f1 to the contract (mock node)', async () => {
  const pushed = []
  const iso = {
    network: 'testnet',
    nonce: async (address) => { assert.equal(address, ADDRESS); return { result: 7 } },
    gasEstimate: async () => ({ result: { GasLimit: 12_000_000, GasFeeCap: '150000', GasPremium: '100000' } }),
    pushMessage: async (p) => { pushed.push(p); return { result: { '/': 'bafy2bzacetest' } } },
  }
  const { account } = loadSender(cfgWith(ADDRESS), KEY)
  const calldata = encodeFunctionData({ abi, functionName: 'submitShares', args: [44n] })
  const to = fromAddress(SRA, 'testnet').toString()
  assert.equal(to, 't410fam47ebjrjsbbbl34wb25dklnaexhrfvjmgova3q') // the SRA's f410 address, as the node shows it
  const cid = await signAndPush(iso, account, { to, method: INVOKE_EVM, params: invokeEvmParams(calldata) })
  assert.equal(cid, 'bafy2bzacetest')
  assert.equal(pushed.length, 1)
  const { msg, signature } = pushed[0]
  assert.equal(msg.from, ADDRESS)
  assert.equal(msg.to, to)
  assert.equal(msg.method, 3844450837)
  assert.equal(msg.value, '0')
  assert.equal(msg.nonce, 7)
  assert.equal(msg.gasLimit, 12_000_000)
  assert.equal('0x' + Buffer.from(dagCbor.decode(Buffer.from(msg.params, 'base64'))).toString('hex'), calldata)
  assert.equal(signature.type, 'SECP256K1')
  assert.equal(signature.data.length, 65)
})

test('configs: one sender per network, an f1 of that network or a placeholder; no old cranker/claimer labels', () => {
  for (const [file, prefix] of [['calibnet', 't1'], ['mainnet', 'f1']]) {
    const c = JSON.parse(readFileSync(new URL(`../config/${file}.json`, import.meta.url), 'utf8'))
    const s = c.wallets[SENDER_LABEL]
    assert.ok(isPlaceholder(s) || s.startsWith(prefix), `${file}: ${s}`)
    assert.equal(c.wallets['cranker (watchtower backup)'], undefined)
    assert.equal(c.wallets['claimer (watchtower backup)'], undefined)
  }
})

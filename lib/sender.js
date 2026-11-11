// The watchtower's one sending account per network: an f1 (secp256k1) key that sends both the crank calls (as native
// InvokeEVM messages to the contracts) and the f02 Claim. Repository secrets SENDER_KEY_CALIBRATION and
// SENDER_KEY_MAINNET, passed to the scripts as SENDER_KEY; the address is cfg.wallets[SENDER_LABEL].
// Until 2026-11 the crank used an f410 key (Ethereum transactions) and the Claim a separate f1 key; one f1 can do both,
// so there is one balance to watch per network instead of two (DESIGN.md, "One sender per network").
import * as dagCbor from '@ipld/dag-cbor'
import { Message } from 'iso-filecoin/message'
import { accountFromPrivateKey, signMessage } from 'iso-filecoin/wallet'

export const SENDER_LABEL = 'sender (watchtower backup)'
// FRC-0042 method number of the EVM actor's InvokeContract: what Lotus puts in a message built from an Ethereum
// transaction, and what iso-filecoin uses for a value send to an f410 address.
export const INVOKE_EVM = 3844450837

// A config holds a placeholder until the real address exists; the scripts must never send from one.
export const isPlaceholder = (address) => !address || address.startsWith('PLACEHOLDER')
export const isoNetwork = (cfg) => (cfg.network === 'mainnet' ? 'mainnet' : 'testnet')

// The configured sender and, when SENDER_KEY is set and the address is real, its account. A key that belongs to
// another address throws: a secret pasted under the wrong name is caught here, not on chain (2026-10-12 mix-up).
// `why` says why there is no account, for the dry-run log line.
export function loadSender(cfg, keyHex = process.env.SENDER_KEY) {
  const address = cfg.wallets?.[SENDER_LABEL]
  if (isPlaceholder(address)) return { address, account: null, why: `DRY RUN, the sender in the config is a placeholder (${address ?? 'missing'}), not sending` }
  const key = keyHex?.trim().replace(/^0x/, '')
  if (!key) return { address, account: null, why: 'DRY RUN, no key (SENDER_KEY is not set)' }
  const account = accountFromPrivateKey(Buffer.from(key, 'hex'), 'SECP256K1', isoNetwork(cfg))
  if (account.address.toString() !== address) throw new Error(`SENDER_KEY is the key of ${account.address}, not of the configured sender ${address}`)
  return { address, account, why: '' }
}

// Params of an InvokeEVM message: the calldata as one CBOR byte string (Lotus: abi.CborBytes(tx.Input)); none when
// there is no calldata. Base64, as Lotus JSON wants it.
export function invokeEvmParams(calldata) {
  const bytes = Buffer.from(calldata.replace(/^0x/, ''), 'hex')
  return bytes.length ? Buffer.from(dagCbor.encode(bytes)).toString('base64') : ''
}

// The return of an InvokeEVM message is the EVM return data (or, on a revert, the revert data) as a CBOR byte string.
export function evmReturnHex(base64) {
  if (!base64) return '0x'
  return '0x' + Buffer.from(dagCbor.decode(Buffer.from(base64, 'base64'))).toString('hex')
}

// An unsigned message in Lotus JSON, for Filecoin.StateCall (nonce and gas are not checked there).
export const lotusMessage = ({ to, from, method, params = '', value = '0' }) =>
  ({ Version: 0, To: to, From: from, Nonce: 0, Value: value, GasLimit: 0, GasFeeCap: '0', GasPremium: '0', Method: method, Params: params })

// Who the simulation runs as. Filecoin.StateCall refuses a sender with no actor ("sender not found on chain"), so
// before the sender is funded (or while the config holds a placeholder) the simulation runs as the f099 burn account,
// an account actor every network has. Crank and Claim are permissionless, so the result is the same.
export const simulationSender = (cfg, sender, balance) =>
  !isPlaceholder(sender) && balance > 0n ? sender : `${cfg.addressPrefix}099`

// loadSender plus what the chain says: the sender's balance, the reason for a dry run (`why`, empty when it sends) and
// who the simulations run as. A sender with no FIL has no actor yet (it gets one with its first incoming FIL), so
// nothing it sent could land: dry run.
export async function prepareSender(cfg, rpc, keyHex = process.env.SENDER_KEY) {
  const s = loadSender(cfg, keyHex)
  const balance = s.account ? BigInt(await rpc('Filecoin.WalletBalance', [s.address])) : 0n
  const why = s.why || (balance === 0n ? `DRY RUN, the sender ${s.address} has no FIL yet, not sending` : '')
  return { ...s, balance, why, simFrom: simulationSender(cfg, s.address, balance) }
}

// Nonce and gas from the node, sign, push. Returns the message CID.
export async function signAndPush(iso, account, { to, method, params = '', value = '0' }) {
  const m = await new Message({ to, from: account.address.toString(), value, method, params }).prepare(iso)
  const res = await iso.pushMessage({ msg: m, signature: signMessage(account.privateKey, 'SECP256K1', m) })
  if (res.error) throw res.error
  return res.result['/']
}

// Waits for a message to land (Filecoin.StateSearchMsg over the last 200 epochs, every 15 s, at most `timeoutMs`).
// Returns its receipt and height, or null when it has not landed in time. A node that does not know the message yet
// answers with an error ("failed to load message"), which here means "not yet".
export async function waitForMessage(rpc, cid, timeoutMs = 180_000) {
  for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
    const found = await rpc('Filecoin.StateSearchMsg', [null, { '/': cid }, 200, true]).catch(() => null)
    if (found) return { receipt: found.Receipt, height: found.Height }
    await new Promise((r) => setTimeout(r, 15_000))
  }
  return null
}

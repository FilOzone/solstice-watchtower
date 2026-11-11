#!/usr/bin/env node
// Creates the watchtower's sender account for one network (an f1, secp256k1 key) and stores its key without showing
// it: the key goes to the repository secret SENDER_KEY_MAINNET or SENDER_KEY_CALIBRATION (through `gh secret set`,
// on stdin) and to the macOS clipboard, for pasting into 1Password. Only the address is printed.
// Run it yourself, in your own terminal: the key must not pass through anyone else (an agent's or a CI log).
//   node bin/newkey.js mainnet|calibration [--overwrite]
// An existing secret is never replaced without --overwrite: that would throw away the key of an account that may
// still hold FIL.
import { spawnSync } from 'node:child_process'
import { create } from 'iso-filecoin/wallet'

const REPO = 'FilOzone/solstice-watchtower'
const NETWORKS = { mainnet: { secret: 'SENDER_KEY_MAINNET', iso: 'mainnet', config: 'config/mainnet.json' }, calibration: { secret: 'SENDER_KEY_CALIBRATION', iso: 'testnet', config: 'config/calibnet.json' } }
const arg = process.argv[2] === 'calibnet' ? 'calibration' : process.argv[2]
const net = NETWORKS[arg]
const overwrite = process.argv.includes('--overwrite')
const fail = (msg) => { console.error(`newkey: ${msg}`); process.exit(1) }
if (!net) fail('usage: node bin/newkey.js mainnet|calibration [--overwrite]')

// Everything that can fail is checked before the key exists.
if (spawnSync('which', ['pbcopy']).status !== 0) fail('pbcopy not found (this script copies the key to the macOS clipboard); nothing was created')
if (spawnSync('gh', ['--version']).error) fail('the GitHub CLI (gh) is not installed; nothing was created')
const list = spawnSync('gh', ['secret', 'list', '-R', REPO, '--app', 'actions', '--json', 'name'], { encoding: 'utf8' })
if (list.status !== 0) fail(`gh cannot list the secrets of ${REPO} (logged in, with admin rights on the repo?): ${list.stderr.trim()}; nothing was created`)
const exists = JSON.parse(list.stdout).some((s) => s.name === net.secret)
if (exists && !overwrite) fail(`the secret ${net.secret} already exists. Replacing it throws away the key of an account that may still hold FIL; move that FIL first, then rerun with --overwrite. Nothing was created`)

const account = create('SECP256K1', net.iso)
const key = Buffer.from(account.privateKey).toString('hex')
const address = account.address.toString()

// Clipboard first: if `gh secret set` fails afterwards, the key is not lost.
if (spawnSync('pbcopy', [], { input: key }).status !== 0) fail('pbcopy failed; nothing was stored, rerun')
const set = spawnSync('gh', ['secret', 'set', net.secret, '-R', REPO, '--app', 'actions'], { input: key, encoding: 'utf8' })
if (set.status !== 0) fail(`gh secret set ${net.secret} failed: ${set.stderr.trim()}. The key of ${address} is on the clipboard but in no secret; nothing holds FIL yet, so you can clear the clipboard and rerun`)

console.log(`${arg} sender: ${address}
The key is in the repository secret ${net.secret}${exists ? ' (replaced)' : ''} and on the clipboard.

Next:
1. Paste the clipboard into 1Password now (a new item "Solstice watchtower sender, ${arg}", with the address above),
   then copy something else so the key leaves the clipboard.
2. Put the address in ${net.config}, under wallets: "sender (watchtower backup)": "${address}"
3. Send it some FIL; until it has FIL, the
   crank and Claim steps are dry runs.`)

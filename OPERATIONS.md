# Operations

How to keep the watchtower running.

This page covers running the reader and its transactions, the record, the sending wallets, Slack, publishing the page, and the ENS name.

## The reader

The [`read`](.github/workflows/read.yml) workflow does all the regular work. Each run, for calibnet and then mainnet:

1. **Reads** FIP-0118 chain state from public endpoints ([`bin/reader.js`](bin/reader.js)) and writes it to `site/data/`. The static site fetches this record when it opens.
2. **Cranks** as a backup ([`bin/crank.js`](bin/crank.js)): when `submitShares` or `quarterlyGateCheck` has been possible for `crankDelayEpochs` and nobody has sent it, the watchtower sends it. The delay leaves room for the primary cranker: 60 epochs (30 minutes) on calibnet, 2880 epochs (one day) on mainnet.
3. **Claims** once a day ([`bin/claim.js`](bin/claim.js)): sends the f02 `Claim` for every wallet f02 owes something to. On mainnet that pays the Orchestrator; on calibnet it funds the tFIL and USDFC faucets.

It also records mainnet sector upgrades ([`bin/upgrades.js`](bin/upgrades.js)), then commits the record to the `data` branch as `record: <epoch>`.

The networks are independent: a failing step doesn't stop the others or the commit, but the run still ends as failed, so it shows on the Actions tab. How each step behaves when the chain or an endpoint misbehaves is in [DESIGN.md](DESIGN.md).

### When it runs

- Every hour, dispatched by a CronJob in FilOz's cluster. It alerts in #foc-wg-alerts when no `read` run has succeeded for 6 hours. Runbook: [solstice-watchtower-trigger in FilOzone/infra](https://github.com/FilOzone/infra/blob/main/base/apps/solstice-watchtower-trigger/README.md).
- GitHub's own schedule, as a backup. GitHub treats it as best effort and in practice starts a run every few hours.
- By hand: **Run workflow** on the [`read` workflow](https://github.com/FilOzone/solstice-watchtower/actions/workflows/read.yml), or `gh workflow run read.yml --repo FilOzone/solstice-watchtower --ref main`. This is always safe: runs share the `read` concurrency group, so a run never starts while another is in progress. At most one run waits; a newer waiting run replaces it, which is harmless because the reader catches up from its last epoch. Option: `test_slack` posts one marked test line to Slack first.
- To test a crank change before merge, run `node bin/crank.js config/calibnet.json --now` locally without `SENDER_KEY`. It is a dry run: it simulates each call that is due, without the delay, and logs what it would send. It updates `site/data/calibnet/crank.json`; don't commit that to `data`. The real send happens in the first hourly `read` run after merge.

### When a run fails

Open the failed run on the [Actions tab](https://github.com/FilOzone/solstice-watchtower/actions/workflows/read.yml). The last step lists each step's outcome (`read_calibnet=success crank_mainnet=failure ...`); open the failed step's log.

- A reader step: usually an RPC endpoint problem. The next run catches up from the last epoch it recorded.
- A crank or Claim step: an RPC error, a key that doesn't match the sender address in the config, or a message that couldn't be pushed or didn't land; the log shows which. A sender with no FIL, or a call that isn't possible yet, is not a failure: the step logs it and succeeds.
- The commit step: a push to `data` was refused. Nothing else pushes to `data`, so this should not happen; the next run starts from the latest `data`.

## The record

The record lives on the [`data`](https://github.com/FilOzone/solstice-watchtower/tree/data) branch, one folder per network: `mainnet/` and `calibnet/` (written by every run) and the frozen `butterfly-gamma/` and `calibnet-2026-09-17/`. Only the `read` workflow pushes to it. `main` holds only code, so merges to `main` never collide with a run.

- The `read` workflow checks out `main` and then `data` into `site/data/`, where the scripts read their state and write the record (`dataDir` in each `config/*.json`).
- The page fetches the record from `data` when it opens; the copy bundled at publish is its fallback.
- To run the scripts or serve the page locally, check `data` out in the same place: `git worktree add site/data data`, then `npm run read` or `npm run page`. `site/data/` is ignored on `main`. Don't push local runs to `data`: the next `read` run would start from them.

## Sending wallets

Each network has one sender account that pays gas for the crank and the Claim. Nothing else sends.

| Network | Sender | Secret |
|---|---|---|
| Mainnet | [`f1hyxv2mezsmtbkf7s3osia2njsk2o2nwbs4jxqoi`](https://filfox.info/en/address/f1hyxv2mezsmtbkf7s3osia2njsk2o2nwbs4jxqoi) (`f03862811`) | `SENDER_KEY_MAINNET` |
| Calibnet | [`t1njhcrrzo6sggv36oxe5dk6errbt7oee6dp5snba`](https://calibration.filfox.info/en/address/t1njhcrrzo6sggv36oxe5dk6errbt7oee6dp5snba) (`t0201450`) | `SENDER_KEY_CALIBRATION` |

- The keys are [repository secrets](https://github.com/FilOzone/solstice-watchtower/settings/secrets/actions) and are in the infra 1Password vault.
- They only pay gas, so they drain slowly. infra's [`wallet-balance-exporter`](https://github.com/FilOzone/infra/tree/main/base/apps/wallet-balance-exporter) alerts in #foc-wg-alerts below 0.5 FIL on mainnet and 5 tFIL on calibnet. To top up, send FIL (or tFIL from a faucet) to the address above.
- While a sender has no FIL, its crank and Claim steps run as dry runs and log why.
- To replace a key: first move the old account's FIL somewhere safe (its key is in 1Password), then run `node bin/newkey.js mainnet --overwrite` (or `calibration --overwrite`) in your own terminal. It sets the secret, copies the new key to the clipboard for 1Password and prints only the new address. Put that address in `config/mainnet.json` (or `config/calibnet.json`) under `"sender (watchtower backup)"` and send the FIL to it.

## Slack

The reader posts to [#fil-solstice-watchtower](https://filecoinproject.slack.com/archives/C0C436Q8X6Z): one message per run that found something new on mainnet, summarizing the new records, plus a notice when a run starts late (calibnet is off). It posts through an Incoming WebHook of the Slack app `solstice-watchtower`, created by @TippyFlitsUK; the URL is the `SLACK_WEBHOOK` repository secret. Without the secret nothing is posted, and a failed post never fails the run.

## Publishing the page

The page at https://solsticewatchtower.eth.limo/ is a fixed copy of [`site/`](site/) stored on Filecoin Onchain Cloud. It fetches the record from the `data` branch when it opens, so new data needs no publish. Only changes to the page itself ([`site/index.html`](site/index.html), [`site/lib/`](site/lib/)) need one.

Publishing is automatic: the [`publish`](.github/workflows/publish.yml) workflow runs on every push to `main` that changes `site/`. The reader commits to `data`, so it never triggers a publish. To change the page, open a PR; merging it publishes.

To publish by hand (for example to retry a failed run), open the [`publish` workflow](https://github.com/FilOzone/solstice-watchtower/actions/workflows/publish.yml) and run it on `main`. Tick `dry_run` to see the new CID without publishing. Or from a terminal:

```bash
gh workflow run publish.yml --repo FilOzone/solstice-watchtower --ref main -f dry_run=false
```

The run takes a few minutes. It uses [FilOzone/filoz-webmaster](https://github.com/FilOzone/filoz-webmaster), pinned to a commit because it receives the publishing key, and does this:

1. Packs `site/`, with the record from `data` in `site/data/` as the page's fallback copy, and works out its CID.
2. Stops if `solsticewatchtower.eth` already points at that CID.
3. Stores the page on two storage providers.
4. Waits until a provider serves the new CID.
5. Points `solsticewatchtower.eth` at the new CID.
6. Waits up to 15 minutes until https://solsticewatchtower.eth.limo/ serves the new CID, and fails the run if it doesn't.

The [run summary](https://github.com/FilOzone/solstice-watchtower/actions/workflows/publish.yml) lists the old CID, the new CID, the providers and the ENS transaction. When a run publishes a new CID and passes, the public address serves the new page.

To go back to an earlier page, revert the page change on `main`; the revert publishes itself.

## ENS name

| | |
|---|---|
| Name | [`solsticewatchtower.eth`](https://app.ens.domains/solsticewatchtower.eth) |
| Owner and manager | FilOz ENS wallet [`0x244d2454DB5BDF1eCAc9011DD8B631679Be0a269`](https://etherscan.io/address/0x244d2454DB5BDF1eCAc9011DD8B631679Be0a269) ([`filnova.eth`](https://app.ens.domains/filnova.eth)) |
| Resolver | ENS Public Resolver [`0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63`](https://etherscan.io/address/0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63) |
| Namehash | `0x429fbddd7e64cdbaf69978517925dc57f2b2929bc5aa01fb3916a73552f7f602`: the name's ID in ENS contracts, the `node` argument when calling the resolver directly (for example from Etherscan) |
| Delegate for record updates | FilOz PIN wallet [`0x4714C4F258978D9a261bE4994dA5431a5e483e4d`](https://etherscan.io/address/0x4714C4F258978D9a261bE4994dA5431a5e483e4d) |
| Expires | 2027-09-22 (as of 2026-11-11) |

- The owner wallet never goes into CI. It is only needed to change the delegate or transfer the name.
- The delegate can change this name's records and nothing else. It was approved with `approve(bytes32 node, address delegate, bool approved)` on the resolver, sent from the owner wallet ([transaction](https://etherscan.io/tx/0xa6ef5a4edb653c9ecbc9b7752741eb31e03a1ec9219a75a20f1ac093b8836f3c)). The same call with `false` removes it.
- The name is on ENSv1 and has not been upgraded to ENSv2. An upgrade would mean setting up the delegate again.
- Renewal: @TippyFlitsUK renews it before 2027-09-22 (about 5 USD a year). Anyone can pay to extend a name from the [ENS app](https://app.ens.domains/solsticewatchtower.eth).

## Publishing wallet

One wallet, the FilOz PIN wallet, pays for storage and signs the ENS update: [`0x4714C4F258978D9a261bE4994dA5431a5e483e4d`](https://etherscan.io/address/0x4714C4F258978D9a261bE4994dA5431a5e483e4d) on Ethereum, [`f410fi4kmj4sys6gzujq34smu3jkddjpeqpsndbe2nya`](https://filfox.info/en/address/f410fi4kmj4sys6gzujq34smu3jkddjpeqpsndbe2nya) on Filecoin.

- Its key is the `FOC_PUBLISH_KEY` [repository secret](https://github.com/FilOzone/solstice-watchtower/settings/secrets/actions), stored without the `0x` prefix. The key is in 1Password, `Eng Infra`.
- On Filecoin it pays for storage in USDFC through Filecoin Pay, about 0.24 USDFC a month for the two data sets ([1919](https://pdp.filecoin.cloud/mainnet/dataset/1919) on provider 5, [1920](https://pdp.filecoin.cloud/mainnet/dataset/1920) on provider 1), plus a little FIL for gas. When the payment account runs short, a publish tops it up from the wallet's own USDFC and fails if there is not enough. Storage keeps drawing on the payment account between publishes, so its balance is what keeps the page stored.
- On Ethereum it pays gas for the ENS update, about 0.000025 ETH each at 202611 gas prices.
- Balances are monitored by infra's [`wallet-balance-exporter`](https://github.com/FilOzone/infra/tree/main/base/apps/wallet-balance-exporter), with alerts for low ETH, low FIL and less than 30 days of Filecoin Pay runway.

To top it up, send USDFC or FIL on Filecoin, or ETH on Ethereum, to the address above.

## References

- This page started as part of [FilOzone/infra#400](https://github.com/FilOzone/infra/issues/400), moving the watchtower into FilOz team ownership.

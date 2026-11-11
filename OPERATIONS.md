# Operations

How to keep the watchtower running. Tracked in [FilOzone/infra#400](https://github.com/FilOzone/infra/issues/400).

This page covers publishing the page and the ENS name. The reader and the sending wallets are still to be added here. The hourly trigger for the reader and its alert run in FilOz's cluster; see the [trigger runbook in FilOzone/infra](https://github.com/FilOzone/infra/blob/main/base/apps/solstice-watchtower-trigger/README.md) (added in [FilOzone/infra#454](https://github.com/FilOzone/infra/pull/454)).

## Publishing the page

The page at https://solsticewatchtower.eth.limo/ is a fixed copy of [`site/`](site/) stored on Filecoin Onchain Cloud. It fetches the record from this repo when it opens, so new data needs no publish. Only changes to the page itself ([`site/index.html`](site/index.html), [`site/lib/`](site/lib/)) need one.

Publishing is automatic: the [`publish`](.github/workflows/publish.yml) workflow runs on every push to `main` that changes `site/` outside [`site/data/`](site/data/). The reader's hourly record commits only touch `site/data/`, so they never trigger it. To change the page, open a PR; merging it publishes.

To publish by hand (for example to retry a failed run), open the [`publish` workflow](https://github.com/FilOzone/solstice-watchtower/actions/workflows/publish.yml) and run it on `main`. Tick `dry_run` to see the new CID without publishing. Or from a terminal:

```bash
gh workflow run publish.yml --repo FilOzone/solstice-watchtower --ref main -f dry_run=false
```

The run takes a few minutes. It uses [FilOzone/filoz-webmaster](https://github.com/FilOzone/filoz-webmaster), pinned to a commit because it receives the publishing key, and does this:

1. Packs `site/` and works out its CID.
2. Stops if `solsticewatchtower.eth` already points at that CID.
3. Stores the page on two storage providers.
4. Waits until a provider serves the new CID.
5. Points `solsticewatchtower.eth` at the new CID.
6. Waits up to 15 minutes until https://solsticewatchtower.eth.limo/ serves the new CID, and fails the run if it doesn't.

The [run summary](https://github.com/FilOzone/solstice-watchtower/actions/workflows/publish.yml) lists the old CID, the new CID, the providers and the ENS transaction. A green run means the public address serves the new page.

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
- Balances are monitored by infra's [`wallet-balance-exporter`](https://github.com/FilOzone/infra/tree/main/base/apps/wallet-balance-exporter), with alerts for low ETH, low FIL and less than 30 days of Filecoin Pay runway ([FilOzone/infra#453](https://github.com/FilOzone/infra/pull/453), in progress).

To top it up, send USDFC or FIL on Filecoin, or ETH on Ethereum, to the address above.

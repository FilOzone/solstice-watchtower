# Solstice watchtower

Watches FIP-0118 on Filecoin mainnet and calibnet. Every hour it reads what landed on chain in f02, the SWA and the SRA, adds it to a public record, and sends the backup crank (`submitShares`, `quarterlyGateCheck`) and the daily f02 `Claim` when they are due. One page shows the record and reads f02 live.

- Page: https://solsticewatchtower.eth.limo/ (mainnet; calibnet at `?data=calibnet`)
- Record: the [`data`](https://github.com/FilOzone/solstice-watchtower/tree/data) branch, one folder per network

## Docs

- [DESIGN.md](DESIGN.md): what the reader, the crank and the Claim do, how they behave when something fails, and why.
- [OBSERVABILITY.md](OBSERVABILITY.md): how each FIP-0118 action can be observed on chain, by anyone.
- [OPERATIONS.md](OPERATIONS.md): keeping it running: the `read` workflow, the record, the sending wallets, Slack, publishing the page, ENS.

## Local development

Needs Node.js 22 or newer, and Python 3 for `npm run page`.

```bash
npm install
git worktree add site/data data   # the record, where the scripts and the page expect it
```

| Command | What it does |
|---|---|
| `npm test` | Decoder tests on hand-written samples, and sender tests (message building, key checks) on mocks. |
| `npm run read` | One reader run against calibnet. Read-only: it sends nothing and needs no key. Writes to `site/data/calibnet/`; don't push that to `data`. |
| `npm run page` | Serves the page at http://localhost:8000, reading the record from `site/data/`. |

Each network's contract addresses, activation epoch and wallets are in `config/<network>.json`.

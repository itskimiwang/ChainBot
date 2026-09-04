# Phase 2/3: build or buy?

The spec flagged a third-party API (MadeOnSol, or an equivalent) offering deployer
reputation scoring, tracked-wallet trade alerts, and token risk scores for this chain,
and asked whether buying it would cover enough of Phases 2 and 3 to be worth the time.

**Conclusion: build the local graph, and keep a vendor slot open behind an interface.**
Both are implemented and running. No vendor is wired in.

---

## The case for buying

It is real. Phases 2 and 3 are the most time-expensive parts of the spec, and both have
the same unpleasant property: **they are worth nothing on day one.**

A deployer graph with no history scores every deployer as unknown. A tracked-wallet list
built from observed graduations is empty until tokens have graduated. Neither improves
because the code is good — they improve because time passed. On a fresh database, Phase 2
returns the neutral score for almost every launch and Phase 3 emits no signals at all.
This is visible in any short evaluation run and is not a bug.

A vendor with months of indexed history sidesteps exactly that. It is the single best
argument for buying, and it is a strong one.

---

## Why build anyway

### The cold start is shorter than it looks

Launch rate on this chain is high. Within hours the graph has hundreds of deployers with
resolved funding sources, and repeat launchers — the population that actually matters —
start showing up in clusters. The asset you are buying is worth less than it seems,
because you accrue an adequate version of it quickly.

The tracked-wallet list is the genuinely slow one, since it needs graduations to label
against. That is the part of the argument for buying that survives.

### The scoring rules are the product, not the data

A vendor sells a *score*. What we need is a score whose construction we control, because
the way it is built is the strategy:

- Refusing to cluster wallets behind a high-out-degree funder. A vendor that clusters on
  shared funding without that rule merges everyone who used the same exchange into one
  cluster whose statistics are noise. We cannot see whether they do this.
- Separating score from confidence, so a fresh deployer scores neutral-with-no-evidence
  rather than reading like a proven one. Most reputation APIs return a single number, and
  a single number cannot express "we don't know."
- Grading outcomes on graduation, which on this launchpad is an objective on-chain fact,
  rather than on a vendor's private definition of "did it pump."

Buying a score means inheriting decisions we would have to reverse-engineer from
behaviour, and re-tuning every time they change them without telling us.

### The failure mode is bad and undetectable

The bot holds a funded wallet and sizes positions on these scores. A vendor outage
degrades to "everything is unknown," which is survivable. A vendor *change* — a scoring
tweak, a re-clustering, a coverage gap — silently shifts position sizes with no error and
no log line. We would find out from the P&L.

### The local graph is cheap to keep running

It is a standing service with no deadline. Funding resolution is background work behind a
serialised queue against a public explorer, cached permanently per address. Nothing blocks
a trade on it: the decision engine reads whatever is known at decision time and scores an
unresolved deployer as unknown. Running it costs a few explorer requests a minute and a
few megabytes of SQLite. Turning it off saves nothing worth having.

### It compounds, and it is ours

Every hour it runs it gets better, and it stays available if a vendor changes terms,
raises prices, drops the chain, or disappears. Given that this specific ecosystem has
already rebranded once (NOXA → Pons), vendor stability is not a safe assumption.

---

## Where a vendor would still help

Two places, both worth revisiting:

1. **Seeding the tracked-wallet list.** This is the real cold-start cost, and a vendor's
   KOL list would compress it meaningfully. The authenticity filter would still gate every
   signal, so a bad vendor list degrades to "no signal" rather than to bad trades — which
   makes this a low-risk place to accept external data.
2. **Backfilling historical deployer outcomes**, including Pons V1 launches, which used a
   different mechanism (instant locked Uniswap V3, no bonding curve) and would need that
   accounted for. A one-time import is much less coupling than a live dependency.

Both are *imports into our schema*, not replacements for our scoring. That distinction is
the whole recommendation.

---

## How it is wired

`FundingSourceResolver` is the seam. `BlockscoutFundingResolver` is the implementation;
`NullFundingResolver` is the degraded path when no explorer is configured. A vendor would
be a third implementation, or — for reputation rather than funding — a `DeployerScoreProvider`
blended into `DeployerGraphService.score()` as an additional evidence source, weighted by
its own confidence like every other input.

`config/chain.json` → `externalApis.madeonsol` holds the disabled config slot.

The thing to preserve if this is revisited: **a vendor score should be an input to our
scoring, never a replacement for it.** The local database keeps accruing value either way,
and it is what remains when the vendor does not.

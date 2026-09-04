# Runbook

Operating procedures for the Robinhood Chain meme-coin bot. Read
[the README](../README.md) first for what the system does.

---

## Starting a paper evaluation run

Paper mode is the default and needs no configuration.

```bash
npm install
npm run dev
```

Then open the dashboard at `http://127.0.0.1:43118`.

### Before you start the clock

The evaluation window begins at process start, so get these right first — restarting
resets it.

1. **Decide the criteria and write them down.** `config/bot.json` → `evaluation`. Doing
   this after watching a day of P&L defeats the purpose of having a gate.
2. **Decide whether the deployer and wallet databases should carry over.** They live in
   `data/` and accumulate across runs. Carrying them over is usually right — the deployer
   graph is worth more the longer it has run. Starting clean tests the cold-start
   behaviour, which is a different question. Note which you did.
3. **Point at a dedicated RPC if you have one.** The public endpoint is rate-limited; the
   scanner backs off and keeps working, but under sustained throttling it will lag the
   chain head and miss short-lived launches. The dashboard's pipeline card shows scanner
   lag and error counts.
4. **Clear a stale kill switch:** `rm -f data/KILL`.

### While it runs

The dashboard's **pipeline card** is the thing to watch, more than the P&L. It shows
cumulative counts at each stage. A healthy run shows attrition at every stage; the failure
modes look like this:

| What you see | What it means |
| --- | --- |
| Launches seen climbing, curves tracked flat | Quote-asset allowlist is filtering everything. Check `listener.quoteAssetAllowlist`. |
| Vetted ≫ passed | Either the chain is full of honeypots or a tax threshold is too tight. Check the Launches tab for the failure reasons. |
| `simulationUnavailable` climbing | RPC is refusing `eth_simulateV1`. Vetting is degrading to fewer checks — investigate before trusting the results. |
| Entries evaluated high, positions opened zero | A threshold is wrong. The Signals tab lists every rejection with its reason; one reason dominating is the tell. |
| Demand signals zero | Expected on a fresh database — the tracked-wallet list builds from observed graduations. Not a bug on a short run. |
| Scanner lag growing | Rate limiting. Move to a dedicated provider. |

Rejection reasons are the most useful diagnostic in the system. A pipeline that rejects
everything for one repeated reason is a misconfigured threshold, not a quiet market, and
the P&L cannot distinguish those.

### Reading the result

The go/no-go verdict is on the dashboard and at `GET /api/state` under `evaluation`. It
returns `in-progress` until the window completes, then `go` only if **every** criterion
passed.

A `no-go` is information, not a failure. The criteria that missed tell you what to change.
Change one thing, restart the window, and do not shorten it because the first hours looked
good.

Which criterion missed points at a different part of the system:

| Missed criterion | Where to look first |
| --- | --- |
| Win rate, with peak multiples clustered near 1.0x | Entries are not catching moves at all. Check the graduation progress at entry: `decision.maxGraduationProgress` admits tokens up to 85% of the way to the threshold, and `proximityComponent` scores them *highest* there, so the bot pays the most for the most extended curves. Lowering both is the first thing to try. |
| Win rate, with peak multiples well above 1.0x | Entries are fine and exits are early. Widen `exit.trailingStopBasePct` and `exit.depthStopMinPct`, or lower the first ladder rung below 2x. |
| Net P&L negative but win rate acceptable | Losers are bigger than winners. The ladder is taking profit too early relative to where stops sit. |
| Max drawdown | Position sizing or concurrency, not signal quality. `decision.scoutSizePctOfEquity` and `risk.maxConcurrentPositions`. |
| Closed trades below the minimum | Not a strategy result at all — too few entries to conclude anything. Check rejections before changing any threshold. |
| Stranded by graduation | Lower `exit.graduationProximityTrim.progressThreshold` so the trim fires earlier, or cap `decision.maxGraduationProgress` so the bot stops entering curves that are about to be swept. |

A caution the first run made concrete: on a quiet or hostile stretch, most curves never
graduate and a token can retrace its entire reserve in under a minute. A losing window is
frequently the market rather than a misconfiguration, and tuning thresholds until a
*single* window passes is how you fit the strategy to noise. Prefer a change you can argue
for from the rejection reasons and the exit-reason mix.

---

## Going live

Do this only after a completed window returned `go`.

1. **Confirm sequencer ordering.** `config/chain.json` → `rpc.sequencer.orderingConfirmed`
   is `false`. Verify against [docs.robinhood.com/chain](https://docs.robinhood.com/chain)
   whether the sequencer is first-come-first-served with no public mempool. The entire
   speed-as-edge premise depends on it, and it is currently an assumption.
2. **Provision a dedicated RPC.** The public endpoint is not viable for live execution.
   Set `RHC_RPC_HTTP_URL` and, if the provider supports it, `RHC_RPC_WS_URL`.
3. **Create a fresh hot wallet.** It must hold trading capital only — never a treasury,
   never a wallet with other approvals. This balance is the real bound on what a bug or a
   compromised key can lose; the config limits are the secondary bound.
4. **Set the key as an environment variable.** `EXECUTION_PRIVATE_KEY`. Never in a config
   file, never in a shell history you keep, never in the repo.
5. **Re-check the risk limits against the real balance.** `maxPositionSizeUsd` and
   `maxTotalExposurePct` were tuned against a $1,000 virtual balance. They are absolute
   dollar figures, not fractions.
6. **Flip the mode.** `config/bot.json` → `"mode": "live"`.
7. **Restart, and watch the first fills individually.** Compare realised slippage against
   what paper mode predicted for similar sizes. A systematic gap means the curve math or
   the fee assumptions have drifted from the deployed contracts.

There is no automated path for any of this, by design.

---

## Controls

Four controls, in increasing severity. All are available on the dashboard, over the API,
and through Telegram if configured.

| Control | Effect | Use when |
| --- | --- | --- |
| **Pause** | Blocks new entries. Open positions keep running and exiting normally. | You want to stop adding risk. |
| **Flatten** | Sells every open position at the current mark. Entries stay enabled. | You want out of the book but not out of the market. |
| **Kill** | Flattens everything *and* blocks all new entries until manually resumed. Writes `data/KILL`. | Something is wrong. |
| **Kill switch file** | Same block, but survives a wedged process. | The bot is not responding. |

```bash
touch data/KILL          # engage from any shell on the host
rm -f data/KILL          # clear, then Resume
```

The kill switch is a file rather than an API call specifically so it works when the API
does not.

**Exits are never blocked by any of these.** The risk manager gates entries only, because
refusing to sell during a drawdown turns a bad day into an unrecoverable one.

### Resume is not unconditional

`Resume` refuses while the daily loss limit is still breached. Undoing the one control
designed to survive a bad run, during the bad run, is not something the UI will help you
do. Either wait for the day to roll over or raise the limit deliberately in config.

---

## Incidents

### Positions stranded by graduation

**Symptom:** a position appears under **Stranded** on the dashboard with a warning that
the curve stopped accepting sells.

**What happened:** the curve was swept into its Uniswap v4 pool while the bot still held
tokens. Pons curves refuse sells from the sweep onward, and there is no v4 sell route
implemented, so the position cannot be exited.

**What the bot does:** marks it stranded exactly once, writes its value down to zero,
releases its position slot, and counts it against the `maxStrandedRate` gate. It does not
retry and does not re-alert.

**What to do:** the tokens are real and sit in your wallet — recover them manually through
a v4 interface if the amount justifies it. To reduce recurrence, lower
`exit.graduationProximityTrim.progressThreshold` (default `0.92`) so the bot trims earlier,
or lower `decision.maxGraduationProgress` (default `0.85`) so it stops entering curves
already close to the sweep.

### Daily loss breaker tripped

**Symptom:** a red banner reading "Trading halted — daily loss limit hit".

Entries are blocked; exits continue. The breaker resets on its own at the day roll, with
the new day's starting equity as the new baseline.

Do not raise `dailyLossLimitPct` to get trading again in the moment. That is the decision
the limit exists to have already made.

### Scanner lag or repeated RPC errors

**Symptom:** the pipeline card shows growing lag or a climbing scan-error count. Logs show
`scan tick failed; backing off`.

The public RPC is rate-limiting. The scanner backs off exponentially and does not lose its
place — the block cursor persists, so it catches up rather than skipping. Sustained
throttling still means missed short-lived launches. Move to a dedicated provider.

### Vetting reports `simulationUnavailable`

`eth_simulateV1` is unavailable or failing. Vetting is running fewer checks than it should.
A skipped check is never counted as a pass, so this shows up as tokens failing rather than
tokens slipping through — but the results of a run with a high count here are not
comparable to a clean one.

---

## Alerts

Optional. Set both to enable:

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

Commands: `/status`, `/positions`, `/pause`, `/resume`, `/kill`.

The bot token is registered with the logger's redaction list at load, so it will not
appear in log output.

---

## Data

Everything in `data/` is local runtime state and is gitignored.

| File | Contents | Safe to delete? |
| --- | --- | --- |
| `ledger.sqlite` | Positions and fills | Yes — resets P&L and the evaluation window |
| `deployer-graph.sqlite` | Deployers, funding, launch outcomes | Yes, but you lose accumulated reputation data, which is the expensive part |
| `wallet-tracker.sqlite` | Tracked wallets, funding cache | Yes, but Phase 3 cold-starts again |
| `KILL` | Kill switch | Yes — that is how you clear it |

Open positions and stranded positions survive a restart. Closed positions are retained for
history.

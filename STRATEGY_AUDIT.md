# Kalshibot Framework Audit & TradeCafe Upgrade

**Scope:** full audit of the Kalshibot trading framework, followed by a
risk/execution overhaul that ports the **TradeCafe** discipline (from
`strategy.html`) onto Kalshi binary BTC up/down contracts (`KXBTC15M`).

---

## 1. What the framework is

Kalshibot trades Kalshi's 15-minute Bitcoin up/down binary contracts (settle at
**$1** if right, **$0** if wrong, 7% fee on winnings). It runs **two parallel
runtimes that share the same strategy logic**:

| Path | Entry point | Strategy code |
|------|-------------|---------------|
| **Live (primary)** | `server.js` → `agents/core/master-agent.js` (skill graph) | `agents/skills/analysis/signal-generator.js` |
| **Legacy** | `kalshi-bot.js` → `bot/engine.js` | `bot/strategy.js` |
| **Validator** | `backtest/backtest.js` | inlined copy of the same logic |

Three signal families: **DIRECTIONAL** (GBM model vs Kalshi price, exploiting
Kalshi market-maker lag behind Binance spot), **POLY_ARB** (Polymarket fair
value vs Kalshi ask), and **DUAL_SIDE** (YES+NO < $1 risk-free arb).

## 2. Audit findings

### 🔴 Critical — risk of ruin
1. **Kelly sizing on binary payoffs blows up the bankroll.** A losing binary
   forfeits the *entire* stake. Kelly (even ¼-Kelly) sizes large; one 4-loss
   streak erases dozens of wins. Backtest: **73–79% win rate but −97% to −99.5%
   P&L, ~99% max drawdown.** This is the single worst defect.
2. **No portfolio drawdown kill-switch.** Nothing flattens the book or halts
   trading on a bad day — the bot can ride an account to zero. The TradeCafe
   deck makes this its headline safety feature ("−30% → close everything").
3. **No capital reserve.** Sizing draws on the *entire* available balance, so
   the bot can deploy 100% of equity.

### 🟠 Signal quality
4. **Model overconfidence (~6%, documented in `FINDINGS.md`) is uncorrected.**
   The GBM model says 85% when realized is ~79%, so the measured "edge" is
   partly illusory — the bot trades phantom edges.
5. **Trend is only a soft multiplier, never a gate.** The bot will happily open
   a position straight into a strong opposing 1H trend.

### 🟡 Execution
6. **Crude take-profit.** A flat "sell at +15% or 50% of max gain" rule — no
   peak tracking, no break-even lock, no trailing. Positions that move favorably
   then reverse give the gain back. TradeCafe's whole exit thesis ("the stop
   steps into the green so a position almost never closes red") was absent.
7. **No averaging.** TradeCafe adds at a *better level*; Kalshibot could only
   take a single entry per contract with no level logic.

## 3. The TradeCafe mapping

`strategy.html` describes a spot/futures bot. The transferable discipline maps
cleanly onto binary contracts, and each piece targets a finding above:

| TradeCafe concept | Kalshi adaptation | Fixes |
|---|---|---|
| 30% reserve / work with 70% | `WORKING_CAPITAL_FRACTION` carved off before sizing | #3 |
| 0.5% fixed entry, ~3% max/position | `ENTRY_FRACTION` fixed-fractional + `MAX_POSITION_FRACTION` cap | #1 |
| Averages at a better *level* (×4/×2) | add to a side only when the contract is `AVERAGE_MIN_IMPROVE` cheaper | #7 |
| Max 5 positions, profit-locked frees a slot | `MAX_CONCURRENT` + smart slot return | — |
| **−30% drawdown → flatten all** | session-peak-equity kill-switch + `_flattenAll()` | #2 |
| Trailing SL stepping into profit | `evaluateExit`: arm → trail under peak bid → hard-take | #6 |
| Macro green-light to enter | hard trend gate (`macroGate`) blocks strong counter-trend | #5 |
| "We don't predict, we catch reactions" | calibration shrink toward 0.5 demands a *real* edge | #4 |

All of it lives in **one shared module, `bot/tradecafe.js`** (pure, unit-tested),
imported by the live skills, the legacy engine, and the backtester so the three
runtimes can never drift apart. Controlled by config (default **ON**); set
`USE_TRADECAFE=false` to revert to the exact legacy behavior.

## 4. Backtest evidence (7-day, deterministic seeded GBM)

Same market path and execution noise for every row (`--seed`); the only
difference is the risk framework. $100 start, 7-day window, four seeds:

| Seed | **Baseline** (Kelly) | **+ sizing/reserve** (`--tcsize`) | **Full TradeCafe** |
|------|------|------|------|
| 101 | $1.60 · DD **98.9%** | $81.09 · DD **19.0%** (148 tr) | $100.00 · 0 tr |
| 202 | $3.13 · DD **96.9%** | $81.01 · DD **19.5%** (168 tr) | $100.00 · 0 tr |
| 303 | $0.32 · DD **99.7%** | $85.89 · DD **15.0%** (175 tr) | $100.00 · 0 tr |
| 777 | $0.47 · DD **99.6%** | $78.14 · DD **22.0%** (174 tr) | $100.00 · 0 tr |

Baseline win rate is ~73–80% in every run — yet it still ends near **$0**,
because Kelly-sized binary losses (avg −$4.5) bury the small wins (avg +$0.5).
That is the defect TradeCafe exists to kill.

When genuine mid-priced edge *is* present (a +6–10pt edge on 45–60c contracts,
fed through the real `calibrate` → `entryContracts` path), the full framework
compounds it: **300 trades, 65% win rate, $100 → $182, max drawdown 8.5%.**
So the GBM run's "0 trades" is the framework *correctly declining a market with
no edge*, not broken plumbing.

**Honest reading of the synthetic test.** The GBM simulator has *no real
directional alpha* — by construction price is a driftless random walk, so after
the 7% winnings fee the directional signal is slightly negative-EV (this is
exactly what `FINDINGS.md` already concluded for the pure signal). In that
adversarial setting:

- **Sizing + reserve alone convert −99% ruin into a bounded ~22% drawdown** —
  the risk-of-ruin defect (#1) is eliminated.
- **Calibration + the macro gate refuse to over-trade noise**, preserving
  capital instead of bleeding it on phantom edges (#4, #5).
- **The drawdown kill-switch caps the worst case** regardless of signal quality
  (#2).

The two genuinely +EV components in live markets — the **Kalshi MM lag** the
directional model targets and **DUAL_SIDE arbitrage** — are unchanged in edge
but now sit on top of a framework that (a) survives long enough to harvest them
and (b) cannot blow up the account harvesting them. The **trailing profit-lock**
is a live-execution improvement the instant-settling backtest cannot even
exercise, so the table *understates* its real benefit.

> Bottom line: profitability in live trading depends on the real microstructure
> edge existing; what this upgrade guarantees is that Kalshibot stops converting
> a 73% win rate into a −99% account, and only deploys capital when the edge
> survives a calibration haircut and a macro check.

## 5. How to run

```bash
npm run backtest -- --seed 777                 # legacy baseline
npm run backtest -- --seed 777 --tcsize        # sizing/reserve fix only
npm run backtest -- --seed 777 --tradecafe     # full TradeCafe discipline
```

Tune everything via `.env` (see `.env.example`, "TradeCafe discipline" block).

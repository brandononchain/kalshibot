/**
 * TradeCafe Risk & Execution Core
 * ================================
 *
 * A single source of truth for the "TradeCafe" trading discipline, adapted from
 * the spot/futures strategy described in strategy.html to Kalshi binary
 * (0..$1 settlement) BTC up/down contracts.
 *
 * The TradeCafe philosophy — "we don't predict the market, we catch reactions;
 * conservative on risk, active on count; lock the stop into profit so a position
 * almost never closes red" — maps cleanly onto the three problems the backtest
 * (see backtest/FINDINGS.md) identified in the original Kalshibot:
 *
 *   1. GBM model is ~6% overconfident   → CALIBRATION SHRINK toward 0.5
 *   2. Kelly over-bets binary downside  → FIXED-FRACTIONAL sizing + capital reserve
 *   3. No portfolio-level safety        → DRAWDOWN KILL-SWITCH + trailing profit-lock
 *
 * Every function here is pure (no I/O, no state mutation except the explicitly
 * documented peak-tracking helpers) so it can be unit-tested and shared by the
 * live agent path, the legacy engine, and the backtester without divergence.
 *
 * TradeCafe concept            →  Kalshi binary adaptation
 * ---------------------------------------------------------------------------
 * 30% reserve / 70% working    →  WORKING_CAPITAL_FRACTION of total balance
 * 0.5% of working per entry    →  ENTRY_FRACTION fixed-fractional sizing
 * ×4 / ×2 averaging at level   →  add to same side only when price improves
 * max 5 concurrent positions   →  MAX_CONCURRENT with smart slot return
 * −30% drawdown → flatten all  →  DRAWDOWN_KILL on session peak equity
 * trailing SL stepping to +    →  trailing profit-lock exit on the contract bid
 * macro green light to enter    →  hard trend gate (block strong counter-trend)
 */

const TRADECAFE_DEFAULTS = {
  // ── Capital model (TradeCafe: 30% always in reserve, work with 70%) ──
  WORKING_CAPITAL_FRACTION: 0.70,   // deploy at most 70% of total balance
  ENTRY_FRACTION: 0.02,             // per entry = 2% of WORKING capital (~1.4% of total)
  MAX_POSITION_FRACTION: 0.06,      // one ticker/side after averaging caps at 6% of working
  MIN_ENTRY_DOLLARS: 1.0,           // never size below one contract's worth

  // ── Signal quality (fix documented overconfidence) ──
  CALIBRATION_SHRINK: 0.88,         // pCal = 0.5 + (pRaw-0.5)*shrink

  // ── Macro gate (TradeCafe: market must give the green light) ──
  TREND_HARD_GATE: true,            // block directional entries that fight a strong trend
  TREND_GATE_STRENGTH: 0.60,        // only block when trend strength >= this

  // ── Averaging (TradeCafe: add at a better LEVEL, never from panic) ──
  AVERAGE_MAX_ADDS: 2,              // up to 2 add-ons per ticker/side (entry + 2)
  AVERAGE_MIN_IMPROVE: 0.04,        // require the contract to be >=4c cheaper to add

  // ── Trailing profit-lock exit (TradeCafe: SL steps into the green) ──
  TRAIL_ARM_FRACTION: 0.35,         // arm the trail once we've captured 35% of max gain
  TRAIL_GAP: 0.04,                  // trail the contract bid by 4c below its peak
  HARD_TAKE_FRACTION: 0.85,         // lock the win once 85% of max gain is captured
  EXIT_MIN_TIME_MS: 30000,          // don't trade exits inside the last 30s

  // ── Portfolio drawdown kill-switch (TradeCafe: −30% → close everything) ──
  DRAWDOWN_KILL: 0.30,              // flatten all + halt when equity falls 30% from peak
  DRAWDOWN_COOLDOWN_MS: 15 * 60 * 1000, // stay flat for 15 min after a kill

  // ── Concurrency (TradeCafe: max 5 at once, profit-locked frees a slot) ──
  MAX_CONCURRENT: 5,
  SMART_SLOT_RETURN: true,          // profit-locked positions don't consume a slot
};

/**
 * Merge a (partial) bot config onto the TradeCafe defaults. Accepts the same
 * flat config object used everywhere else; unknown keys are ignored.
 */
function resolveParams(config = {}) {
  const p = { ...TRADECAFE_DEFAULTS };
  for (const key of Object.keys(TRADECAFE_DEFAULTS)) {
    if (config[key] !== undefined && config[key] !== null) p[key] = config[key];
  }
  return p;
}

// ─────────────────────────────────────────────────────────────────────────
// Signal quality
// ─────────────────────────────────────────────────────────────────────────

/**
 * Shrink a probability toward 0.5 to correct systematic overconfidence.
 * shrink=1 is a no-op; shrink=0 collapses everything to a coin flip.
 */
function calibrate(prob, shrink = TRADECAFE_DEFAULTS.CALIBRATION_SHRINK) {
  if (prob == null || Number.isNaN(prob)) return 0.5;
  const c = 0.5 + (prob - 0.5) * shrink;
  return Math.max(0.01, Math.min(0.99, c));
}

/**
 * Macro green-light. Returns true if a directional entry on `side` is allowed
 * given the 1H trend. With a hard gate enabled, a strong counter-trend entry is
 * rejected outright (not merely penalised). NEUTRAL / weak trends never block.
 */
function macroGate(side, trend, strength, params = TRADECAFE_DEFAULTS) {
  if (!params.TREND_HARD_GATE) return true;
  if (!trend || trend === 'NEUTRAL') return true;
  if ((strength || 0) < params.TREND_GATE_STRENGTH) return true;

  const counterTrend =
    (side === 'yes' && trend === 'BEARISH') ||
    (side === 'no' && trend === 'BULLISH');
  return !counterTrend;
}

// ─────────────────────────────────────────────────────────────────────────
// Position sizing — fixed fractional off the WORKING (non-reserve) balance
// ─────────────────────────────────────────────────────────────────────────

/** Working capital = balance minus the untouchable reserve. */
function workingCapital(totalBalance, params = TRADECAFE_DEFAULTS) {
  return Math.max(0, totalBalance) * params.WORKING_CAPITAL_FRACTION;
}

/**
 * Fixed-fractional contract count for a fresh entry.
 *
 * @param {number} totalBalance  full account balance (reserve is carved out here)
 * @param {number} price         contract ask in dollars (0..1)
 * @param {object} params        resolved TradeCafe params
 * @param {number} existingCost  dollars already deployed on this ticker/side
 * @returns {number} contracts (>=0; 0 means "do not enter")
 */
function entryContracts(totalBalance, price, params = TRADECAFE_DEFAULTS, existingCost = 0) {
  if (!price || price <= 0 || price >= 1) return 0;
  const work = workingCapital(totalBalance, params);
  if (work <= 0) return 0;

  const perEntry = Math.max(params.MIN_ENTRY_DOLLARS, work * params.ENTRY_FRACTION);
  const positionCap = work * params.MAX_POSITION_FRACTION;
  const remaining = Math.max(0, positionCap - existingCost);
  const dollars = Math.min(perEntry, remaining);
  if (dollars < price) return 0; // can't even afford one contract within the cap

  return Math.floor(dollars / price);
}

/**
 * Averaging gate (TradeCafe: add only at a better LEVEL).
 * Allowed when we're under the add cap AND the contract is now meaningfully
 * cheaper than our average entry — i.e. the market handed us a better level.
 */
function canAverageIn(avgEntryPrice, currentPrice, addsSoFar, params = TRADECAFE_DEFAULTS) {
  if (addsSoFar >= params.AVERAGE_MAX_ADDS) return false;
  return (avgEntryPrice - currentPrice) >= params.AVERAGE_MIN_IMPROVE;
}

// ─────────────────────────────────────────────────────────────────────────
// Trailing profit-lock exit
// ─────────────────────────────────────────────────────────────────────────

/**
 * Decide whether to exit a position early, implementing TradeCafe's "stop steps
 * into the green" ladder on the contract's own bid.
 *
 * The position object is expected to carry mutable bookkeeping fields
 * `peakBid` and `trailArmed`; this function updates them in place (the only
 * permitted mutation in this module, and it is idempotent/monotonic).
 *
 * @returns {{exit:boolean, reason?:string, stopLevel?:number, gainFraction:number}}
 */
function evaluateExit(position, currentBid, timeRemainingMs, params = TRADECAFE_DEFAULTS) {
  const entry = position.priceDecimal;
  const gainFraction = (entry < 1) ? (currentBid - entry) / (1 - entry) : 0;

  if (!currentBid || currentBid <= 0) return { exit: false, gainFraction: 0 };

  // Track the best bid we've seen (high-water mark for the trail).
  if (position.peakBid == null || currentBid > position.peakBid) {
    position.peakBid = currentBid;
  }

  // Never fire an exit order in the final seconds — let it settle instead.
  if (timeRemainingMs != null && timeRemainingMs < params.EXIT_MIN_TIME_MS) {
    return { exit: false, gainFraction };
  }

  const peakFraction = (entry < 1) ? (position.peakBid - entry) / (1 - entry) : 0;

  // 1. Hard take-profit: lock a near-certain win and dodge settlement fees.
  if (gainFraction >= params.HARD_TAKE_FRACTION) {
    return { exit: true, reason: 'hard_take_profit', stopLevel: currentBid, gainFraction };
  }

  // 2. Arm the trailing stop once we've banked enough of the move.
  if (!position.trailArmed && peakFraction >= params.TRAIL_ARM_FRACTION) {
    position.trailArmed = true;
  }

  // 3. Once armed, the stop rides TRAIL_GAP under the peak bid but never below
  //    break-even — so an armed position "almost never closes in the red".
  if (position.trailArmed) {
    const stopLevel = Math.max(entry, position.peakBid - params.TRAIL_GAP);
    if (currentBid <= stopLevel) {
      return { exit: true, reason: 'trailing_stop', stopLevel, gainFraction };
    }
  }

  return { exit: false, gainFraction };
}

// ─────────────────────────────────────────────────────────────────────────
// Concurrency & portfolio safety
// ─────────────────────────────────────────────────────────────────────────

/**
 * Effective number of slots in use. With smart slot return, a position whose
 * trailing stop is already locked at/above break-even is treated as "as good as
 * closed" and does not consume a concurrency slot (TradeCafe's slot return).
 */
function slotsInUse(positions, params = TRADECAFE_DEFAULTS) {
  if (!params.SMART_SLOT_RETURN) return positions.length;
  let used = 0;
  for (const p of positions) {
    const lockedGreen = p.trailArmed && p.peakBid != null &&
      (p.peakBid - params.TRAIL_GAP) >= p.priceDecimal;
    if (!lockedGreen) used += 1;
  }
  return used;
}

/** True when a new position may be opened under the concurrency cap. */
function hasOpenSlot(positions, params = TRADECAFE_DEFAULTS) {
  return slotsInUse(positions, params) < params.MAX_CONCURRENT;
}

/**
 * Portfolio drawdown kill-switch. Compares current equity against the session
 * peak; once equity has fallen DRAWDOWN_KILL from the peak, signals a flatten.
 *
 * @returns {{tripped:boolean, drawdown:number}}
 */
function checkDrawdownKill(equity, peakEquity, params = TRADECAFE_DEFAULTS) {
  if (!peakEquity || peakEquity <= 0) return { tripped: false, drawdown: 0 };
  const drawdown = (peakEquity - equity) / peakEquity;
  return { tripped: drawdown >= params.DRAWDOWN_KILL, drawdown };
}

module.exports = {
  TRADECAFE_DEFAULTS,
  resolveParams,
  calibrate,
  macroGate,
  workingCapital,
  entryContracts,
  canAverageIn,
  evaluateExit,
  slotsInUse,
  hasOpenSlot,
  checkDrawdownKill,
};

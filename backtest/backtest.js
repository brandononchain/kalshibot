#!/usr/bin/env node

/**
 * Kalshibot Strategy Backtester
 *
 * Simulates the signal-generator's three strategies against historical BTC data
 * to measure profitability before going live.
 *
 * Approach:
 *   1. Fetch real 1-minute BTC/USDT candles from Binance public API
 *   2. Simulate 15-minute Kalshi contract windows (KXBTC15M)
 *   3. Model Kalshi bid/ask prices with realistic spreads + latency lag
 *   4. Run the GBM probability model + signal generation at each tick
 *   5. Execute trades, resolve settlements, track P&L
 *
 * Usage:
 *   node backtest/backtest.js [--days 7] [--start 2025-01-01] [--verbose]
 */

const axios = require('axios');

// ===== Configuration =====
const CONFIG = {
  // Strategy params (match server.js defaults)
  MIN_EDGE: 10.0,
  MIN_DIVERGENCE: 10.0,
  KELLY_FRACTION: 0.25,
  USE_KELLY_SIZING: true,
  MAX_POSITION_SIZE: 25,
  TRADING_WINDOW: 4 * 60 * 1000, // 4 minutes in ms
  MIN_CONTRACT_PRICE: 0.48,
  MAX_CONTRACT_PRICE: 0.88,
  TREND_BOOST: 0.25,
  TREND_PENALTY: 0.40,
  MAX_TOTAL_OPEN_POSITIONS: 10,
  MAX_POSITIONS_PER_CONTRACT: 1,
  SLOT_DURATION: 900, // 15 min in seconds

  // Simulation params
  STARTING_BALANCE: 100,
  // Run with --conservative to test smaller sizing
  // This dramatically changes outcomes on binary options
  // Kalshi KXBTC15M market dynamics
  // Real-world observation: Kalshi contracts are illiquid, MMs reprice slowly
  // Price updates lag Binance by 30-120s, not 5s like liquid crypto exchanges
  KALSHI_LATENCY_SEC: 60,  // Average MM repricing lag (30-120s range)
  KALSHI_LATENCY_JITTER: 45, // Random jitter: lag = base +/- jitter
  KALSHI_SPREAD_PCT: 4,    // 4% bid/ask spread (illiquid market)
  KALSHI_FEE_RATE: 0.07,   // 7% fee on winnings (Kalshi standard)
  KALSHI_STALE_PRICE_PCT: 15, // 15% of the time, Kalshi price is very stale (>2min)
};

// ===== Normal CDF (Abramowitz & Stegun) =====
function normalCDF(x) {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t *
    Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  return 0.5 * (1.0 + sign * y);
}

// ===== Volatility Estimation =====
function estimateVolatility(prices, windowSamples) {
  const start = Math.max(0, prices.length - windowSamples);
  const slice = prices.slice(start);
  if (slice.length < 10) return 0.0015;

  const returns = [];
  for (let i = 1; i < slice.length; i++) {
    returns.push(Math.log(slice[i] / slice[i - 1]));
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(slice.length);
}

// ===== Kelly Criterion =====
function kellySize(edge, probability, fraction = 0.25) {
  if (probability <= 0.01 || probability >= 0.99) return 0;
  const b = (1 / (1 - probability)) - 1;
  const q = 1 - probability;
  const kelly = (b * probability - q) / b;
  return Math.max(0, Math.min(kelly * fraction, 0.25));
}

// ===== Trend Indicator (Simulated) =====
class SimTrend {
  constructor(config = CONFIG) {
    this.fastK = 2 / (720 + 1);
    this.slowK = 2 / (2700 + 1);
    this.fastEMA = null;
    this.slowEMA = null;
    this.samples = 0;
    this.rocWindow = [];
    this.rocWindowSize = 1800;
    this.rocThreshold = 0.02;
    this.boost = config.TREND_BOOST;
    this.penalty = config.TREND_PENALTY;
  }

  update(price) {
    if (this.fastEMA === null) {
      this.fastEMA = price;
      this.slowEMA = price;
    } else {
      this.fastEMA = price * this.fastK + this.fastEMA * (1 - this.fastK);
      this.slowEMA = price * this.slowK + this.slowEMA * (1 - this.slowK);
    }
    this.rocWindow.push(price);
    if (this.rocWindow.length > this.rocWindowSize) this.rocWindow.shift();
    this.samples++;
  }

  getTrend() {
    const warmup = this.samples >= 1350;
    if (!warmup) return { trend: 'NEUTRAL', warmup: false };

    const roc = this.rocWindow.length > 1
      ? ((this.rocWindow[this.rocWindow.length - 1] - this.rocWindow[0]) / this.rocWindow[0]) * 100
      : 0;

    let trend = 'NEUTRAL';
    if (this.fastEMA > this.slowEMA && roc > this.rocThreshold) trend = 'BULLISH';
    else if (this.fastEMA < this.slowEMA && roc < -this.rocThreshold) trend = 'BEARISH';

    return { trend, warmup: true, roc };
  }

  getMultiplier(side) {
    const { trend, warmup } = this.getTrend();
    if (!warmup || trend === 'NEUTRAL') return 1.0;

    const withTrend = (side === 'yes' && trend === 'BULLISH') || (side === 'no' && trend === 'BEARISH');
    const counterTrend = (side === 'yes' && trend === 'BEARISH') || (side === 'no' && trend === 'BULLISH');

    if (withTrend) return 1.0 + this.boost;
    if (counterTrend) return 1.0 - this.penalty;
    return 1.0;
  }
}

// ===== Simulated Kalshi Market =====
function simulateKalshiPricing(btcPrice, openPrice, timeRemainingMs, totalDurationMs, sigma, laggedBtcPrice) {
  // Kalshi market makers price contracts based on lagged price (not real-time Binance)
  const laggedMove = (laggedBtcPrice - openPrice) / openPrice;
  const timeRemaining = Math.max(0.001, timeRemainingMs / totalDurationMs);
  const remainingSigma = sigma * Math.sqrt(timeRemaining);

  let fairYes;
  if (remainingSigma < 0.00001) {
    fairYes = laggedMove > 0 ? 0.95 : 0.05;
  } else {
    const z = laggedMove / remainingSigma;
    fairYes = normalCDF(z);
  }

  fairYes = Math.max(0.05, Math.min(0.95, fairYes));
  const fairNo = 1 - fairYes;

  // Add spread (bid/ask around fair value)
  const halfSpread = CONFIG.KALSHI_SPREAD_PCT / 200;
  return {
    yesAsk: Math.min(0.95, fairYes + halfSpread),
    yesBid: Math.max(0.05, fairYes - halfSpread),
    noAsk: Math.min(0.95, fairNo + halfSpread),
    noBid: Math.max(0.05, fairNo - halfSpread),
    fairYes,
    fairNo,
  };
}

// ===== Fetch Binance Historical Data =====
async function fetchBinanceKlines(startMs, endMs) {
  const klines = [];
  let cursor = startMs;
  let retries = 0;

  console.log('Fetching historical BTC/USDT 1-minute candles from Binance...');

  while (cursor < endMs && retries < 3) {
    const url = 'https://api.binance.com/api/v3/klines';
    try {
      const resp = await axios.get(url, {
        params: {
          symbol: 'BTCUSDT',
          interval: '1m',
          startTime: cursor,
          endTime: endMs,
          limit: 1000,
        },
        timeout: 10000,
      });

      if (resp.data.length === 0) break;
      retries = 0; // Reset on success

      for (const k of resp.data) {
        klines.push({
          openTime: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          closeTime: k[6],
        });
      }

      cursor = resp.data[resp.data.length - 1][6] + 1;
      process.stdout.write(`\r  Fetched ${klines.length} candles (${new Date(cursor).toISOString().slice(0, 10)})...`);

      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      retries++;
      if (retries >= 3) {
        console.log(`\n  Binance API unavailable (${err.message}). Using synthetic GBM data.`);
        return []; // Trigger fallback
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`\n  Total: ${klines.length} candles (${((endMs - startMs) / 86400000).toFixed(1)} days)`);
  return klines;
}

// ===== Generate Synthetic BTC Data (GBM Fallback) =====
function generateSyntheticData(startMs, endMs) {
  console.log('Generating synthetic BTC price data using Geometric Brownian Motion...');

  const klines = [];
  // BTC annualized vol ~60-80%. Per-minute return std ~= 0.60 / sqrt(525600) ~= 0.083%
  const annualVol = 0.65;
  const minutesPerYear = 525600;
  const perMinuteVol = annualVol / Math.sqrt(minutesPerYear); // ~0.0009
  let price = 85000 + Math.random() * 10000;

  for (let t = startMs; t < endMs; t += 60000) {
    const open = price;
    // GBM: return = sigma * Z, no drift (short horizon)
    const z = gaussianRandom();
    price = price * (1 + perMinuteVol * z);

    // Simulate high/low within the minute
    const range = price * perMinuteVol * 1.5;
    const high = Math.max(open, price) + Math.abs(gaussianRandom()) * range * 0.5;
    const low = Math.min(open, price) - Math.abs(gaussianRandom()) * range * 0.5;

    klines.push({
      openTime: t,
      open,
      high,
      low,
      close: price,
      closeTime: t + 59999,
    });
  }

  console.log(`  Generated ${klines.length} synthetic candles (${((endMs - startMs) / 86400000).toFixed(1)} days)`);
  console.log(`  Price range: $${Math.min(...klines.map(k => k.low)).toFixed(0)} - $${Math.max(...klines.map(k => k.high)).toFixed(0)}`);
  return klines;
}

function gaussianRandom() {
  // Box-Muller transform
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// ===== Interpolate 1-second prices from 1-minute candles =====
function interpolatePrices(klines) {
  const prices = [];
  for (const k of klines) {
    // Linear interpolation from open to close within each minute
    for (let s = 0; s < 60; s++) {
      const t = s / 60;
      const price = k.open + (k.close - k.open) * t;
      prices.push({
        timestamp: k.openTime + s * 1000,
        price,
      });
    }
  }
  return prices;
}

// ===== Main Backtest Engine =====
async function runBacktest(options = {}) {
  const days = options.days || 7;
  const verbose = options.verbose || false;

  const endMs = options.start
    ? new Date(options.start).getTime() + days * 86400000
    : Date.now();
  const startMs = endMs - days * 86400000;

  // Fetch data (falls back to synthetic GBM if Binance unavailable)
  let klines = await fetchBinanceKlines(startMs, endMs);
  const usingSynthetic = klines.length < 100;
  if (usingSynthetic) {
    klines = generateSyntheticData(startMs, endMs);
  }

  const prices = interpolatePrices(klines);
  console.log(`Interpolated ${prices.length} 1-second price ticks\n`);

  // State
  let balance = CONFIG.STARTING_BALANCE;
  const trades = [];
  const signals = [];
  const trend = new SimTrend();

  // Price history for volatility (rolling 1-hour window)
  const priceHistory = [];

  // Generate 15-minute contract windows
  const slotMs = CONFIG.SLOT_DURATION * 1000;
  const firstSlotStart = Math.ceil(prices[0].timestamp / slotMs) * slotMs;

  let totalSlots = 0;
  let slotsWithSignals = 0;
  let totalSignals = 0;

  // Strategy counters
  const stratStats = {
    DIRECTIONAL_YES: { signals: 0, trades: 0, wins: 0, losses: 0, pnl: 0 },
    DIRECTIONAL_NO: { signals: 0, trades: 0, wins: 0, losses: 0, pnl: 0 },
    POLY_ARB_YES: { signals: 0, trades: 0, wins: 0, losses: 0, pnl: 0 },
    DUAL_SIDE: { signals: 0, trades: 0, wins: 0, losses: 0, pnl: 0 },
  };

  // Process each 15-minute slot
  for (let slotStart = firstSlotStart; slotStart + slotMs < prices[prices.length - 1].timestamp; slotStart += slotMs) {
    const slotEnd = slotStart + slotMs;
    totalSlots++;

    // Get open price (first tick of slot)
    const openTick = prices.find(p => p.timestamp >= slotStart);
    if (!openTick) continue;
    const openPrice = openTick.price;

    // Get close price (last tick before slot end) — determines settlement
    const closeTick = [...prices].reverse().find(p => p.timestamp < slotEnd);
    if (!closeTick) continue;
    const settledUp = closeTick.price > openPrice;

    // Warm up trend indicator with slot's price data
    const slotPrices = prices.filter(p => p.timestamp >= slotStart && p.timestamp < slotEnd);
    for (const tick of slotPrices) {
      trend.update(tick.price);
      priceHistory.push(tick.price);
      if (priceHistory.length > 3600) priceHistory.shift();
    }

    // Scan for signals within trading window (first 4 minutes)
    const windowEnd = slotStart + CONFIG.TRADING_WINDOW;
    let slotSignaled = false;

    // Sample every 30 seconds within trading window for signal generation
    for (let scanTime = slotStart + 30000; scanTime < windowEnd; scanTime += 30000) {
      const scanTick = prices.find(p => p.timestamp >= scanTime);
      if (!scanTick) continue;

      const btcPrice = scanTick.price;
      const timeRemainingMs = slotEnd - scanTime;
      const totalDurationMs = slotMs;

      // Get lagged BTC price — Kalshi MMs reprice 30-120s behind Binance
      // On illiquid KXBTC15M contracts, this is the primary source of edge
      const jitter = (Math.random() * 2 - 1) * CONFIG.KALSHI_LATENCY_JITTER;
      const isStale = Math.random() < (CONFIG.KALSHI_STALE_PRICE_PCT / 100);
      const lagSec = isStale ? 150 : Math.max(10, CONFIG.KALSHI_LATENCY_SEC + jitter);
      const lagTime = scanTime - lagSec * 1000;
      const lagTick = [...prices].reverse().find(p => p.timestamp <= lagTime);
      const laggedPrice = lagTick ? lagTick.price : btcPrice;

      // Volatility estimation (from price history)
      const sigma = estimateVolatility(priceHistory, CONFIG.SLOT_DURATION);

      // Simulate Kalshi market pricing (based on lagged price)
      const kalshi = simulateKalshiPricing(btcPrice, openPrice, timeRemainingMs, totalDurationMs, sigma, laggedPrice);

      // Model probability (our view, based on real-time Binance price)
      const move = (btcPrice - openPrice) / openPrice;
      const timeRemaining = Math.max(0.001, timeRemainingMs / totalDurationMs);
      const remainingSigma = sigma * Math.sqrt(timeRemaining);

      let probUp, probDown;
      if (remainingSigma < 0.00001) {
        probUp = move > 0 ? 0.99 : 0.01;
        probDown = 1 - probUp;
      } else {
        const z = move / remainingSigma;
        probUp = Math.max(0.01, Math.min(0.99, normalCDF(z)));
        probDown = 1 - probUp;
      }

      // ===== Strategy 1: DIRECTIONAL =====
      const modelEdgeYes = (probUp - kalshi.yesAsk) * 100;
      const modelEdgeNo = (probDown - kalshi.noAsk) * 100;
      const trendMultYes = trend.getMultiplier('yes');
      const trendMultNo = trend.getMultiplier('no');
      const adjEdgeYes = modelEdgeYes * trendMultYes;
      const adjEdgeNo = modelEdgeNo * trendMultNo;

      const yesInRange = kalshi.yesAsk >= CONFIG.MIN_CONTRACT_PRICE && kalshi.yesAsk <= CONFIG.MAX_CONTRACT_PRICE;
      const noInRange = kalshi.noAsk >= CONFIG.MIN_CONTRACT_PRICE && kalshi.noAsk <= CONFIG.MAX_CONTRACT_PRICE;

      // BUY YES signal
      if (adjEdgeYes > CONFIG.MIN_DIVERGENCE && yesInRange && balance > 1) {
        const size = CONFIG.USE_KELLY_SIZING ? kellySize(adjEdgeYes / 100, probUp, CONFIG.KELLY_FRACTION) : 0.1;
        const positionDollars = Math.min(size * balance, CONFIG.MAX_POSITION_SIZE, balance);
        const contracts = Math.max(1, Math.floor(positionDollars / kalshi.yesAsk));
        const cost = contracts * kalshi.yesAsk;

        if (cost <= balance) {
          // Execute trade
          const won = settledUp; // YES wins if price went up
          const payout = won ? contracts * 1.0 : 0;
          const fee = won ? payout * CONFIG.KALSHI_FEE_RATE : 0;
          const pnl = payout - fee - cost;

          balance += pnl;
          slotSignaled = true;
          totalSignals++;

          const strat = stratStats.DIRECTIONAL_YES;
          strat.signals++;
          strat.trades++;
          if (won) strat.wins++; else strat.losses++;
          strat.pnl += pnl;

          trades.push({
            type: 'DIRECTIONAL_YES', slot: totalSlots, side: 'yes',
            price: kalshi.yesAsk, contracts, cost, payout, pnl, won,
            edge: adjEdgeYes, probUp, move: move * 100, btcPrice, openPrice,
            trendMult: trendMultYes,
          });

          if (verbose) {
            console.log(`  [${new Date(scanTime).toISOString().slice(11, 19)}] BUY YES x${contracts} @ ${(kalshi.yesAsk * 100).toFixed(0)}c | Edge: ${adjEdgeYes.toFixed(1)}% | P(UP)=${(probUp * 100).toFixed(0)}% | ${won ? 'WIN' : 'LOSS'} ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
          }
        }
      }

      // BUY NO signal
      if (adjEdgeNo > CONFIG.MIN_DIVERGENCE && noInRange && balance > 1) {
        const size = CONFIG.USE_KELLY_SIZING ? kellySize(adjEdgeNo / 100, probDown, CONFIG.KELLY_FRACTION) : 0.1;
        const positionDollars = Math.min(size * balance, CONFIG.MAX_POSITION_SIZE, balance);
        const contracts = Math.max(1, Math.floor(positionDollars / kalshi.noAsk));
        const cost = contracts * kalshi.noAsk;

        if (cost <= balance) {
          const won = !settledUp; // NO wins if price went down
          const payout = won ? contracts * 1.0 : 0;
          const fee = won ? payout * CONFIG.KALSHI_FEE_RATE : 0;
          const pnl = payout - fee - cost;

          balance += pnl;
          slotSignaled = true;
          totalSignals++;

          const strat = stratStats.DIRECTIONAL_NO;
          strat.signals++;
          strat.trades++;
          if (won) strat.wins++; else strat.losses++;
          strat.pnl += pnl;

          trades.push({
            type: 'DIRECTIONAL_NO', slot: totalSlots, side: 'no',
            price: kalshi.noAsk, contracts, cost, payout, pnl, won,
            edge: adjEdgeNo, probDown, move: move * 100, btcPrice, openPrice,
            trendMult: trendMultNo,
          });

          if (verbose) {
            console.log(`  [${new Date(scanTime).toISOString().slice(11, 19)}] BUY NO  x${contracts} @ ${(kalshi.noAsk * 100).toFixed(0)}c | Edge: ${adjEdgeNo.toFixed(1)}% | P(DOWN)=${(probDown * 100).toFixed(0)}% | ${won ? 'WIN' : 'LOSS'} ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
          }
        }
      }

      // ===== Strategy 3: DUAL-SIDE ARBITRAGE =====
      const combinedCost = kalshi.yesAsk + kalshi.noAsk;
      if (combinedCost < 0.98 && balance > 2) {
        const maxPrice = Math.max(kalshi.yesAsk, kalshi.noAsk);
        const positionDollars = Math.min(CONFIG.MAX_POSITION_SIZE / 2, balance / 2);
        const contracts = Math.max(1, Math.floor(positionDollars / maxPrice));
        const cost = contracts * combinedCost;

        if (cost <= balance) {
          const payout = contracts * 1.0; // One side always wins
          const fee = payout * CONFIG.KALSHI_FEE_RATE;
          const pnl = payout - fee - cost;

          balance += pnl;
          slotSignaled = true;
          totalSignals++;

          const strat = stratStats.DUAL_SIDE;
          strat.signals++;
          strat.trades++;
          if (pnl > 0) strat.wins++; else strat.losses++;
          strat.pnl += pnl;

          trades.push({
            type: 'DUAL_SIDE', slot: totalSlots, side: 'both',
            price: combinedCost, contracts, cost, payout, pnl, won: pnl > 0,
            edge: (1 - combinedCost) * 100,
          });

          if (verbose) {
            console.log(`  [${new Date(scanTime).toISOString().slice(11, 19)}] DUAL    x${contracts} @ ${(combinedCost * 100).toFixed(0)}c | Spread: ${((1 - combinedCost) * 100).toFixed(1)}% | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
          }
        }
      }

      // Only take one signal per scan tick per strategy to avoid over-trading
      if (slotSignaled) break;
    }

    if (slotSignaled) slotsWithSignals++;

    // Progress
    if (totalSlots % 100 === 0) {
      process.stdout.write(`\rProcessed ${totalSlots} slots | ${trades.length} trades | Balance: $${balance.toFixed(2)}...`);
    }
  }

  // ===== Print Results =====
  console.log('\n');
  printReport(trades, stratStats, totalSlots, slotsWithSignals, totalSignals, balance);
}

function printReport(trades, stratStats, totalSlots, slotsWithSignals, totalSignals, finalBalance) {
  const wins = trades.filter(t => t.won);
  const losses = trades.filter(t => !t.won);
  const totalPnL = trades.reduce((sum, t) => sum + t.pnl, 0);
  const avgEdge = trades.length > 0 ? trades.reduce((sum, t) => sum + t.edge, 0) / trades.length : 0;

  // Drawdown calculation
  let peak = CONFIG.STARTING_BALANCE;
  let maxDrawdown = 0;
  let runningBalance = CONFIG.STARTING_BALANCE;
  for (const t of trades) {
    runningBalance += t.pnl;
    if (runningBalance > peak) peak = runningBalance;
    const dd = (peak - runningBalance) / peak * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Streaks
  let maxWinStreak = 0, maxLoseStreak = 0, streak = 0;
  for (const t of trades) {
    if (t.won) { streak = streak > 0 ? streak + 1 : 1; }
    else { streak = streak < 0 ? streak - 1 : -1; }
    if (streak > maxWinStreak) maxWinStreak = streak;
    if (-streak > maxLoseStreak) maxLoseStreak = -streak;
  }

  // Sharpe-like ratio (daily returns)
  const dailyPnL = {};
  for (const t of trades) {
    const day = Math.floor(t.slot / 96); // ~96 slots per day
    dailyPnL[day] = (dailyPnL[day] || 0) + t.pnl;
  }
  const dailyReturns = Object.values(dailyPnL);
  const avgDaily = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const dailyStd = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((a, r) => a + (r - avgDaily) ** 2, 0) / (dailyReturns.length - 1))
    : 0;
  const sharpe = dailyStd > 0 ? (avgDaily / dailyStd) * Math.sqrt(365) : 0;

  console.log('='.repeat(70));
  console.log('  KALSHIBOT BACKTEST REPORT');
  console.log('='.repeat(70));
  console.log();
  console.log(`  Period:           ${totalSlots} x 15-min slots`);
  console.log(`  Starting Balance: $${CONFIG.STARTING_BALANCE.toFixed(2)}`);
  console.log(`  Final Balance:    $${finalBalance.toFixed(2)}`);
  console.log(`  Total P&L:        ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)} (${((finalBalance / CONFIG.STARTING_BALANCE - 1) * 100).toFixed(1)}%)`);
  console.log();
  console.log('--- Trade Summary ---');
  console.log(`  Total Trades:     ${trades.length}`);
  console.log(`  Win Rate:         ${trades.length > 0 ? ((wins.length / trades.length) * 100).toFixed(1) : 0}% (${wins.length}W / ${losses.length}L)`);
  console.log(`  Avg Edge:         ${avgEdge.toFixed(2)}%`);
  console.log(`  Avg Win:          +$${wins.length > 0 ? (wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toFixed(3) : '0.000'}`);
  console.log(`  Avg Loss:         -$${losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(3) : '0.000'}`);
  console.log(`  Best Trade:       +$${trades.length > 0 ? Math.max(...trades.map(t => t.pnl)).toFixed(3) : '0.000'}`);
  console.log(`  Worst Trade:      -$${trades.length > 0 ? Math.abs(Math.min(...trades.map(t => t.pnl))).toFixed(3) : '0.000'}`);
  console.log();
  console.log('--- Risk Metrics ---');
  console.log(`  Max Drawdown:     ${maxDrawdown.toFixed(2)}%`);
  console.log(`  Max Win Streak:   ${maxWinStreak}`);
  console.log(`  Max Loss Streak:  ${maxLoseStreak}`);
  console.log(`  Sharpe Ratio:     ${sharpe.toFixed(2)} (annualized)`);
  console.log(`  Profit Factor:    ${losses.length > 0 && wins.length > 0
    ? (wins.reduce((s, t) => s + t.pnl, 0) / Math.abs(losses.reduce((s, t) => s + t.pnl, 0))).toFixed(2)
    : 'N/A'}`);
  console.log();
  console.log('--- Strategy Breakdown ---');

  for (const [name, s] of Object.entries(stratStats)) {
    if (s.trades === 0) continue;
    const wr = ((s.wins / s.trades) * 100).toFixed(1);
    console.log(`  ${name.padEnd(20)} ${s.trades} trades | ${wr}% WR | P&L: ${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)}`);
  }

  console.log();
  console.log('--- Signal Activity ---');
  console.log(`  Slots with signals: ${slotsWithSignals}/${totalSlots} (${((slotsWithSignals / totalSlots) * 100).toFixed(1)}%)`);
  console.log(`  Signals per slot:   ${(totalSignals / totalSlots).toFixed(2)}`);
  console.log();

  // Edge distribution
  if (trades.length > 0) {
    const edges = trades.map(t => t.edge).sort((a, b) => a - b);
    console.log('--- Edge Distribution ---');
    console.log(`  Min:    ${edges[0].toFixed(1)}%`);
    console.log(`  25th:   ${edges[Math.floor(edges.length * 0.25)].toFixed(1)}%`);
    console.log(`  Median: ${edges[Math.floor(edges.length * 0.5)].toFixed(1)}%`);
    console.log(`  75th:   ${edges[Math.floor(edges.length * 0.75)].toFixed(1)}%`);
    console.log(`  Max:    ${edges[edges.length - 1].toFixed(1)}%`);
  }

  // Win rate by edge bucket
  if (trades.length > 10) {
    console.log();
    console.log('--- Win Rate by Edge Bucket ---');
    const buckets = [
      { label: '10-15%', min: 10, max: 15 },
      { label: '15-20%', min: 15, max: 20 },
      { label: '20-30%', min: 20, max: 30 },
      { label: '30-50%', min: 30, max: 50 },
      { label: '50%+  ', min: 50, max: Infinity },
    ];
    for (const b of buckets) {
      const bt = trades.filter(t => t.edge >= b.min && t.edge < b.max);
      if (bt.length === 0) continue;
      const bw = bt.filter(t => t.won).length;
      const bpnl = bt.reduce((s, t) => s + t.pnl, 0);
      console.log(`  ${b.label}: ${bt.length} trades | ${((bw / bt.length) * 100).toFixed(0)}% WR | P&L: ${bpnl >= 0 ? '+' : ''}$${bpnl.toFixed(2)}`);
    }
  }

  console.log();
  console.log('='.repeat(70));

  // Verdict
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  if (totalPnL > 0 && winRate > 52) {
    console.log('  VERDICT: PROFITABLE - Strategy shows positive edge');
  } else if (totalPnL > 0) {
    console.log('  VERDICT: MARGINALLY PROFITABLE - Positive P&L but thin edge');
  } else if (winRate > 50) {
    console.log('  VERDICT: BREAK-EVEN - Win rate positive but fees eat edge');
  } else {
    console.log('  VERDICT: UNPROFITABLE - Strategy does not show edge');
  }
  console.log('='.repeat(70));
}

// ===== CLI =====
async function main() {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) {
      const days = parseInt(args[i + 1], 10);
      if (!Number.isInteger(days) || days <= 0 || days > 3650) {
        console.error('Invalid --days value: must be a positive integer (<= 3650)');
        process.exit(1);
      }
      options.days = days;
    }
    if (args[i] === '--start' && args[i + 1]) {
      const start = args[i + 1];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || isNaN(new Date(start).getTime())) {
        console.error('Invalid --start value: expected date format YYYY-MM-DD');
        process.exit(1);
      }
      options.start = start;
    }
    if (args[i] === '--verbose' || args[i] === '-v') options.verbose = true;
    if (args[i] === '--conservative') {
      CONFIG.MAX_POSITION_SIZE = 3;
      CONFIG.KELLY_FRACTION = 0.08;
      CONFIG.MIN_DIVERGENCE = 12.0;
    }
    if (args[i] === '--flat') {
      // Flat 1-contract sizing to isolate pure signal quality
      CONFIG.USE_KELLY_SIZING = false;
      CONFIG.MAX_POSITION_SIZE = 1;
    }
    if (args[i] === '--optimal') {
      // Optimal settings based on backtest analysis:
      // - Cap entry price at 65c (payoff ratio > 0.5)
      // - Conservative Kelly (8%)
      // - Higher edge threshold (15%)
      CONFIG.MAX_CONTRACT_PRICE = 0.65;
      CONFIG.MIN_CONTRACT_PRICE = 0.35;
      CONFIG.KELLY_FRACTION = 0.08;
      CONFIG.MIN_DIVERGENCE = 15.0;
      CONFIG.MAX_POSITION_SIZE = 5;
    }
    if (args[i] === '--aggressive') {
      CONFIG.MAX_POSITION_SIZE = 25;
      CONFIG.KELLY_FRACTION = 0.30;
      CONFIG.MIN_DIVERGENCE = 8.0;
    }
    if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node backtest/backtest.js [options]');
      console.log('  --days N     Number of days to backtest (default: 7)');
      console.log('  --start DATE Start date (e.g., 2025-06-01)');
      console.log('  --verbose    Show individual trades');
      console.log('  --help       Show this help');
      return;
    }
  }

  console.log('\n  KALSHIBOT BACKTESTER\n');
  console.log(`  Config: MinDiv=${CONFIG.MIN_DIVERGENCE}% | MinEdge=${CONFIG.MIN_EDGE}% | Kelly=${CONFIG.KELLY_FRACTION} | MaxPos=$${CONFIG.MAX_POSITION_SIZE}`);
  console.log(`  Latency model: Kalshi ${CONFIG.KALSHI_LATENCY_SEC}s behind Binance | Spread: ${CONFIG.KALSHI_SPREAD_PCT}%`);
  console.log();

  await runBacktest(options);
}

main().catch(err => {
  console.error('Backtest error:', err.message);
  process.exit(1);
});

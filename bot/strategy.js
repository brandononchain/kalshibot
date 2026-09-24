/**
 * Strategy Engine
 *
 * Three trading modes:
 * 1. DIRECTIONAL: Use Binance spot price to predict UP/DOWN, buy the winning
 *    side before Polymarket/Kalshi update (exploit 3-7s lag)
 * 2. ARBITRAGE: When YES_ask + NO_ask < $1, buy both for guaranteed profit
 * 3. TAKE_PROFIT: Sell winning positions before settlement when profitable
 *
 * Implied probability model uses normal distribution CDF
 * with realized volatility from Binance feed.
 */

const { estimateTakerFeeDollars, expectedValuePerContract, kellyBankrollFraction } = require('../lib/kalshi-economics');

class Strategy {
  constructor(state, config, binanceFeed, trendIndicator = null) {
    this.state = state;
    this.config = config;
    this.binanceFeed = binanceFeed;
    this.trendIndicator = trendIndicator;

    this.minEdge = config.MIN_EDGE || 10.0;
    this.minDivergence = config.MIN_DIVERGENCE || 10.0;
    this.kellyFraction = config.KELLY_FRACTION || 0.30;
    this.useKelly = config.USE_KELLY_SIZING !== false;
    this.maxPositionSize = config.MAX_POSITION_SIZE || 35;
    this.tradingWindow = (config.TRADING_WINDOW || 4) * 60 * 1000; // minutes to ms

    // Price filters — skip contracts outside the profitable range
    this.minContractPrice = (config.MIN_CONTRACT_PRICE ?? 35) / 100; // cents to decimal
    this.maxContractPrice = (config.MAX_CONTRACT_PRICE ?? 65) / 100;

    // 1H trend integration — multiplicative edge modifier
    this.trendEnabled = config.TREND_ENABLED !== false;
    this.trendBoost = config.TREND_BOOST || 0.25;     // with-trend: edge * 1.25
    this.trendPenalty = config.TREND_PENALTY || 0.40;  // counter-trend: edge * 0.60
  }

  /**
   * Returns an edge multiplier based on whether the trade aligns with the 1H trend.
   * YES + BULLISH = with-trend (boost), YES + BEARISH = counter-trend (penalty), etc.
   */
  getTrendMultiplier(side) {
    if (!this.trendEnabled || !this.trendIndicator) return 1.0;

    const { trend, warmup } = this.trendIndicator.getTrend();
    if (!warmup || trend === 'NEUTRAL') return 1.0;

    const withTrend =
      (side === 'yes' && trend === 'BULLISH') ||
      (side === 'no' && trend === 'BEARISH');
    const counterTrend =
      (side === 'yes' && trend === 'BEARISH') ||
      (side === 'no' && trend === 'BULLISH');

    if (withTrend) return 1.0 + this.trendBoost;
    if (counterTrend) return 1.0 - this.trendPenalty;
    return 1.0;
  }

  // Normal CDF approximation (Abramowitz & Stegun)
  normalCDF(x) {
    if (x < -8) return 0;
    if (x > 8) return 1;

    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t *
      Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);

    return 0.5 * (1.0 + sign * y);
  }

  /**
   * Calculate implied probability of UP given current spot move
   *
   * Model: BTC price follows geometric Brownian motion
   * P(UP) = P(S_T > S_0) = Phi(move / (sigma * sqrt(timeRemaining)))
   *
   * Where:
   * - move = (currentPrice - openPrice) / openPrice
   * - sigma = realized volatility scaled to remaining time
   * - timeRemaining = fraction of total time remaining
   */
  calculateImpliedProbability(currentPrice, openPrice, timeRemainingMs, totalDurationMs) {
    if (!currentPrice || !openPrice || openPrice === 0) return { probUp: 0.5, probDown: 0.5 };

    const move = (currentPrice - openPrice) / openPrice;
    const timeRemaining = Math.max(0.001, timeRemainingMs / totalDurationMs);

    // Get realized volatility from Binance feed, scaled to total duration
    const totalDurationSec = totalDurationMs / 1000;
    const sigma = this.binanceFeed.getRecentVolatility(totalDurationSec);

    // Remaining volatility
    const remainingSigma = sigma * Math.sqrt(timeRemaining);

    if (remainingSigma < 0.00001) {
      // Almost no time left - price basically determines outcome
      return { probUp: move > 0 ? 0.99 : 0.01, probDown: move > 0 ? 0.01 : 0.99 };
    }

    // Z-score: how many standard deviations is current move from zero
    const z = move / remainingSigma;
    const probUp = this.normalCDF(z);
    const probDown = 1 - probUp;

    return {
      probUp: Math.max(0.01, Math.min(0.99, probUp)),
      probDown: Math.max(0.01, Math.min(0.99, probDown)),
      move,
      movePct: move * 100,
      z,
      sigma,
      remainingSigma,
    };
  }

  // Kelly criterion position sizing
  kellySize(edge, probability, executablePrice, feeMultiplier = 1) {
    const feeRate = this.config.KALSHI_TAKER_FEE_RATE ?? 0.07;
    const fee = estimateTakerFeeDollars(executablePrice, 1, feeRate, feeMultiplier);
    return kellyBankrollFraction(probability, executablePrice, fee, this.kellyFraction);
  }

  /**
   * Generate all trading signals for current market state
   *
   * Returns array of signals: { type, ticker, side, price, edge, contracts, reason }
   */
  generateSignals(kalshiMarkets, polyCache) {
    const signals = [];
    const now = Date.now();
    const btcPrice = this.state.btcPrice.binance;

    if (!btcPrice) return signals;

    for (const market of kalshiMarkets) {
      const timeRemaining = market.closeTime - now;
      const totalDuration = market.closeTime - market.openTime;
      const timeSinceOpen = now - market.openTime;

      // Only trade within trading window (default 4 minutes from open)
      if (timeSinceOpen > this.tradingWindow || timeRemaining < 30000) continue;

      // Get open price for this market
      const openPrice = this.state.marketOpenPrices[market.ticker];
      const referenceMeta = this.state.marketOpenPriceMeta?.[market.ticker];
      if (!openPrice || !referenceMeta || referenceMeta.source !== 'binance_at_market_open' || Math.abs(referenceMeta.timestamp - market.openTime) > 2500) continue;

      // Get Kalshi prices
      if (!market.yesAsk || !market.noAsk) continue;

      // Price filter — skip contracts outside the profitable range
      // Data shows: <48c entries have 62% WR (model miscalibrated), >88c entries have declining returns
      const yesInRange = market.yesAsk >= this.minContractPrice && market.yesAsk <= this.maxContractPrice;
      const noInRange = market.noAsk >= this.minContractPrice && market.noAsk <= this.maxContractPrice;

      // Get Polymarket prices
      const poly = polyCache ? polyCache(market.closeTime) : null;

      // Calculate model probability
      const prob = this.calculateImpliedProbability(btcPrice, openPrice, timeRemaining, totalDuration);

      // Get trend data for model update + edge adjustment
      const trendData = this.trendIndicator ? this.trendIndicator.getTrend() : {};

      // Update state model (includes trend for UI)
      this.state.updateModel({
        impliedProbUp: prob.probUp,
        impliedProbDown: prob.probDown,
        spotMove: prob.move,
        spotMovePct: prob.movePct,
        timeRemaining: timeRemaining / 1000,
        volatility: prob.sigma,
        trend: trendData.trend || 'NEUTRAL',
        trendStrength: trendData.strength || 0,
        trendROC: trendData.roc || 0,
        trendWarmup: trendData.warmup || false,
      });

      // ===== STRATEGY 1: DIRECTIONAL (Binance spot divergence) =====
      // Compare model probability with Kalshi contract price
      const kalshiYesImplied = market.yesAsk; // What you'd pay for YES
      const feeRate = this.config.KALSHI_TAKER_FEE_RATE ?? 0.07;
      const feeMultiplier = market.feeMultiplier ?? 1;
      const modelEdgeYes = expectedValuePerContract(prob.probUp, market.yesAsk, estimateTakerFeeDollars(market.yesAsk, 1, feeRate, feeMultiplier)) * 100;
      const modelEdgeNo = expectedValuePerContract(prob.probDown, market.noAsk, estimateTakerFeeDollars(market.noAsk, 1, feeRate, feeMultiplier)) * 100;

      // Apply 1H trend multiplier to DIRECTIONAL edges
      const trendMultYes = this.getTrendMultiplier('yes');
      const trendMultNo = this.getTrendMultiplier('no');
      const adjustedEdgeYes = modelEdgeYes;
      const adjustedEdgeNo = modelEdgeNo;
      const currentTrend = trendData.trend || 'NEUTRAL';

      // BUY YES: model thinks UP is more likely than Kalshi price implies
      if (adjustedEdgeYes > this.minDivergence && yesInRange) {
        const size = this.useKelly
          ? this.kellySize(adjustedEdgeYes / 100, prob.probUp, market.yesAsk, market.feeMultiplier ?? 1)
          : 1;
        const positionDollars = Math.min(
          size * this.state.balance.available,
          this.maxPositionSize,
          this.state.balance.available
        );
        const contracts = Math.max(1, Math.floor(positionDollars / (market.yesAsk + estimateTakerFeeDollars(market.yesAsk, 1, this.config.KALSHI_TAKER_FEE_RATE ?? 0.07, market.feeMultiplier ?? 1))));

        signals.push({
          type: 'DIRECTIONAL_YES',
          ticker: market.ticker,
          side: 'yes',
          priceCents: market.yesAskCents || Math.round(market.yesAsk * 100),
          priceDecimal: market.yesAsk,
          edge: adjustedEdgeYes,
          contracts,
          modelProb: prob.probUp,
          reason: `Spot +${(prob.movePct || 0).toFixed(3)}% | Model ${(prob.probUp * 100).toFixed(0)}% vs Kalshi ${(kalshiYesImplied * 100).toFixed(0)}% | 1H: ${currentTrend}${trendMultYes !== 1.0 ? ' (' + trendMultYes.toFixed(2) + 'x)' : ''}`,
          closeTime: market.closeTime,
          executionMode: 'taker',
        });
      }

      // BUY NO: model thinks DOWN is more likely
      if (adjustedEdgeNo > this.minDivergence && noInRange) {
        const size = this.useKelly
          ? this.kellySize(adjustedEdgeNo / 100, prob.probDown, market.noAsk, market.feeMultiplier ?? 1)
          : 1;
        const positionDollars = Math.min(
          size * this.state.balance.available,
          this.maxPositionSize,
          this.state.balance.available
        );
        const contracts = Math.max(1, Math.floor(positionDollars / (market.noAsk + estimateTakerFeeDollars(market.noAsk, 1, this.config.KALSHI_TAKER_FEE_RATE ?? 0.07, market.feeMultiplier ?? 1))));

        signals.push({
          type: 'DIRECTIONAL_NO',
          ticker: market.ticker,
          side: 'no',
          priceCents: market.noAskCents || Math.round(market.noAsk * 100),
          priceDecimal: market.noAsk,
          edge: adjustedEdgeNo,
          contracts,
          modelProb: prob.probDown,
          reason: `Spot ${(prob.movePct || 0).toFixed(3)}% | Model ${(prob.probDown * 100).toFixed(0)}% vs Kalshi ${(market.noAsk * 100).toFixed(0)}% | 1H: ${currentTrend}${trendMultNo !== 1.0 ? ' (' + trendMultNo.toFixed(2) + 'x)' : ''}`,
          closeTime: market.closeTime,
          executionMode: 'taker',
        });
      }

      // ===== STRATEGY 2: POLYMARKET ARBITRAGE =====
      if (poly) {
        const polyFairUp = poly.upSell;
        const polyFairDown = poly.downMid;

        // Buy YES on Kalshi if Polymarket says it's worth more
        // Require higher edge for poly arb (1.5x base) — data shows poly signals are less reliable
        const polyEdgeYes = expectedValuePerContract(polyFairUp, market.yesAsk, estimateTakerFeeDollars(market.yesAsk, 1, this.config.KALSHI_TAKER_FEE_RATE ?? 0.07)) * 100;
        if (polyEdgeYes > this.minEdge * 1.5 && yesInRange) {
          const size = this.useKelly
            ? this.kellySize(polyEdgeYes / 100, polyFairUp, market.yesAsk)
            : 1;
          const positionDollars = Math.min(
            size * this.state.balance.available,
            this.maxPositionSize
          );
          const contracts = Math.max(1, Math.floor(positionDollars / market.yesAsk));

          signals.push({
            type: 'POLY_ARB_YES',
            ticker: market.ticker,
            side: 'yes',
            priceCents: market.yesAskCents || Math.round(market.yesAsk * 100),
            priceDecimal: market.yesAsk,
            edge: polyEdgeYes,
            contracts,
            modelProb: polyFairUp,
            reason: `Poly UP mid=${(polyFairUp * 100).toFixed(1)}% vs Kalshi ask=${(market.yesAsk * 100).toFixed(1)}%`,
            closeTime: market.closeTime,
            executionMode: 'taker',
          });
        }

        // POLY_ARB_NO disabled — data shows 25% win rate (1W/3L), actively harmful
      }

      // Disabled: the two sides are separate orders and are not atomic.
    }

    // Sort by edge (highest first)
    signals.sort((a, b) => b.edge - a.edge);

    return signals;
  }

  /**
   * Check open positions for take-profit opportunities
   * Sell before settlement if position is profitable enough
   */
  generateTakeProfitSignals(openPositions, kalshiMarkets) {
    const signals = [];

    for (const pos of openPositions) {
      const market = kalshiMarkets.find(m => m.ticker === pos.ticker);
      if (!market) continue;

      const now = Date.now();
      const timeRemaining = pos.closeTime - now;

      // Only take profit if enough time remains (>30s) and position is in profit
      if (timeRemaining < 30000) continue;

      let currentValue, entryPrice;

      if (pos.side === 'yes') {
        currentValue = market.yesBid; // What we could sell for
        entryPrice = pos.priceDecimal;
      } else {
        currentValue = market.noBid;
        entryPrice = pos.priceDecimal;
      }

      if (!currentValue || currentValue <= 0) continue;

      const profitPct = ((currentValue - entryPrice) / entryPrice) * 100;

      // Take profit if >15% gain or if position has >50% of max possible gain
      const maxGain = 1 - entryPrice;
      const gainFraction = (currentValue - entryPrice) / maxGain;

      if (profitPct > 15 || gainFraction > 0.5) {
        signals.push({
          type: 'TAKE_PROFIT',
          orderId: pos.orderId,
          ticker: pos.ticker,
          side: pos.side,
          sellPriceCents: Math.round(currentValue * 100),
          sellPriceDecimal: currentValue,
          contracts: pos.filledContracts || pos.contracts,
          profitPct,
          reason: `Take profit: bought@${(entryPrice * 100).toFixed(0)}c sell@${(currentValue * 100).toFixed(0)}c (+${profitPct.toFixed(1)}%)`,
        });
      }
    }

    return signals;
  }
}

module.exports = Strategy;

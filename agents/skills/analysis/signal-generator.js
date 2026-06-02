/**
 * SignalGenerator Skill
 *
 * Generates trading signals by composing probability model, trend analysis,
 * and cross-market price data. This is the analysis "brain" that identifies
 * trading opportunities across three strategies:
 *
 *  1. DIRECTIONAL — Binance spot divergence from Kalshi contract price
 *  2. POLY_ARB    — Polymarket fair value exceeds Kalshi ask
 *  3. DUAL_SIDE   — YES + NO ask < $1 (guaranteed profit)
 *
 * Also generates take-profit signals for open positions.
 *
 * Capabilities: generate-signals, generate-take-profit-signals
 */

const BaseSkill = require('../../core/base-skill');
const tc = require('../../../bot/tradecafe');

class SignalGenerator extends BaseSkill {
  constructor() {
    super({
      name: 'signal-generator',
      description: 'Generates trading signals from market data, probability model, and trend analysis',
      domain: 'analysis',
      capabilities: ['generate-signals', 'generate-take-profit-signals'],
      dependencies: ['state-manager', 'binance-price-feed', 'polymarket-price-feed', 'probability-model', 'trend-analysis'],
    });

    // Configured in initialize()
    this.minEdge = 10.0;
    this.minDivergence = 10.0;
    this.kellyFraction = 0.25;
    this.useKelly = true;
    this.maxPositionSize = 25;
    this.tradingWindow = 4 * 60 * 1000;
    this.minContractPrice = 0.48;
    this.maxContractPrice = 0.88;
  }

  async initialize(context) {
    await super.initialize(context);
    const config = context.config;

    this.minEdge = config.MIN_EDGE || 10.0;
    this.minDivergence = config.MIN_DIVERGENCE || 10.0;
    this.kellyFraction = config.KELLY_FRACTION || 0.25;
    this.useKelly = config.USE_KELLY_SIZING !== false;
    this.maxPositionSize = config.MAX_POSITION_SIZE || 25;
    this.tradingWindow = (config.TRADING_WINDOW || 4) * 60 * 1000;
    this.minContractPrice = (config.MIN_CONTRACT_PRICE || 48) / 100;
    this.maxContractPrice = (config.MAX_CONTRACT_PRICE || 88) / 100;

    // TradeCafe discipline: capital reserve, fixed sizing, calibration, macro gate
    this.useTradeCafe = config.USE_TRADECAFE !== false;
    this.tcParams = tc.resolveParams(config);
  }

  async handleTask(task) {
    const state = this.context.registry.get('state-manager').botState;

    switch (task.action) {
      case 'generate-signals': {
        const markets = task.params?.markets || state.activeMarkets;
        const signals = this._generateSignals(markets, state);
        return { signals };
      }

      case 'generate-take-profit-signals': {
        const markets = task.params?.markets || state.activeMarkets;
        const takeProfitSignals = this._generateTakeProfitSignals(state.openPositions, markets);
        return { takeProfitSignals };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  _generateSignals(kalshiMarkets, state) {
    const signals = [];
    const now = Date.now();
    const btcPrice = state.btcPrice.binance;
    if (!btcPrice) return signals;

    const probModel = this.context.registry.get('probability-model');
    const trendSkill = this.context.registry.get('trend-analysis');
    const polySkill = this.context.registry.get('polymarket-price-feed');
    const binanceFeed = this.context.registry.get('binance-price-feed').getFeed();

    for (const market of kalshiMarkets) {
      const timeRemaining = market.closeTime - now;
      const totalDuration = market.closeTime - market.openTime;
      const timeSinceOpen = now - market.openTime;

      if (timeSinceOpen > this.tradingWindow || timeRemaining < 30000) continue;

      const openPrice = state.marketOpenPrices[market.ticker];
      if (!openPrice) continue;
      if (!market.yesAsk || !market.noAsk) continue;

      const yesInRange = market.yesAsk >= this.minContractPrice && market.yesAsk <= this.maxContractPrice;
      const noInRange = market.noAsk >= this.minContractPrice && market.noAsk <= this.maxContractPrice;

      // Get Polymarket cross-reference
      const poly = polySkill.getCachedPrice(market.closeTime);

      // Calculate model probability
      const prob = probModel.calculateImpliedProbability(btcPrice, openPrice, timeRemaining, totalDuration, binanceFeed);

      // TradeCafe: correct the model's documented ~6% overconfidence by
      // shrinking the probability toward 0.5 before we measure any edge.
      if (this.useTradeCafe) {
        prob.probUp = tc.calibrate(prob.probUp, this.tcParams.CALIBRATION_SHRINK);
        prob.probDown = 1 - prob.probUp;
      }

      // Get trend data
      const trendData = trendSkill.getIndicator() ? trendSkill.getIndicator().getTrend() : {};

      // Update state model for UI
      state.updateModel({
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

      // ===== STRATEGY 1: DIRECTIONAL =====
      const kalshiYesImplied = market.yesAsk;
      const modelEdgeYes = (prob.probUp - kalshiYesImplied) * 100;
      const modelEdgeNo = (prob.probDown - market.noAsk) * 100;

      const trendMultYes = trendSkill.getTrendMultiplier('yes');
      const trendMultNo = trendSkill.getTrendMultiplier('no');
      const adjustedEdgeYes = modelEdgeYes * trendMultYes;
      const adjustedEdgeNo = modelEdgeNo * trendMultNo;
      const currentTrend = trendData.trend || 'NEUTRAL';

      // TradeCafe macro gate: don't fight a strong 1H trend.
      const yesAllowed = !this.useTradeCafe ||
        tc.macroGate('yes', currentTrend, trendData.strength, this.tcParams);
      const noAllowed = !this.useTradeCafe ||
        tc.macroGate('no', currentTrend, trendData.strength, this.tcParams);

      if (adjustedEdgeYes > this.minDivergence && yesInRange && yesAllowed) {
        const contracts = this._sizeEntry(state, market.ticker, 'yes', market.yesAsk, adjustedEdgeYes, prob.probUp, probModel);
        if (contracts >= 1) {
        signals.push({
          type: 'DIRECTIONAL_YES', ticker: market.ticker, side: 'yes',
          priceCents: market.yesAskCents || Math.round(market.yesAsk * 100),
          priceDecimal: market.yesAsk, edge: adjustedEdgeYes, contracts,
          modelProb: prob.probUp,
          reason: `Spot +${(prob.movePct || 0).toFixed(3)}% | Model ${(prob.probUp * 100).toFixed(0)}% vs Kalshi ${(kalshiYesImplied * 100).toFixed(0)}% | 1H: ${currentTrend}${trendMultYes !== 1.0 ? ' (' + trendMultYes.toFixed(2) + 'x)' : ''}`,
          closeTime: market.closeTime, executionMode: 'taker',
        });
        }
      }

      if (adjustedEdgeNo > this.minDivergence && noInRange && noAllowed) {
        const contracts = this._sizeEntry(state, market.ticker, 'no', market.noAsk, adjustedEdgeNo, prob.probDown, probModel);
        if (contracts >= 1) {
        signals.push({
          type: 'DIRECTIONAL_NO', ticker: market.ticker, side: 'no',
          priceCents: market.noAskCents || Math.round(market.noAsk * 100),
          priceDecimal: market.noAsk, edge: adjustedEdgeNo, contracts,
          modelProb: prob.probDown,
          reason: `Spot ${(prob.movePct || 0).toFixed(3)}% | Model ${(prob.probDown * 100).toFixed(0)}% vs Kalshi ${(market.noAsk * 100).toFixed(0)}% | 1H: ${currentTrend}${trendMultNo !== 1.0 ? ' (' + trendMultNo.toFixed(2) + 'x)' : ''}`,
          closeTime: market.closeTime, executionMode: 'taker',
        });
        }
      }

      // ===== STRATEGY 2: POLYMARKET ARBITRAGE =====
      if (poly) {
        const polyEdgeYes = (poly.upMid - market.yesAsk) * 100;
        if (polyEdgeYes > this.minEdge * 1.5 && yesInRange) {
          const size = this.useKelly ? probModel.kellySize(polyEdgeYes / 100, poly.upMid, this.kellyFraction) : 1;
          const positionDollars = Math.min(size * state.balance.available, this.maxPositionSize);
          const contracts = Math.max(1, Math.floor(positionDollars / market.yesAsk));

          signals.push({
            type: 'POLY_ARB_YES', ticker: market.ticker, side: 'yes',
            priceCents: market.yesAskCents || Math.round(market.yesAsk * 100),
            priceDecimal: market.yesAsk, edge: polyEdgeYes, contracts,
            modelProb: poly.upMid,
            reason: `Poly UP mid=${(poly.upMid * 100).toFixed(1)}% vs Kalshi ask=${(market.yesAsk * 100).toFixed(1)}%`,
            closeTime: market.closeTime, executionMode: 'taker',
          });
        }
      }

      // ===== STRATEGY 3: DUAL-SIDE ARBITRAGE =====
      const combinedCost = market.yesAsk + market.noAsk;
      if (combinedCost < 0.98) {
        const guaranteedProfit = (1 - combinedCost) * 100;
        const positionDollars = Math.min(this.maxPositionSize / 2, state.balance.available / 2);
        const contracts = Math.max(1, Math.floor(positionDollars / Math.max(market.yesAsk, market.noAsk)));

        signals.push({
          type: 'DUAL_SIDE_YES', ticker: market.ticker, side: 'yes',
          priceCents: Math.round(market.yesAsk * 100), priceDecimal: market.yesAsk,
          edge: guaranteedProfit, contracts, modelProb: prob.probUp,
          reason: `Dual-side: YES@${(market.yesAsk * 100).toFixed(0)} + NO@${(market.noAsk * 100).toFixed(0)} = ${(combinedCost * 100).toFixed(0)}c < $1`,
          closeTime: market.closeTime, isDualSide: true, executionMode: 'taker',
        });

        signals.push({
          type: 'DUAL_SIDE_NO', ticker: market.ticker, side: 'no',
          priceCents: Math.round(market.noAsk * 100), priceDecimal: market.noAsk,
          edge: guaranteedProfit, contracts, modelProb: prob.probDown,
          reason: `Dual-side: YES@${(market.yesAsk * 100).toFixed(0)} + NO@${(market.noAsk * 100).toFixed(0)} = ${(combinedCost * 100).toFixed(0)}c < $1`,
          closeTime: market.closeTime, isDualSide: true, executionMode: 'taker',
        });
      }
    }

    signals.sort((a, b) => b.edge - a.edge);
    return signals;
  }

  /**
   * Fixed-fractional entry sizing off WORKING capital (TradeCafe reserve model).
   * Falls back to legacy Kelly/flat sizing when TradeCafe is disabled.
   */
  _sizeEntry(state, ticker, side, price, edge, prob, probModel) {
    if (this.useTradeCafe) {
      // Dollars already deployed on this ticker/side (caps post-averaging size).
      const existingCost = [...state.openPositions, ...state.pendingOrders]
        .filter(p => p.ticker === ticker && p.side === side)
        .reduce((s, p) => s + (p.totalCost || p.reservedCost || 0), 0);
      const total = state.balance.total || state.balance.available || 0;
      return tc.entryContracts(total, price, this.tcParams, existingCost);
    }
    const size = this.useKelly ? probModel.kellySize(edge / 100, prob, this.kellyFraction) : 1;
    const positionDollars = Math.min(size * state.balance.available, this.maxPositionSize, state.balance.available);
    return Math.max(1, Math.floor(positionDollars / price));
  }

  _generateTakeProfitSignals(openPositions, kalshiMarkets) {
    const signals = [];

    for (const pos of openPositions) {
      const market = kalshiMarkets.find(m => m.ticker === pos.ticker);
      if (!market) continue;

      const now = Date.now();
      const timeRemaining = pos.closeTime - now;
      const currentValue = pos.side === 'yes' ? market.yesBid : market.noBid;
      const entryPrice = pos.priceDecimal;
      if (!currentValue || currentValue <= 0) continue;

      let fire = false;
      let reason = '';

      if (this.useTradeCafe) {
        // TradeCafe trailing profit-lock: arm a stop once enough of the move is
        // banked, ride it up under the peak bid, and hard-take near certainty.
        const ev = tc.evaluateExit(pos, currentValue, timeRemaining, this.tcParams);
        fire = ev.exit;
        reason = ev.exit
          ? `${ev.reason}: bought@${(entryPrice * 100).toFixed(0)}c sell@${(currentValue * 100).toFixed(0)}c (locked ${(ev.gainFraction * 100).toFixed(0)}% of max gain)`
          : '';
      } else {
        if (timeRemaining < 30000) continue;
        const profitPct = ((currentValue - entryPrice) / entryPrice) * 100;
        const gainFraction = (currentValue - entryPrice) / (1 - entryPrice);
        fire = profitPct > 15 || gainFraction > 0.5;
        reason = `Take profit: bought@${(entryPrice * 100).toFixed(0)}c sell@${(currentValue * 100).toFixed(0)}c (+${profitPct.toFixed(1)}%)`;
      }

      if (fire) {
        const profitPct = ((currentValue - entryPrice) / entryPrice) * 100;
        signals.push({
          type: 'TAKE_PROFIT', orderId: pos.orderId, ticker: pos.ticker,
          side: pos.side, sellPriceCents: Math.round(currentValue * 100),
          sellPriceDecimal: currentValue,
          contracts: pos.filledContracts || pos.contracts,
          profitPct, reason,
        });
      }
    }

    return signals;
  }
}

module.exports = SignalGenerator;

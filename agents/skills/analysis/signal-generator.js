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
const { estimateTakerFeeDollars, expectedValuePerContract, sizeContracts } = require('../../../lib/kalshi-economics');

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
    this.kellyFraction = config.KELLY_FRACTION ?? 0.08;
    this.useKelly = config.USE_KELLY_SIZING !== false;
    this.maxPositionSize = config.MAX_POSITION_SIZE || 25;
    this.tradingWindow = (config.TRADING_WINDOW || 4) * 60 * 1000;
    this.minContractPrice = (config.MIN_CONTRACT_PRICE ?? 35) / 100;
    this.maxContractPrice = (config.MAX_CONTRACT_PRICE ?? 65) / 100;
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
      const referenceMeta = state.marketOpenPriceMeta?.[market.ticker];
      if (!openPrice || !referenceMeta || referenceMeta.source !== 'binance_at_market_open' || Math.abs(referenceMeta.timestamp - market.openTime) > 2500) continue;
      if (!market.yesAsk || !market.noAsk) continue;

      const yesInRange = market.yesAsk >= this.minContractPrice && market.yesAsk <= this.maxContractPrice;
      const noInRange = market.noAsk >= this.minContractPrice && market.noAsk <= this.maxContractPrice;

      // Get Polymarket cross-reference
      const poly = polySkill.getCachedPrice(market.closeTime);

      // Calculate model probability
      const prob = probModel.calculateImpliedProbability(btcPrice, openPrice, timeRemaining, totalDuration, binanceFeed);

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

      // All entry economics use Kalshi's executable ask and a fee estimate.
      const feeRate = this.context.config.KALSHI_TAKER_FEE_RATE ?? 0.07;
      const feeMultiplier = market.feeMultiplier ?? 1;
      const emitDirectional = (side, probability, ask, askCents, _trendMultiplier, trendLabel) => {
        if (!Number.isFinite(ask) || ask <= 0 || ask >= 1) return;
        const fee = estimateTakerFeeDollars(ask, 1, feeRate, feeMultiplier);
        const netEv = expectedValuePerContract(probability, ask, fee);
        const adjustedEdge = netEv * 100;
        const inRange = ask >= this.minContractPrice && ask <= this.maxContractPrice;
        if (adjustedEdge < this.minDivergence || !inRange) return;
        const contracts = this.useKelly
          ? sizeContracts(probability, ask, state.balance.available, this.maxPositionSize, feeRate, feeMultiplier, this.kellyFraction)
          : Math.floor(Math.min(state.balance.available, this.maxPositionSize) / (ask + fee));
        if (contracts < 1) return;
        signals.push({
          type: side === 'yes' ? 'DIRECTIONAL_YES' : 'DIRECTIONAL_NO', ticker: market.ticker, side,
          priceCents: askCents || Math.round(ask * 100), priceDecimal: ask,
          edge: adjustedEdge, expectedValue: netEv, estimatedEntryFee: estimateTakerFeeDollars(ask, contracts, feeRate, feeMultiplier),
          contracts, modelProb: probability,
          reason: `Net EV ${(netEv * 100).toFixed(2)}¢/contract | model ${(probability * 100).toFixed(1)}% vs executable ask ${(ask * 100).toFixed(1)}% | 1H: ${trendLabel}`,
          closeTime: market.closeTime, executionMode: 'taker',
        });
      };
      const trendMultYes = trendSkill.getTrendMultiplier('yes');
      const trendMultNo = trendSkill.getTrendMultiplier('no');
      const currentTrend = trendData.trend || 'NEUTRAL';
      emitDirectional('yes', prob.probUp, market.yesAsk, market.yesAskCents, trendMultYes, currentTrend);
      emitDirectional('no', prob.probDown, market.noAsk, market.noAskCents, trendMultNo, currentTrend);

      // Cross-venue signal uses Polymarket's executable sell quote (bid), not midpoint.
      // It remains a probability proxy and is only eligible when both feeds are fresh.
      if (poly && Number.isFinite(poly.upSell) && Date.now() - poly.fetchedAt <= 5000) {
        const ask = market.yesAsk;
        const fee = estimateTakerFeeDollars(ask, 1, feeRate, feeMultiplier);
        const netEv = expectedValuePerContract(poly.upSell, ask, fee);
        if (netEv * 100 >= this.minEdge * 1.5 && ask >= this.minContractPrice && ask <= this.maxContractPrice) {
          const contracts = this.useKelly
            ? sizeContracts(poly.upSell, ask, state.balance.available, this.maxPositionSize, feeRate, feeMultiplier, this.kellyFraction)
            : Math.floor(Math.min(state.balance.available, this.maxPositionSize) / (ask + fee));
          if (contracts > 0) signals.push({
            type: 'POLY_ARB_YES', ticker: market.ticker, side: 'yes',
            priceCents: market.yesAskCents || Math.round(ask * 100), priceDecimal: ask,
            edge: netEv * 100, expectedValue: netEv,
            estimatedEntryFee: estimateTakerFeeDollars(ask, contracts, feeRate, feeMultiplier),
            contracts, modelProb: poly.upSell,
            reason: `Poly executable bid ${(poly.upSell * 100).toFixed(1)}% vs Kalshi ask ${(ask * 100).toFixed(1)}%; fee-adjusted EV ${(netEv * 100).toFixed(2)}¢/contract`,
            closeTime: market.closeTime, executionMode: 'taker',
          });
        }
      }

      // Dual-side entry is disabled until the venue supports paired atomic execution.

    }

    signals.sort((a, b) => b.edge - a.edge);
    return signals;
  }

  _generateTakeProfitSignals(openPositions, kalshiMarkets) {
    const signals = [];

    for (const pos of openPositions) {
      const market = kalshiMarkets.find(m => m.ticker === pos.ticker);
      if (!market) continue;

      const now = Date.now();
      const timeRemaining = pos.closeTime - now;
      if (timeRemaining < 30000) continue;

      const currentValue = pos.side === 'yes' ? market.yesBid : market.noBid;
      const entryPrice = pos.priceDecimal;

      if (!currentValue || currentValue <= 0) continue;

      const profitPct = ((currentValue - entryPrice) / entryPrice) * 100;
      const maxGain = 1 - entryPrice;
      const gainFraction = (currentValue - entryPrice) / maxGain;

      if (profitPct > 15 || gainFraction > 0.5) {
        signals.push({
          type: 'TAKE_PROFIT', orderId: pos.orderId, ticker: pos.ticker,
          side: pos.side, sellPriceCents: Math.round(currentValue * 100),
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

module.exports = SignalGenerator;

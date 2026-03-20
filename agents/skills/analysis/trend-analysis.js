/**
 * TrendAnalysis Skill
 *
 * Wraps the TrendIndicator as an agent skill.
 * Dual EMA crossover (12min/45min) confirmed by 30-min ROC.
 *
 * Capabilities: get-trend, get-trend-multiplier
 */

const BaseSkill = require('../../core/base-skill');
const TrendIndicator = require('../../../bot/trend');

class TrendAnalysis extends BaseSkill {
  constructor() {
    super({
      name: 'trend-analysis',
      description: '1-hour BTC trend indicator using dual EMA crossover with ROC confirmation',
      domain: 'analysis',
      capabilities: ['get-trend', 'get-trend-multiplier'],
      dependencies: ['binance-price-feed'],
    });

    this.indicator = null;
    this.trendBoost = 0.25;
    this.trendPenalty = 0.40;
    this.trendEnabled = true;
  }

  async initialize(context) {
    await super.initialize(context);
    const binanceFeed = context.registry.get('binance-price-feed').getFeed();
    this.indicator = new TrendIndicator(binanceFeed, context.config);

    // Wire the trend indicator into the Binance feed
    binanceFeed.setTrendIndicator(this.indicator);

    this.trendEnabled = context.config.TREND_ENABLED !== false;
    this.trendBoost = context.config.TREND_BOOST || 0.25;
    this.trendPenalty = context.config.TREND_PENALTY || 0.40;
  }

  async handleTask(task) {
    switch (task.action) {
      case 'get-trend': {
        return this.indicator.getTrend();
      }

      case 'get-trend-multiplier': {
        const side = task.params?.side;
        if (!side) throw new Error('side required (yes/no)');
        return { multiplier: this.getTrendMultiplier(side) };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  getTrendMultiplier(side) {
    if (!this.trendEnabled || !this.indicator) return 1.0;

    const { trend, warmup } = this.indicator.getTrend();
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

  /**
   * Direct access to the underlying indicator.
   */
  getIndicator() {
    return this.indicator;
  }

  async stop() {
    await super.stop();
  }
}

module.exports = TrendAnalysis;

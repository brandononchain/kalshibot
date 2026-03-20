/**
 * ProbabilityModel Skill
 *
 * Calculates implied probability of BTC UP/DOWN using a normal distribution
 * model calibrated to realized volatility from the Binance feed.
 *
 * Capabilities: calculate-probability, kelly-size
 */

const BaseSkill = require('../../core/base-skill');

class ProbabilityModel extends BaseSkill {
  constructor() {
    super({
      name: 'probability-model',
      description: 'Normal distribution CDF model for BTC UP/DOWN probability estimation',
      domain: 'analysis',
      capabilities: ['calculate-probability', 'kelly-size'],
      dependencies: ['binance-price-feed', 'state-manager'],
    });
  }

  async initialize(context) {
    await super.initialize(context);
  }

  async handleTask(task) {
    switch (task.action) {
      case 'calculate-probability': {
        const { currentPrice, openPrice, timeRemainingMs, totalDurationMs } = task.params || {};
        const binanceFeed = this.context.registry.get('binance-price-feed').getFeed();
        return this.calculateImpliedProbability(currentPrice, openPrice, timeRemainingMs, totalDurationMs, binanceFeed);
      }

      case 'kelly-size': {
        const { edge, probability } = task.params || {};
        const config = this.context.config;
        const kellyFraction = config.KELLY_FRACTION || 0.25;
        return { size: this.kellySize(edge, probability, kellyFraction) };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  // Normal CDF approximation (Abramowitz & Stegun)
  normalCDF(x) {
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

  calculateImpliedProbability(currentPrice, openPrice, timeRemainingMs, totalDurationMs, binanceFeed) {
    if (!currentPrice || !openPrice || openPrice === 0) {
      return { probUp: 0.5, probDown: 0.5 };
    }

    const move = (currentPrice - openPrice) / openPrice;
    const timeRemaining = Math.max(0.001, timeRemainingMs / totalDurationMs);
    const totalDurationSec = totalDurationMs / 1000;
    const sigma = binanceFeed.getRecentVolatility(totalDurationSec);
    const remainingSigma = sigma * Math.sqrt(timeRemaining);

    if (remainingSigma < 0.00001) {
      return { probUp: move > 0 ? 0.99 : 0.01, probDown: move > 0 ? 0.01 : 0.99 };
    }

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

  kellySize(edge, probability, kellyFraction = 0.25) {
    if (probability <= 0.01 || probability >= 0.99) return 0;
    const b = (1 / (1 - probability)) - 1;
    const q = 1 - probability;
    const kelly = (b * probability - q) / b;
    return Math.max(0, Math.min(kelly * kellyFraction, 0.25));
  }
}

module.exports = ProbabilityModel;

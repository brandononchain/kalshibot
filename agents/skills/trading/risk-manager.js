/**
 * RiskManager Skill
 *
 * Evaluates signals against risk constraints before execution.
 * Enforces position limits, balance checks, exposure caps, and
 * session drawdown rules.
 *
 * Capabilities: check-risk, evaluate-signals, check-position-limits, check-balance
 */

const BaseSkill = require('../../core/base-skill');

class RiskManager extends BaseSkill {
  constructor() {
    super({
      name: 'risk-manager',
      description: 'Evaluates trading signals against risk constraints and position limits',
      domain: 'trading',
      capabilities: ['check-risk', 'evaluate-signals', 'check-position-limits', 'check-balance'],
      dependencies: ['state-manager', 'analytics-recorder'],
    });

    this.maxOpenPositions = 10;
    this.maxPerContract = 1;
    this.maxPositionSize = 25;
  }

  async initialize(context) {
    await super.initialize(context);
    this.maxOpenPositions = context.config.MAX_TOTAL_OPEN_POSITIONS || 10;
    this.maxPerContract = context.config.MAX_POSITIONS_PER_CONTRACT || 1;
    this.maxPositionSize = context.config.MAX_POSITION_SIZE || 25;
  }

  async handleTask(task) {
    const state = this.context.registry.get('state-manager').botState;

    switch (task.action) {
      case 'evaluate-signals': {
        const signals = task.params?.signals || [];
        const approved = [];

        for (const signal of signals) {
          const check = this._checkSignal(signal, state);
          if (check.approved) {
            approved.push(signal);
          } else {
            // Log blocked signal
            const db = this.context.registry.get('analytics-recorder');
            if (db) db.logBlockedSignal(signal, check.reason);
          }
        }

        return { approvedSignals: approved, rejected: signals.length - approved.length };
      }

      case 'check-risk': {
        const signal = task.params?.signal;
        if (!signal) throw new Error('signal required');
        return this._checkSignal(signal, state);
      }

      case 'check-position-limits': {
        return this._getPositionLimits(state);
      }

      case 'check-balance': {
        return {
          available: state.balance.available,
          total: state.balance.total,
          reserved: state.balance.reserved,
        };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  _checkSignal(signal, state) {
    // Check total position limits (pending + open)
    const totalExposure = state.openPositions.length + state.pendingOrders.length;
    if (totalExposure >= this.maxOpenPositions) {
      return { approved: false, reason: 'max_positions' };
    }

    // Check per-contract limits
    const existingOnTicker = [
      ...state.openPositions.filter(p => p.ticker === signal.ticker),
      ...state.pendingOrders.filter(p => p.ticker === signal.ticker),
    ];
    if (existingOnTicker.length >= this.maxPerContract) {
      return { approved: false, reason: 'per_contract_cap' };
    }

    // Check balance
    const cost = signal.priceDecimal * signal.contracts;
    if (cost > state.balance.available) {
      return { approved: false, reason: 'insufficient_balance' };
    }

    // Check cumulative ticker exposure
    const existingCost = existingOnTicker.reduce((sum, p) => sum + (p.totalCost || p.reservedCost || 0), 0);
    if (existingCost + cost > this.maxPositionSize * 1.5) {
      return { approved: false, reason: 'ticker_exposure_cap' };
    }

    return { approved: true, cost, existingExposure: existingCost };
  }

  _getPositionLimits(state) {
    const totalExposure = state.openPositions.length + state.pendingOrders.length;
    return {
      currentOpen: state.openPositions.length,
      currentPending: state.pendingOrders.length,
      totalExposure,
      maxOpenPositions: this.maxOpenPositions,
      maxPerContract: this.maxPerContract,
      slotsAvailable: Math.max(0, this.maxOpenPositions - totalExposure),
    };
  }
}

module.exports = RiskManager;

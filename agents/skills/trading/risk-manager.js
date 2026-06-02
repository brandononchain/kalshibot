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
const tc = require('../../../bot/tradecafe');

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

    // TradeCafe discipline: capital reserve + smart concurrency + drawdown kill
    this.useTradeCafe = context.config.USE_TRADECAFE !== false;
    this.tcParams = tc.resolveParams(context.config);
  }

  async handleTask(task) {
    const state = this.context.registry.get('state-manager').botState;

    switch (task.action) {
      case 'evaluate-signals': {
        // Accept ML-scored signals (preferred) or raw signals
        const signals = task.params?.scoredSignals || task.params?.signals || [];
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
    const cost = signal.priceDecimal * signal.contracts;

    // TradeCafe: portfolio drawdown kill-switch. While tripped, no new entries.
    if (this.useTradeCafe && state.tradeCafe && state.tradeCafe.halted) {
      return { approved: false, reason: 'drawdown_halt' };
    }

    // Concurrency cap. With TradeCafe, profit-locked positions free their slot
    // (smart slot return) and the cap is MAX_CONCURRENT; otherwise legacy count.
    if (this.useTradeCafe) {
      const all = [...state.openPositions, ...state.pendingOrders];
      if (!tc.hasOpenSlot(all, this.tcParams) && !signal.isDualSide) {
        return { approved: false, reason: 'max_positions' };
      }
    } else {
      const totalExposure = state.openPositions.length + state.pendingOrders.length;
      if (totalExposure >= this.maxOpenPositions) {
        return { approved: false, reason: 'max_positions' };
      }
    }

    // Per-contract / averaging limit
    const existingOnTicker = [
      ...state.openPositions.filter(p => p.ticker === signal.ticker),
      ...state.pendingOrders.filter(p => p.ticker === signal.ticker),
    ];
    const perContractCap = this.useTradeCafe
      ? this.tcParams.AVERAGE_MAX_ADDS + 1
      : this.maxPerContract;
    if (existingOnTicker.length >= perContractCap) {
      return { approved: false, reason: 'per_contract_cap' };
    }

    // TradeCafe: never spend into the reserve — keep (1 - working) of total free.
    if (this.useTradeCafe) {
      const total = state.balance.total || state.balance.available || 0;
      const reserve = total * (1 - this.tcParams.WORKING_CAPITAL_FRACTION);
      if (state.balance.available - cost < reserve) {
        return { approved: false, reason: 'reserve_protected' };
      }
    }

    // Check balance
    if (cost > state.balance.available) {
      return { approved: false, reason: 'insufficient_balance' };
    }

    // Check cumulative ticker exposure
    const existingCost = existingOnTicker.reduce((sum, p) => sum + (p.totalCost || p.reservedCost || 0), 0);
    // TradeCafe caps a single ticker/side at MAX_POSITION_FRACTION of working capital.
    const tickerCap = this.useTradeCafe
      ? tc.workingCapital(state.balance.total || state.balance.available || 0, this.tcParams) * this.tcParams.MAX_POSITION_FRACTION
      : this.maxPositionSize * 1.5;
    if (existingCost + cost > tickerCap + 1e-9) {
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

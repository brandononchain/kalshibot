/**
 * PositionManager Skill
 *
 * Manages open positions: take-profit execution, settlement resolution,
 * and position lifecycle tracking.
 *
 * Capabilities: take-profit, execute-take-profit, settle-position
 */

const BaseSkill = require('../../core/base-skill');

class PositionManager extends BaseSkill {
  constructor() {
    super({
      name: 'position-manager',
      description: 'Manages position lifecycle: take-profit execution and settlement resolution',
      domain: 'trading',
      capabilities: ['take-profit', 'execute-take-profit', 'settle-position'],
      dependencies: ['state-manager', 'kalshi-market-data', 'analytics-recorder'],
    });
  }

  async initialize(context) {
    await super.initialize(context);
  }

  async handleTask(task) {
    switch (task.action) {
      case 'execute-take-profit': {
        const signals = task.params?.takeProfitSignals || [];
        const results = [];
        for (const tp of signals) {
          const result = await this._executeTakeProfit(tp);
          results.push(result);
        }
        return { results };
      }

      case 'settle-position': {
        const orderId = task.params?.orderId;
        if (!orderId) throw new Error('orderId required');
        return await this._settlePosition(orderId);
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  /**
   * Public method for scheduled settlement callbacks.
   */
  async settlePositionById(orderId) {
    try {
      await this._settlePosition(orderId);
    } catch (err) {
      console.error(`[PositionManager] Settlement error for ${orderId}: ${err.message}`);
      setTimeout(() => this.settlePositionById(orderId), 30000);
    }
  }

  async _executeTakeProfit(tp) {
    const state = this.context.registry.get('state-manager').botState;
    const kalshiSkill = this.context.registry.get('kalshi-market-data');

    try {
      const sellOrder = await kalshiSkill.getClient().sellPosition(
        tp.ticker, tp.side, tp.contracts, tp.sellPriceCents
      );

      if (sellOrder.status === 'executed' || sellOrder.fill_count > 0) {
        const position = state.openPositions.find(p => p.orderId === tp.orderId);
        const pnl = ((tp.sellPriceDecimal - (position?.priceDecimal || 0)) || 0) *
          (sellOrder.fill_count || tp.contracts);

        state.closePosition(tp.orderId, {
          won: pnl > 0, pnl,
          payout: tp.sellPriceDecimal * (sellOrder.fill_count || tp.contracts),
          cost: position?.totalCost || 0,
          exitType: 'TAKE_PROFIT',
        });

        state.logTrade({
          type: 'TRADE', action: 'SELL', side: tp.side,
          ticker: tp.ticker, contracts: tp.contracts,
          price: tp.sellPriceCents, pnl, reason: tp.reason,
        });

        return { ticker: tp.ticker, status: 'sold', pnl };
      }

      return { ticker: tp.ticker, status: 'pending' };
    } catch (err) {
      return { ticker: tp.ticker, status: 'error', error: err.message };
    }
  }

  async _settlePosition(orderId) {
    const state = this.context.registry.get('state-manager').botState;
    const kalshiSkill = this.context.registry.get('kalshi-market-data');
    const analyticsSkill = this.context.registry.get('analytics-recorder');

    const position = state.openPositions.find(p => p.orderId === orderId);
    if (!position) {
      // Check if still pending
      const pending = state.pendingOrders.find(p => p.orderId === orderId);
      if (pending) {
        state.removePendingOrder(orderId);
      }
      return { settled: false, reason: 'position_not_found' };
    }

    const order = await kalshiSkill.getClient().getOrder(orderId);
    const filled = order.fill_count || 0;

    if (filled === 0) {
      state.openPositions = state.openPositions.filter(p => p.orderId !== orderId);
      state.emit('position:removed', position);
      return { settled: false, reason: 'never_filled' };
    }

    const market = await kalshiSkill.getClient().fetchMarket(position.ticker);

    if (!market || (market.result !== 'yes' && market.result !== 'no')) {
      // Not settled yet, retry
      setTimeout(() => this.settlePositionById(orderId), 30000);
      return { settled: false, reason: 'not_settled_yet' };
    }

    const won = position.side === market.result;
    const costCents = (order.taker_fill_cost || 0) + (order.taker_fees || 0);
    const costDollars = costCents / 100;
    const payout = won ? filled * 1.00 : 0;
    const pnl = payout - costDollars;

    // Update DB
    analyticsSkill.updateOrderDirect(orderId, 'settled', filled, order.taker_fill_cost || 0, order.taker_fees || 0);
    analyticsSkill.logMarketSnapshotDirect(market, state.btcPrice.binance, 'settlement');

    state.closePosition(orderId, {
      won, pnl, payout, cost: costDollars,
      filledContracts: filled, exitType: 'SETTLEMENT', result: market.result,
    });

    state.logTrade({
      type: 'SETTLEMENT', action: won ? 'WIN' : 'LOSS',
      side: position.side, ticker: position.ticker,
      contracts: filled, pnl, cost: costDollars, payout, result: market.result,
    });

    console.log(
      `[PositionManager] ${won ? 'WON' : 'LOST'}: ${position.ticker} ${position.side} x${filled} | Cost: $${costDollars.toFixed(2)} | Payout: $${payout.toFixed(2)} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`
    );

    await kalshiSkill.getClient().fetchBalance();

    return { settled: true, won, pnl, payout };
  }
}

module.exports = PositionManager;

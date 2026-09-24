'use strict';
function estimateTakerFeeDollars(price, contracts, rate = 0.07, multiplier = 1) {
  if (!Number.isFinite(price) || price < 0 || price > 1 || !Number.isFinite(contracts) || contracts <= 0) return Infinity;
  return Math.ceil(rate * multiplier * contracts * price * (1 - price) * 100 - 1e-10) / 100;
}
function expectedValuePerContract(probability, price, feePerContract = 0) {
  if (![probability, price, feePerContract].every(Number.isFinite) || probability < 0 || probability > 1 || price < 0 || price > 1) return -Infinity;
  return probability - price - feePerContract;
}
function kellyBankrollFraction(probability, price, feePerContract = 0, fraction = 0.08) {
  if (![probability, price, feePerContract, fraction].every(Number.isFinite) ||
      probability <= 0 || probability >= 1 || price <= 0 || price >= 1 || feePerContract < 0 || fraction <= 0) return 0;
  const risk = price + feePerContract;
  const winProfit = 1 - price - feePerContract;
  if (risk <= 0 || winProfit <= 0) return 0;
  const fullKelly = probability - (1 - probability) * risk / winProfit;
  return Math.max(0, Math.min(0.25, fullKelly * fraction));
}
function sizeContracts(probability, price, bankroll, maxPositionDollars, feeRate = 0.07, feeMultiplier = 1, kellyFraction = 0.08) {
  if (![probability, price, bankroll, maxPositionDollars].every(Number.isFinite) || price <= 0 || price >= 1 || bankroll <= 0 || maxPositionDollars <= 0) return 0;
  const oneFee = estimateTakerFeeDollars(price, 1, feeRate, feeMultiplier);
  const fraction = kellyBankrollFraction(probability, price, oneFee, kellyFraction);
  const budget = Math.min(bankroll * fraction, maxPositionDollars, bankroll);
  let count = Math.floor(budget / (price + oneFee));
  while (count > 0 && count * price + estimateTakerFeeDollars(price, count, feeRate, feeMultiplier) > budget) count--;
  return count;
}
module.exports = { estimateTakerFeeDollars, expectedValuePerContract, kellyBankrollFraction, sizeContracts };

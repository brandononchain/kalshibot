'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  estimateTakerFeeDollars,
  expectedValuePerContract,
  kellyBankrollFraction,
  sizeContracts,
} = require('../lib/kalshi-economics');

test('standard taker fee is rounded up to cents', () => {
  assert.equal(estimateTakerFeeDollars(0.5, 100), 1.75);
  assert.equal(estimateTakerFeeDollars(0.5, 1), 0.02);
});

test('expected value subtracts executable ask and fee', () => {
  assert.ok(Math.abs(expectedValuePerContract(0.6, 0.5, 0.02) - 0.08) < 1e-12);
  assert.ok(Math.abs(expectedValuePerContract(0.52, 0.5, 0.02)) < 1e-12);
});

test('fractional Kelly uses contract price and fee, not probability-implied odds', () => {
  const halfKelly = kellyBankrollFraction(0.75, 0.65, 0, 0.5);
  assert.ok(Math.abs(halfKelly - 0.5 * (0.75 - 0.25 * 0.65 / 0.35)) < 1e-12);
  const feeAdjusted = kellyBankrollFraction(0.75, 0.65, 0.02, 0.08);
  assert.ok(feeAdjusted > 0 && feeAdjusted < 0.03);
});

test('sizing cannot exceed budget after order-level fee rounding', () => {
  const count = sizeContracts(0.75, 0.5, 100, 5, 0.07, 1, 0.08);
  assert.ok(count > 0);
  assert.ok(count * 0.5 + estimateTakerFeeDollars(0.5, count) <= 5);
});

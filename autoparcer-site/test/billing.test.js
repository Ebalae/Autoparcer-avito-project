'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateAnnualPriceRub,
  calculateSubscriptionExpiry
} = require('../billing');

test('annual price is discounted by 30 percent from twelve monthly payments', () => {
  assert.equal(calculateAnnualPriceRub(990), 8316);
  assert.equal(calculateAnnualPriceRub(1000), 8400);
});

test('monthly renewal starts after the later of now and the current expiry', () => {
  const now = Date.UTC(2026, 0, 1);
  const currentExpiry = Date.UTC(2026, 1, 1);
  assert.equal(
    calculateSubscriptionExpiry(currentExpiry, now, 'monthly'),
    currentExpiry + 30 * 24 * 60 * 60 * 1000
  );
});

test('annual subscription adds twelve calendar months and clamps month-end dates', () => {
  const januaryEnd = Date.UTC(2026, 0, 31, 12);
  const leapDay = Date.UTC(2024, 1, 29, 12);
  assert.equal(
    calculateSubscriptionExpiry(0, januaryEnd, 'annual'),
    Date.UTC(2027, 0, 31, 12)
  );
  assert.equal(
    calculateSubscriptionExpiry(0, leapDay, 'annual'),
    Date.UTC(2025, 1, 28, 12)
  );
});

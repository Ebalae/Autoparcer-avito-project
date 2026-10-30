'use strict';

const SUBSCRIPTION_DAYS = 30;
const ANNUAL_SUBSCRIPTION_MONTHS = 12;
const ANNUAL_DISCOUNT_PERCENT = 30;

function calculateAnnualPriceRub(monthlyPriceRub, discountPercent = 30) {
  if (!Number.isInteger(monthlyPriceRub) || monthlyPriceRub < 1) {
    throw new RangeError('Monthly price must be a positive integer.');
  }
  if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent >= 100) {
    throw new RangeError('Discount must be an integer from 0 to 99.');
  }
  return Math.round(monthlyPriceRub * ANNUAL_SUBSCRIPTION_MONTHS * (100 - discountPercent) / 100);
}

function addCalendarMonths(timestamp, months) {
  const date = new Date(timestamp);
  const originalDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDayOfMonth = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    0
  )).getUTCDate();
  date.setUTCDate(Math.min(originalDay, lastDayOfMonth));
  return date.getTime();
}

function calculateSubscriptionExpiry(currentExpiry, now, planCode) {
  const baseTime = Math.max(now, currentExpiry || 0);
  if (planCode === 'monthly') {
    return baseTime + SUBSCRIPTION_DAYS * 24 * 60 * 60 * 1000;
  }
  if (planCode === 'annual') {
    return addCalendarMonths(baseTime, ANNUAL_SUBSCRIPTION_MONTHS);
  }
  throw new RangeError('Unknown subscription plan.');
}

module.exports = {
  ANNUAL_DISCOUNT_PERCENT,
  ANNUAL_SUBSCRIPTION_MONTHS,
  SUBSCRIPTION_DAYS,
  calculateAnnualPriceRub,
  calculateSubscriptionExpiry
};

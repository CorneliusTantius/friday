import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPercent } from '../public/dashboard-format.js';

test('dashboard CPU and RAM percentages use concise whole-number formatting', () => {
  assert.equal(formatPercent(15), '15%');
  assert.equal(formatPercent(15.2), '15%');
  assert.equal(formatPercent(15.6), '16%');
  assert.equal(formatPercent(40.4), '40%');
  assert.equal(formatPercent(null), 'Unavailable');
  assert.equal(formatPercent(undefined), 'Unavailable');
  assert.equal(formatPercent(Number.NaN), 'Unavailable');
});

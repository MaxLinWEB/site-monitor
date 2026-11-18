import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, formatUtcMinutes } from '../src/utils';

test('formatDuration reads like a sentence', () => {
  assert.equal(formatDuration(187), '187 ms');
  assert.equal(formatDuration(1_000), '1 second');
  assert.equal(formatDuration(272_000), '4 minutes 32 seconds');
  assert.equal(formatDuration(3_600_000), '1 hour');
  assert.equal(formatDuration(90_061_000), '1 day 1 hour 1 minute 1 second');
});

test('formatUtcMinutes is UTC to the minute', () => {
  assert.equal(formatUtcMinutes(new Date('2026-07-30T13:45:59.999Z')), '2026-07-30 13:45 UTC');
});

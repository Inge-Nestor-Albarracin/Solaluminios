// Tests for src/lib/numbers.ts (peso amounts typed the Colombian way).
// Run: pnpm test (Node 24 runs TypeScript directly).
import assert from 'node:assert/strict';
import { parseMoney } from '../src/lib/numbers.ts';

const cases: [string, string][] = [
  ['12.000', '12000'],
  ['$ 12.000', '12000'],
  ['$12.000', '12000'],
  ['1.250.000', '1250000'],
  ['1.500,50', '1500.50'],
  ['1500,5', '1500.5'],
  ['1500.50', '1500.50'],
  ['1500', '1500'],
  ['  9.000  ', '9000'],
  ['2.5', '2.5'],
];
for (const [typed, expected] of cases) assert.equal(parseMoney(typed), expected, typed);
// Not numbers: returned as typed so the form rejects them.
for (const bad of ['abc', '1,2,3', '12.00.0,5', '1.50,5x']) assert.ok(!/^\d+(\.\d+)?$/.test(parseMoney(bad)), bad);
console.log(`numbers: ${cases.length + 4}/${cases.length + 4} OK`);

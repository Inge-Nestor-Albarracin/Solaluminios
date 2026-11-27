// Tests for src/lib/numbers.ts (peso amounts typed the Colombian way).
// Run: pnpm test (Node 24 runs TypeScript directly).
import assert from 'node:assert/strict';
import { parseMoney, percentOfCents } from '../src/lib/numbers.ts';

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
  // While typing the decimals: the mark alone counts as the whole number.
  ['3.453,', '3453'],
  ['3453,', '3453'],
  ['3453.', '3453'],
  ['12.000.', '12000'],
  ['3.453,1', '3453.1'],
  ['3.453,11', '3453.11'],
  ['6.453,11', '6453.11'],
];
for (const [typed, expected] of cases) assert.equal(parseMoney(typed), expected, typed);
// Not numbers: returned as typed so the form rejects them.
const bads = ['abc', '1,2,3', '12.00.0,5', '1.50,5x', ',', '.', '$,'];
for (const bad of bads) assert.ok(!/^\d+(\.\d+)?$/.test(parseMoney(bad)), bad);
// Percentages of an amount in cents, rounded half up like the API (QA:
// $10.010 at 2,05 % is $205,21 on screen and on the server).
const percents: [number, string | number, number][] = [
  [1001000, '2.05', 20521],
  [1001000, 2.05, 20521],
  [100, '0.5', 1],
  [100, '0.4999', 0],
  [999999, '19', 190000],
  [1857140, '50', 928570],
  [0, '19', 0],
  [123456789012, '100', 123456789012],
  [1, '3.0001', 0],
];
for (const [cents, percent, expected] of percents) assert.equal(percentOfCents(cents, percent), expected, `${cents} × ${percent} %`);
const total = cases.length + bads.length + percents.length;
console.log(`numbers: ${total}/${total} OK`);

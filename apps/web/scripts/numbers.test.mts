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
console.log(`numbers: ${cases.length + bads.length}/${cases.length + bads.length} OK`);

// Known-vector tests for the ENS math. Runtime wire-format safety is handled
// in-code: calldata() (src/ens.ts) asserts every request payload is strictly
// 0x-prefixed hex, so the old "hex string without 0x prefix" bug throws
// loudly at the construction point instead of failing per-provider.
//
// What these tests add is the part an assert can't see: if keccak or the
// namehash algorithm regresses, calldata stays perfectly well-formed but
// wrong, and every lookup would silently return null.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('scripts/out', { recursive: true });
for (const [entry, outfile] of [
  ['src/ens.ts', 'scripts/out/ens.test-bundle.mjs'],
  ['src/keccak.ts', 'scripts/out/keccak.test-bundle.mjs'],
]) {
  buildSync({ entryPoints: [entry], bundle: true, format: 'esm', outfile });
}
const ens = await import('../scripts/out/ens.test-bundle.mjs');
const { keccak256Hex } = await import('../scripts/out/keccak.test-bundle.mjs');

test('keccak256 matches known vectors', () => {
  assert.equal(keccak256Hex(''), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256Hex('abc'), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
});

test('namehash matches ENSIP-1 reference vectors', () => {
  assert.equal(ens.testables.namehashHex(''), '0x' + '0'.repeat(64));
  assert.equal(ens.testables.namehashHex('eth'), '0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae');
});

test('eth_call selector bytes match the canonical function signatures', () => {
  // if any of these drift, every eth_call targets a nonexistent function
  // and resolution fails silently
  assert.equal(keccak256Hex('resolver(bytes32)').slice(0, 8), '0178b8bf');
  assert.equal(keccak256Hex('addr(bytes32)').slice(0, 8), '3b3b57de');
  assert.equal(keccak256Hex('name(bytes32)').slice(0, 8), '691f3431');
});

// Known-vector tests for the ENS math. Runtime wire-format safety is handled
// in-code: calldata() (src/ens.ts) asserts every request payload is strictly
// 0x-prefixed hex, so the old "hex string without 0x prefix" bug throws
// loudly at the construction point instead of failing per-provider.
//
// What these tests add is the part an assert can't see: if keccak or the
// namehash algorithm regresses, calldata stays perfectly well-formed but
// wrong, and every lookup would silently return null.

import { expect, test } from 'bun:test';
import { testables } from '../src/ens.ts';
import { keccak256Hex } from '../src/keccak.ts';

test('keccak256 matches known vectors', () => {
  expect(keccak256Hex('')).toBe('c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  expect(keccak256Hex('abc')).toBe('4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
});

test('namehash matches ENSIP-1 reference vectors', () => {
  expect(testables.namehashHex('')).toBe('0x' + '0'.repeat(64));
  expect(testables.namehashHex('eth')).toBe('0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae');
});

test('eth_call selector bytes match the canonical function signatures', () => {
  // if any of these drift, every eth_call targets a nonexistent function
  // and resolution fails silently
  expect(keccak256Hex('resolver(bytes32)').slice(0, 8)).toBe('0178b8bf');
  expect(keccak256Hex('addr(bytes32)').slice(0, 8)).toBe('3b3b57de');
  expect(keccak256Hex('name(bytes32)').slice(0, 8)).toBe('691f3431');
});

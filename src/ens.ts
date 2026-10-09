// ENS resolution via direct eth_call to the mainnet registry — no third-party API.
// Two-step: registry.resolver(node) -> resolver.addr(node). Also reverse lookup.
// Note: label normalization is plain lowercase (not full ENS UTS-46); covers
// ASCII names, which is virtually all real-world input.

import { keccak256, keccak256Hex } from './keccak';

const REGISTRY = '0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e';
const SEL_RESOLVER = keccak256Hex('resolver(bytes32)').slice(0, 8);
const SEL_ADDR = keccak256Hex('addr(bytes32)').slice(0, 8);
const SEL_NAME = keccak256Hex('name(bytes32)').slice(0, 8);

function namehash(name: string): Uint8Array {
  let node: Uint8Array = new Uint8Array(32);
  if (name) {
    for (const label of name.split('.').reverse()) {
      const labelHash = keccak256(new TextEncoder().encode(label.toLowerCase()));
      const next = new Uint8Array(64);
      next.set(node);
      next.set(labelHash, 32);
      node = keccak256(next);
    }
  }
  return node;
}

// ENSIP-1 reference vectors live in tests/ens.test.mjs
export const testables = {
  namehashHex: (name: string): string => hex(namehash(name)),
};

const hex = (bytes: Uint8Array): string =>
  '0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Build eth_call calldata as `0x` + selector + args, asserting the result is
 * strictly prefixed hex. keccak256Hex returns UNprefixed hex, so without this
 * normalization the data field goes out bare — strict geth upstreams reject
 * it with "hex string without 0x prefix" while tolerant ones mask the bug.
 */
function calldata(selector: string, ...args: string[]): string {
  const data = '0x' + [selector, ...args].map((s) => s.replace(/^0x/, '')).join('');
  if (!/^0x[0-9a-f]+$/.test(data)) throw new Error(`malformed calldata: ${data}`);
  return data;
}

export const isAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s.trim());
export const isEnsName = (s: string): boolean =>
  /^[a-zA-Z0-9-\u00a1-\uFFFF]{1,63}(\.[a-zA-Z0-9-\u00a1-\uFFFF]{1,63})+$/.test(s.trim());

async function ethCall(
  rpcUrls: string[],
  to: string,
  data: string,
  timeoutMs = 4000,
): Promise<string | null> {
  // calldata() owns construction + validation; anything raw passed here must already be prefixed
  let lastError: unknown = null;
  for (const url of rpcUrls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ to, data }, 'latest'],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const json: any = await res.json();
      if (json.error) throw new Error(json.error.message ?? 'rpc error');
      const result: string | undefined = json.result;
      if (typeof result !== 'string' || !/^0x([0-9a-f]{2})*$/i.test(result)) {
        throw new Error('bad rpc result');
      }
      return result;
    } catch (err) {
      lastError = err;
    }
  }
  console.error('ethCall failed on all endpoints', String(lastError));
  return null;
}

/** Forward resolution: ENS name -> 0x address, or null. */
export async function resolveEns(rpcUrls: string[], name: string): Promise<string | null> {
  const node = hex(namehash(name));
  const resolver = await ethCall(rpcUrls, REGISTRY, calldata(SEL_RESOLVER, node));
  if (!resolver || resolver === '0x' || resolver.length < 66) return null;
  const resolverAddr = '0x' + resolver.slice(-40);
  const addr = await ethCall(rpcUrls, resolverAddr, calldata(SEL_ADDR, node));
  if (!addr || addr === '0x' || addr.length < 66) return null;
  return '0x' + addr.slice(-40);
}

/** Reverse resolution: address -> ENS name (best effort, may return null). */
export async function reverseEns(rpcUrls: string[], address: string): Promise<string | null> {
  const node = hex(namehash(address.slice(2).toLowerCase() + '.addr.reverse'));
  const resolver = await ethCall(rpcUrls, REGISTRY, calldata(SEL_RESOLVER, node), 3000);
  if (!resolver || resolver === '0x' || resolver.length < 66) return null;
  const resolverAddr = '0x' + resolver.slice(-40);
  const nameResult = await ethCall(rpcUrls, resolverAddr, calldata(SEL_NAME, node), 3000);
  if (!nameResult || nameResult === '0x' || nameResult.length < 194) return null;
  // decode abi string: offset(32) len(32) data…
  const len = parseInt(nameResult.slice(66, 130), 16);
  if (!Number.isFinite(len) || len === 0 || len > 300) return null;
  const bytes: number[] = [];
  for (let i = 0; i < len * 2; i += 2) {
    bytes.push(parseInt(nameResult.slice(130 + i, 132 + i), 16));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

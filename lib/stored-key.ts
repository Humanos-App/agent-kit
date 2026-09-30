/**
 * A P-256 software key that survives the process: the agent registers in one run and acts in the
 * next, so it must sign with the same key both times. Kept in a file readable only by its owner.
 *
 * The grade this earns is the lowest, `pop/self` (v0.3 §16): the platform has only the agent's
 * word for where the key lives. A key in a KMS or an attested enclave earns more, through the
 * same `ViaAgentKey` interface. Signatures are raw r‖s ES256, as a `via-pop+jwt` requires.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import type { ViaAgentKey } from '@humanos/agent-sdk';

const { subtle } = webcrypto;
const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const;

interface Stored {
  privateJwk: JsonWebKey;
  publicJwk: { kty: string; crv: string; x: string; y: string };
  did?: string;
}

export interface StoredKey extends ViaAgentKey {
  /** The DID the platform gave this key at registration, once there is one. */
  readonly did: string | undefined;
  /** True when this call minted the key (there was no file). */
  readonly minted: boolean;
  save(did: string): void;
}

export async function storedSoftwareKey(file: string): Promise<StoredKey> {
  let stored: Stored;
  let minted = false;
  if (existsSync(file)) {
    stored = JSON.parse(readFileSync(file, 'utf8')) as Stored;
  } else {
    const kp = await subtle.generateKey(EC, true, ['sign', 'verify']);
    const jwk = await subtle.exportKey('jwk', kp.privateKey);
    stored = {
      privateJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
      publicJwk: { kty: jwk.kty!, crv: jwk.crv!, x: jwk.x!, y: jwk.y! },
    };
    writeFileSync(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
    minted = true;
  }
  const signer = await subtle.importKey('jwk', stored.privateJwk, EC, false, ['sign']);
  return {
    publicJwk: stored.publicJwk as ViaAgentKey['publicJwk'],
    claimedAssurance: 'pop',
    claimedBinding: 'self',
    sign: async (bytes) => new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer, bytes)),
    evidence: async () => ({ type: 'none' }),
    get did() {
      return stored.did;
    },
    minted,
    save(did: string) {
      stored.did = did;
      writeFileSync(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
    },
  };
}

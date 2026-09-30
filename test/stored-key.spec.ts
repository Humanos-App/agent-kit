import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ViaGuard } from '@humanos/agent-sdk';
import { createTestVerifier } from '@humanos/agent-sdk/testing';
import { storedSoftwareKey } from '../lib/stored-key.js';

const file = () => join(mkdtempSync(join(tmpdir(), 'via-key-')), 'key.json');

describe('storedSoftwareKey — a key that survives the process', () => {
  it('mints once, then loads the same key; the DID persists; the file is owner-only', async () => {
    const f = file();
    const a = await storedSoftwareKey(f);
    expect(a.minted).toBe(true);
    expect(a.did).toBeUndefined();
    a.save('did:web:humanos.tech:agent:x');
    expect(statSync(f).mode & 0o777).toBe(0o600);

    const b = await storedSoftwareKey(f);
    expect(b.minted).toBe(false);
    expect(b.publicJwk).toEqual(a.publicJwk);
    expect(b.did).toBe('did:web:humanos.tech:agent:x');
    expect(b.publicJwk).not.toHaveProperty('d');
  });

  it('its proofs verify — a reloaded key signs calls a verifier accepts', async () => {
    const f = file();
    await storedSoftwareKey(f);
    const key = await storedSoftwareKey(f);
    const t = createTestVerifier({ rules: [], userParams: {}, agentKey: key });
    const guard = new ViaGuard({ mandate: t.mandate, agentKey: key, verifier: t.verifier, compiled: t.compiled });
    expect((await guard.call('ping', {}, () => 'pong')).decision).toBe('allow');
    expect(t.outcomes).toHaveLength(1); // the outcome report carries a proof too
  });

  it('is the lowest rung, and says so', async () => {
    const key = await storedSoftwareKey(file());
    expect([key.claimedAssurance, key.claimedBinding]).toEqual(['pop', 'self']);
    expect(await key.evidence('nonce')).toEqual({ type: 'none' });
  });
});

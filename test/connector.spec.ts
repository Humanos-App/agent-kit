/**
 * The typed connector calls, against a client double that records what goes on the wire.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ViaMcpClient, ViaToolResult } from '@humanos/agent-sdk';
import { createViaMcpClient, ViaMcpAuthError } from '@humanos/agent-sdk';
import { ConnectorRefusal, call, getActor, mandateKinds, proposeAction, registerAgent, requestPolicyMandate } from '../lib/connector.js';
import { suggestedUserParams } from '../lib/surface.js';
import { errorLine } from '../lib/cli.js';
import { storedSoftwareKey } from '../lib/stored-key.js';
import { loadEnv } from '../lib/env.js';
import { writeFileSync } from 'node:fs';
import { CLAIMS_SURFACE } from '../examples/claims/agent.js';
import { SUPPORT_SURFACE } from '../examples/support/agent.js';

const json = (v: unknown): ViaToolResult => ({ text: JSON.stringify(v), isError: false });

/** The connector deployed before the policy release: it still serves `get_actor` and `list_mandate_kinds`. */
const TOOLS_BEFORE_POLICY = ['server_info', 'get_actor', 'list_mandate_kinds', 'get_mandate', 'request_mandate', 'mandate_status', 'stepup_status'];
/** The connector with the organization's policy: `get_policy` in their place. */
const TOOLS_WITH_POLICY = ['server_info', 'get_policy', 'get_mandate', 'request_mandate', 'mandate_status'];

function fakeClient(answer: (name: string, args: Record<string, unknown>) => ViaToolResult, tools = TOOLS_BEFORE_POLICY) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client: ViaMcpClient = {
    initialize: async () => ({ serverInfo: { name: 'fake', version: '0' }, protocolVersion: '2025-11-25' }),
    listTools: async () => tools.map((name) => ({ name, inputSchema: { type: 'object' } })) as never,
    callTool: async (name, args = {}) => {
      calls.push({ name, args });
      return answer(name, args);
    },
  };
  return { client, calls };
}

describe('connector', () => {
  it('call: a refusal is a ConnectorRefusal carrying the server\'s words', async () => {
    const { client } = fakeClient(() => ({ text: 'no such agent', isError: true }));
    await expect(call(client, 'get_actor')).rejects.toThrow(ConnectorRefusal);
    await expect(call(client, 'get_actor')).rejects.toThrow('get_actor refused: no such agent');
  });

  it('getActor: the fields sit under record, null while the registration is queued', async () => {
    const record = { id: 'did:x', actorType: 'agent', status: 'active', assurance: 'pop', binding: 'self', chain: { genesisEvent: 'e1', headEvent: 'e2', sequence: 2 } };
    const { client, calls } = fakeClient(() => json({ record, lastEventAt: '2026-10-13T00:00:00Z', retiredActors: [] }));
    expect((await getActor(client, 'did:x'))?.record?.status).toBe('active');
    expect(calls[0]).toEqual({ name: 'get_actor', args: { did: 'did:x' } });

    const { client: queued } = fakeClient(() => json({ record: null, lastEventAt: null, retiredActors: [] }));
    expect((await getActor(queued, 'did:x'))?.record).toBeNull();
  });

  it('getActor: a connector with the policy reads no actor — null, and get_actor is never called', async () => {
    const { client, calls } = fakeClient(() => json({}), TOOLS_WITH_POLICY);
    expect(await getActor(client, 'did:x')).toBeNull();
    expect(calls).toEqual([]);
  });

  it.each([
    ['before the policy release, list_mandate_kinds', TOOLS_BEFORE_POLICY, 'list_mandate_kinds'],
    ['with the policy, the mandate controls get_policy lists', TOOLS_WITH_POLICY, 'get_policy'],
  ])('mandateKinds: the published actions a mandate can be asked under — %s', async (_case, tools, tool) => {
    const { client, calls } = fakeClient(
      (name) =>
        name === 'list_mandate_kinds'
          ? json({ policies: [{ id: 'urn:via:action:a', name: 'Claims', version: 2, userParams: {} }], drafts: [] })
          : json({
              tools: [
                { tool: 'pay', mandateControls: [{ id: 'urn:via:action:a', name: 'Claims' }] },
                { tool: 'refund', mandateControls: [{ id: 'urn:via:action:a', name: 'Claims' }] },
                { tool: 'read' },
              ],
            }),
      tools,
    );
    const kinds = await mandateKinds(client, 'did:x');
    expect(kinds.policies.map((p) => [p.id, p.name])).toEqual([['urn:via:action:a', 'Claims']]);
    expect(calls.map((c) => c.name)).toEqual([tool]);
    // Read from the policy, a missing action may be published with no tool taking a mandate under it.
    expect(kinds.fromPolicy ?? false).toBe(tool === 'get_policy');
  });

  it('getActor: a connector from before 2026-10-13 answers the fields at the top, read as the record', async () => {
    const { client } = fakeClient(() => json({ id: 'did:x', actorType: 'agent', status: 'ACTIVE', assurance: 'pop', binding: 'self' }));
    expect(await getActor(client, 'did:x')).toMatchObject({ record: { id: 'did:x', status: 'ACTIVE' }, lastEventAt: null, retiredActors: [] });
  });

  it('registerAgent: challenge, then the public key + nonce-bound evidence + the declared tools', async () => {
    const key = await storedSoftwareKey(join(mkdtempSync(join(tmpdir(), 'via-')), 'k.json'));
    const { client, calls } = fakeClient((name) =>
      name === 'register_challenge' ? json({ regNonce: 'n-1', aud: 'did:web:humanos.tech' }) : json({ did: 'did:x', keyId: 'k', granted: { assurance: 'pop', binding: 'self' }, existing: false }),
    );
    const reg = await registerAgent(client, key, CLAIMS_SURFACE);
    expect(reg.did).toBe('did:x');
    expect(calls.map((c) => c.name)).toEqual(['register_challenge', 'register']);
    const args = calls[1]!.args as { publicKeyJwk: Record<string, string>; regNonce: string; evidence: unknown; tools: { name: string }[] };
    expect(args.regNonce).toBe('n-1');
    // The key proves it is held: a via-reg+jwt over the nonce and the platform DID (v0.3 §16.5).
    expect(args.evidence).toMatchObject({ type: 'device-self', proof: expect.stringMatching(/^ey/) });
    expect(args.publicKeyJwk).not.toHaveProperty('d'); // the private half never leaves
    expect(args.tools.map((t) => t.name)).toEqual(CLAIMS_SURFACE.tools.map((t) => t.name));
  });

  it('proposeAction: the surface with its grantor params and rules, for this agent', async () => {
    const { client, calls } = fakeClient(() => json({ actionId: 'a', status: 'DRAFT', userParams: [], executionParams: [], next: '' }));
    await proposeAction(client, 'did:x', SUPPORT_SURFACE);
    expect(calls[0]!.args).toMatchObject({ name: SUPPORT_SURFACE.name, did: 'did:x', rules: SUPPORT_SURFACE.rules });
    expect(Object.keys(calls[0]!.args.grantorParams as object)).toEqual(['credit_limit', 'allow_contact_changes']);
  });

  it('requestPolicyMandate: a policy request carrying the §20 description the person reads', async () => {
    const { client, calls } = fakeClient(() => json({ mandateId: 'm', status: 'DRAFT', consentCard: { terms: '', grantor: 'a@b', expiresAt: '', note: '' } }));
    await requestPolicyMandate(client, { did: 'did:x', actionId: 'act', userParams: { credit_limit: 50 }, contact: 'a@b', name: 'N', description: 'D' });
    expect(calls[0]!.args).toEqual({ kind: 'policy', actionId: 'act', userParams: { credit_limit: 50 }, grantor: { contact: 'a@b' }, name: 'N', description: 'D', did: 'did:x' });
  });

  it('suggestedUserParams keeps only what the published policy has', () => {
    expect(suggestedUserParams(SUPPORT_SURFACE, { credit_limit: {} })).toEqual({ credit_limit: 50 });
    expect(suggestedUserParams(SUPPORT_SURFACE)).toEqual({ credit_limit: 50, allow_contact_changes: true });
  });
});

describe('connector HTTP errors, through the SDK client', () => {
  // The response body is the only thing that tells these failures apart, so it must reach the error.
  const answering = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    createViaMcpClient({
      url: 'https://connector.test/mcp',
      apiKey: 'key',
      signatureSecret: 'secret',
      fetchImpl: async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }),
    });

  it('a signature refusal carries the connector\'s words, the status and the body', async () => {
    const body = { message: 'Invalid signature', error: 'Unauthorized', statusCode: 401 };
    const error = await answering(401, body).listTools().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ViaMcpAuthError);
    expect(error).toMatchObject({ status: 401, body, message: 'credential refused (HTTP 401): Invalid signature' });
  });

  it('a token refusal carries the OAuth description and the challenge', async () => {
    const challenge = 'Bearer error="invalid_token", resource_metadata="https://connector.test/.well-known/oauth-protected-resource"';
    const body = { error: 'invalid_token', error_description: 'invalid token' };
    const error = await answering(401, body, { 'WWW-Authenticate': challenge }).listTools().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 401, body, message: `credential refused (HTTP 401): invalid token [${challenge}]` });
  });

  it('a connector never reached names the URL and the reason, which fetch keeps in its cause', async () => {
    const refused = (url: string) =>
      createViaMcpClient({
        url,
        apiKey: 'key',
        signatureSecret: 'secret',
        fetchImpl: async () => {
          throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:4006') });
        },
      })
        .listTools()
        .catch((e: unknown) => e);
    const local = 'http://localhost:4006/mcp';
    expect(errorLine(await refused(local), local)).toBe(`could not reach the connector at ${local}: connect ECONNREFUSED 127.0.0.1:4006`);
    const tls = 'https://localhost:4005/mcp';
    expect(errorLine(await refused(tls), tls)).toMatch(/serves http, not https$/);
    expect(errorLine(new Error('register first'))).toBe('register first');
  });

  it('any other HTTP failure names the server\'s reason', async () => {
    await expect(answering(500, { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'boom' } }).listTools()).rejects.toThrow(
      'MCP request failed: HTTP 500: boom',
    );
    await expect(answering(502, '<html>\n  Bad Gateway\n</html>').listTools()).rejects.toThrow('MCP request failed: HTTP 502: <html> Bad Gateway </html>');
  });
});

describe('env', () => {
  it('earlier files win, existing env wins over files, comments and quotes handled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'via-env-'));
    writeFileSync(join(dir, 'a'), '# c\nA="1"\nB=2\n');
    writeFileSync(join(dir, 'b'), 'B=3\nC=4\n#D=5\n');
    const env: NodeJS.ProcessEnv = { C: 'kept' };
    loadEnv([join(dir, 'a'), join(dir, 'missing'), join(dir, 'b')], env);
    expect(env).toEqual({ A: '1', B: '2', C: 'kept' });
  });
});

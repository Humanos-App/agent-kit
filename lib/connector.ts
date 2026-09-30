/**
 * The Humanos connector, typed: registration, proposals, mandate requests, status and step-up
 * polling, over the MCP client `@humanos/agent-sdk` provides. Every call is authenticated with the
 * organization's API key; a refusal is a `ConnectorRefusal` carrying the connector's own words.
 */
import { createViaMcpClient, type ViaAgentKey, type ViaMcpClient } from '@humanos/agent-sdk';
import { must } from './env.js';
import { toDeclaration, toProposal, type AgentSurface } from './surface.js';

export function connect(env: NodeJS.ProcessEnv = process.env): ViaMcpClient {
  return createViaMcpClient({
    url: must('HUMANOS_MCP_URL', env),
    apiKey: must('HUMANOS_API_KEY', env),
    signatureSecret: must('HUMANOS_SIGNATURE_SECRET', env),
    protocolVersion: '2025-11-25',
  });
}

/** The connector said no. A decision, not a transport failure — do not retry blindly. */
export class ConnectorRefusal extends Error {
  constructor(
    readonly tool: string,
    readonly detail: string,
  ) {
    super(`${tool} refused: ${detail}`);
    this.name = 'ConnectorRefusal';
  }
}

export async function call<T>(client: ViaMcpClient, tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await client.callTool(tool, args);
  if (r.isError) throw new ConnectorRefusal(tool, r.text);
  try {
    return JSON.parse(r.text) as T;
  } catch {
    throw new ConnectorRefusal(tool, `unparseable answer: ${r.text.slice(0, 200)}`);
  }
}

export interface ServerInfo {
  subject: string;
  credential: { organization: string; authMethod: string; canSignDecisions: boolean };
}

/**
 * What `get_actor` returns: the actor's subject as the fold derives it from its chain (v0.3 §3.1,
 * §5).
 * The organization an agent acts for is the `operator` POINTER to the org-signed AFFILIATION.
 */
export interface ActorSummary {
  id: string;
  actorType: string;
  status: string;
  assurance?: string;
  binding?: string;
  operator?: { org: string; relation?: string; affiliationEvent: string };
  keys?: unknown[];
}

export function getActor(client: ViaMcpClient, did: string): Promise<ActorSummary> {
  return call<ActorSummary>(client, 'get_actor', { did });
}

export interface Registered {
  did: string;
  keyId: string;
  granted: { assurance: string; binding: string };
  degradedFrom?: string;
  existing: boolean;
}

/** §16.5 (v0.3): challenge → evidence bound to the nonce → the platform grades the rung. */
export async function registerAgent(client: ViaMcpClient, key: ViaAgentKey, surface: AgentSurface): Promise<Registered> {
  const { regNonce } = await call<{ regNonce: string }>(client, 'register_challenge');
  return call<Registered>(client, 'register', {
    publicKeyJwk: key.publicJwk,
    evidence: await key.evidence(regNonce),
    regNonce,
    tools: toDeclaration(surface),
  });
}

export interface Proposed {
  actionId: string;
  status: string;
  userParams: string[];
  executionParams: string[];
  unchanged?: boolean;
  next: string;
}

export function proposeAction(client: ViaMcpClient, did: string, surface: AgentSurface): Promise<Proposed> {
  return call<Proposed>(client, 'propose_action', { ...toProposal(surface), did });
}

export interface MandateKinds {
  policies: { id: string; name: string; version: number; userParams: Record<string, unknown> }[];
  drafts: { id: string; name: string }[];
}

export function mandateKinds(client: ViaMcpClient): Promise<MandateKinds> {
  return call<MandateKinds>(client, 'list_mandate_kinds');
}

export interface MandateRequested {
  mandateId: string;
  status: string;
  consentCard: { link?: string; terms: string; grantor: string; expiresAt: string; note: string };
}

export function requestPolicyMandate(
  client: ViaMcpClient,
  req: { did: string; actionId: string; userParams: Record<string, unknown>; contact: string; name: string; description: string },
): Promise<MandateRequested> {
  return call<MandateRequested>(client, 'request_mandate', {
    kind: 'policy',
    actionId: req.actionId,
    userParams: req.userParams,
    grantor: { contact: req.contact },
    name: req.name,
    description: req.description,
    did: req.did,
  });
}

export interface MandateStatus {
  mandateId: string;
  phase: 'PENDING' | 'ACTIVE' | 'REFUSED' | 'INACTIVE';
  decisions: { contact: string; accepted: boolean; decidedAt: string }[];
}

export function mandateStatus(client: ViaMcpClient, mandateId: string): Promise<MandateStatus> {
  return call<MandateStatus>(client, 'mandate_status', { mandateId });
}

export type StepUpState = 'pending' | 'approved' | 'declined' | 'expired' | 'consumed';

/**
 * v0.3 §17.4: wait for the person to decide a step-up. They approve on their own device, out of
 * band; the guard's `onRechallenge` resolves true once they have, so it awaits this.
 */
export async function waitForStepUp(
  client: ViaMcpClient,
  id: string,
  opts: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<StepUpState | 'timeout'> {
  const pollMs = opts.pollMs ?? 2_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    const { status } = await call<{ status: StepUpState }>(client, 'stepup_status', { id });
    if (status !== 'pending') return status;
    if (Date.now() >= deadline) return 'timeout';
    await sleep(pollMs);
  }
}

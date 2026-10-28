/**
 * The Humanos connector, typed: registration, proposals, the organization's policy, mandate
 * requests and status, over the MCP client `@humanos/agent-sdk` provides. Every call is
 * authenticated with the organization's API key; a refusal is a `ConnectorRefusal` carrying the
 * connector's own words.
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
 * The VIAActor record (v0.3 §3.1): the actor's subject as the fold derives it from its chain (§5),
 * and the position on that chain it was folded to. `status` is `active` / `suspended` / `retired`.
 * The organization an agent acts for is the `operator` POINTER to the org-signed AFFILIATION.
 */
export interface ActorRecord {
  id: string;
  actorType: string;
  status: string;
  assurance?: string;
  binding?: string;
  operator?: { org: string; relation?: string; validUntil?: string; affiliationEvent: string };
  keys?: unknown[];
  chain: { genesisEvent: string; headEvent: string; sequence: number };
}

/**
 * What `get_actor` returns. `record` is null while the registration is still queued: the actor
 * exists, its chain does not yet.
 */
export interface ActorSummary {
  record: ActorRecord | null;
  /** When the chain's last event was signed. Null with no chain. */
  lastEventAt: string | null;
  /** The actors merged into this one, each with the position of its own chain. */
  retiredActors: { id: string; succeededBy: string | null; lastEventAt: string | null }[];
}

/** The tools a connector serves, read once per client: a newer connector drops some the kit calls. */
const served = new WeakMap<ViaMcpClient, Promise<Set<string>>>();
export function serves(client: ViaMcpClient, tool: string): Promise<boolean> {
  let names = served.get(client);
  if (!names) {
    names = client.listTools().then((tools) => new Set(tools.map((t) => t.name)));
    served.set(client, names);
  }
  return names.then((n) => n.has(tool));
}

/** The agent's record, or null where the connector reads no actor (`get_actor` left it with the policy release). */
export async function getActor(client: ViaMcpClient, did: string): Promise<ActorSummary | null> {
  if (!(await serves(client, 'get_actor'))) return null;
  const answer = await call<ActorSummary | ActorRecord>(client, 'get_actor', { did });
  // A connector deployed before 2026-10-13 answers the record's fields at the top, with no `record`.
  return 'record' in answer ? answer : { record: answer, lastEventAt: null, retiredActors: [] };
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
  // `aud` is the platform DID the key's proof names (v0.3 §16.5).
  const { regNonce, aud } = await call<{ regNonce: string; aud: string }>(client, 'register_challenge');
  return call<Registered>(client, 'register', {
    publicKeyJwk: key.publicJwk,
    evidence: await key.evidence(regNonce, aud),
    regNonce,
    tools: toDeclaration(surface),
  });
}

export interface Declared {
  recorded: number;
  /** Tools declared before and left out now: kept, marked as no longer declared. */
  absent: number;
  /** Tools the connector left out, with why (`invalid_schema`, `agent_tool_limit`, …). */
  skipped: { index: number; name: string | null; reason: string }[];
  /** What the connector says to do next, in words. */
  next: string;
}

/**
 * Declare the agent's tools again, as `register` declared them: the whole surface (`complete`), so a tool the agent
 * no longer has, or one declared under another service, is marked as no longer declared. A connector without
 * `complete` updates only this surface's service.
 */
export function declareTools(client: ViaMcpClient, did: string, surface: AgentSurface): Promise<Declared> {
  return call<Declared>(client, 'declare_tools', { tools: toDeclaration(surface), complete: true, did });
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

/**
 * A tool's access, as the organization's policy sets it for the agent (v0.3 §21.1). The dashboard calls them
 * Allow, Restrict (`rules`), Delegate (`mandate`) and Deny; `not_set` when no entry names the tool.
 */
export type ToolAccess = 'allow' | 'rules' | 'mandate' | 'deny' | 'not_set';

/** What `get_policy` answers: the organization's policy as it applies to the agent's declared tools. */
export interface AgentPolicyView {
  /** A refusal every call meets whatever the tool (`actor_suspended`, …); absent when the agent may act. */
  standing?: string;
  /** The version in force and its `default`, for a tool no entry sets; null when no policy decides the agent's calls. */
  policy: { id: string; version: number; default: 'allow' | 'deny' } | null;
  /** The control every call must also pass. */
  everyCall?: { id: string; name: string };
  tools: {
    tool: string;
    access: ToolAccess;
    /** What the access means for the agent, in one sentence. */
    meaning: string;
    /** `rules`: the controls a call must pass. */
    controls?: { id: string; name: string }[];
    /** `mandate`: the mandate controls a person can grant the tool through. */
    mandateControls?: { id: string; name: string }[];
  }[];
}

export function getPolicy(client: ViaMcpClient, agentDid: string): Promise<AgentPolicyView> {
  return call<AgentPolicyView>(client, 'get_policy', { agentDid });
}

export interface MandateKinds {
  /** `version` and `userParams` only from `list_mandate_kinds`; `get_policy` names a control by id and name. */
  policies: { id: string; name: string; version?: number; userParams?: Record<string, unknown> }[];
  drafts: { id: string; name: string }[];
  /**
   * Read from `get_policy`: only the controls a tool set to Delegate takes a mandate under. A published
   * action no such tool names is missing, and drafts are never listed.
   */
  fromPolicy?: boolean;
}

/**
 * The published actions the agent can be granted a mandate under. A connector with the organization's policy
 * dropped `list_mandate_kinds`: there they are the mandate controls `get_policy` lists for the agent's tools.
 */
export async function mandateKinds(client: ViaMcpClient, agentDid: string): Promise<MandateKinds> {
  if (await serves(client, 'list_mandate_kinds')) return call<MandateKinds>(client, 'list_mandate_kinds');
  if (!agentDid) return { policies: [], drafts: [] };
  const view = await getPolicy(client, agentDid);
  const controls = new Map(view.tools.flatMap((t) => t.mandateControls ?? []).map((c) => [c.id, c]));
  return { policies: [...controls.values()], drafts: [], fromPolicy: true };
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
  kind: 'policy' | 'authorization';
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
  phase: 'PENDING' | 'ACTIVE' | 'REFUSED' | 'INACTIVE';
  boundAgentDids: string[];
}

export function mandateStatus(client: ViaMcpClient, mandateId: string): Promise<MandateStatus> {
  return call<MandateStatus>(client, 'mandate_status', { mandateId });
}

/**
 * An agent's tool surface, written once and projected three ways: the `propose_action` payload
 * the organization reviews, the `register` / `declare_tools` declaration, and the function list
 * the LLM sees.
 *
 * Writing it once keeps the three in step: a tool the model can call is always a tool the
 * organization reviewed and the person's mandate covers.
 */
export interface ParamSpec {
  type: 'string' | 'number' | 'boolean' | 'array';
  description: string;
  required?: boolean;
  /** Element type, for `array`. */
  items?: 'string' | 'number';
  /** The values it may take; for `array`, each element's. */
  enum?: (string | number)[];
  /** A JSON Schema format, e.g. `email`. */
  format?: string;
  /** A regular expression a string matches. */
  pattern?: string;
  minimum?: number;
  maximum?: number;
  /** What the tool uses when the parameter is left out. */
  default?: string | number | boolean;
}

/**
 * MCP's hints on how a tool behaves (`ToolAnnotations`), declared to Humanos with it: what the
 * organization sees beside the tool, and what its risk is assessed from.
 */
export interface ToolAnnotations {
  /** It changes nothing. */
  readOnlyHint?: boolean;
  /** It may overwrite or remove what is there, rather than only add to it. */
  destructiveHint?: boolean;
  /** Calling it again with the same arguments changes nothing more. */
  idempotentHint?: boolean;
  /** It reaches people or systems outside the organization's own. */
  openWorldHint?: boolean;
}

export interface ToolSpec {
  name: string;
  /** A short name for people, as MCP's `title`. */
  title?: string;
  description: string;
  params: Record<string, ParamSpec>;
  annotations?: ToolAnnotations;
}

export interface GrantorParamSpec extends ParamSpec {
  /** What the agent asks for when requesting the mandate; the person can change it. */
  suggested: unknown;
}

export interface RuleSpec {
  name: string;
  /** Plain language — the person reads this on the consent screen. */
  description: string;
  /**
   * CEL over `userParams` (what the person set) and `executionParams` (this call, including its
   * `tool`). A limit that concerns one tool says so: `executionParams.tool != 'x' || …`.
   */
  expression: string;
}

export interface AgentSurface {
  /** The action's name on the platform. */
  name: string;
  description: string;
  /** The service its tools come from, as the dashboard groups them. */
  service: string;
  tools: ToolSpec[];
  grantorParams: Record<string, GrantorParamSpec>;
  rules: RuleSpec[];
}

/** The `propose_action` arguments (minus `did`). */
export function toProposal(s: AgentSurface): Record<string, unknown> {
  return {
    name: s.name,
    description: s.description,
    tools: s.tools.map((t) => ({ name: t.name, description: t.description, params: t.params })),
    grantorParams: s.grantorParams,
    rules: s.rules,
  };
}

/** The `register` and `declare_tools` declaration: each tool as an MCP server describes one, with its service. */
export function toDeclaration(s: AgentSurface): Record<string, unknown>[] {
  return s.tools.map((t) => ({
    name: t.name,
    ...(t.title ? { title: t.title } : {}),
    description: t.description,
    service: s.service,
    inputSchema: toInputSchema(t.params),
    ...(t.annotations ? { annotations: t.annotations } : {}),
  }));
}

/** A tool's parameters as the JSON Schema of its input: what the model sees, and what Humanos records. */
export function toInputSchema(params: Record<string, ParamSpec>): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(params).map(([k, p]) => [k, _paramSchema(p)])),
    required: Object.entries(params)
      .filter(([, p]) => p.required)
      .map(([k]) => k),
  };
}

/** The suggested limits, for `request_mandate`, keeping only the ones the published policy has. */
export function suggestedUserParams(s: AgentSurface, published?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s.grantorParams)) if (!published || k in published) out[k] = v.suggested;
  return out;
}

/** OpenAI-style function definitions (what OpenRouter takes). */
export function toLlmTools(s: AgentSurface): LlmTool[] {
  return s.tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: toInputSchema(t.params),
    },
  }));
}

export interface LlmTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** What a parameter's JSON Schema carries besides its type and values. */
const SCHEMA_FACTS = ['description', 'format', 'pattern', 'minimum', 'maximum', 'default'] as const;

/** One parameter's JSON Schema: its type, then every fact the spec states. An array's `enum` bounds its elements. */
function _paramSchema(p: ParamSpec): Record<string, unknown> {
  const values = p.enum ? { enum: p.enum } : {};
  const facts = Object.fromEntries(SCHEMA_FACTS.flatMap((k) => (p[k] === undefined ? [] : [[k, p[k]]])));
  return p.type === 'array' ? { type: p.type, items: { type: p.items ?? 'string', ...values }, ...facts } : { type: p.type, ...values, ...facts };
}

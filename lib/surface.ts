/**
 * An agent's tool surface, written once and projected three ways: the `propose_action` payload
 * the organization reviews, the `register` declaration, and the function list the LLM sees.
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
}

export interface ToolSpec {
  name: string;
  description: string;
  params: Record<string, ParamSpec>;
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

/** The `register` tool declaration. */
export function toDeclaration(s: AgentSurface): Record<string, unknown>[] {
  return s.tools.map((t) => ({ name: t.name, description: t.description, params: t.params }));
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
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(t.params).map(([k, p]) => [
            k,
            p.type === 'array' ? { type: 'array', items: { type: p.items ?? 'string' }, description: p.description } : { type: p.type, description: p.description },
          ]),
        ),
        required: Object.entries(t.params).filter(([, p]) => p.required).map(([k]) => k),
      },
    },
  }));
}

export interface LlmTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

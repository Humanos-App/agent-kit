/**
 * The LLM driver: the model picks the tools, every call goes through the guard, and a deny goes
 * back to the model as a tool message it must explain rather than work around. Any
 * OpenAI-compatible chat endpoint works; `openRouter` is the one wired in.
 */
import type { LlmTool } from './surface.js';
import type { StepResult } from './runner.js';

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export type CallModel = (messages: ModelMessage[], tools: LlmTool[]) => Promise<ModelMessage>;

export function openRouter(opts: { apiKey: string; model?: string; title?: string }): CallModel {
  return async (messages, tools) => {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}`, 'x-title': opts.title ?? 'Humanos agent kit' },
      body: JSON.stringify({ model: opts.model || 'openai/gpt-4o-mini', messages, tools, tool_choice: 'auto' }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return ((await res.json()) as { choices: { message: ModelMessage }[] }).choices[0]!.message;
  };
}

/** What the model reads back for one call. A deny says not to retry — retrying after a deny is a scored risk factor. */
export function toolMessage(r: StepResult): string {
  if (r.decision === 'deny') {
    if (r.reason === 'unknown_tool') return `ERROR: there is no tool called ${r.tool}.`;
    return `BLOCKED by the person's mandate (${r.reason}${r.failedRules ? `: ${r.failedRules.join(', ')}` : ''}). Nothing was done. Do not retry this call; explain to the user why it was blocked and what they can do instead.`;
  }
  if (r.error) return `FAILED: ${r.error}`;
  return typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
}

/**
 * One user turn: call the model, run the tools it asks for, feed the results back, until it
 * answers in text. `history` is mutated — it is the conversation.
 */
export async function chatTurn(
  history: ModelMessage[],
  userText: string,
  deps: { callModel: CallModel; tools: LlmTool[]; execute: (tool: string, args: Record<string, unknown>) => Promise<StepResult>; maxRounds?: number },
): Promise<{ reply: string; calls: StepResult[] }> {
  history.push({ role: 'user', content: userText });
  const calls: StepResult[] = [];
  for (let round = 0; round < (deps.maxRounds ?? 8); round++) {
    const msg = await deps.callModel(history, deps.tools);
    history.push({ role: 'assistant', content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
    if (!msg.tool_calls?.length) return { reply: msg.content ?? '', calls };
    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        history.push({ role: 'tool', tool_call_id: tc.id, content: 'ERROR: the arguments were not valid JSON.' });
        continue;
      }
      const r = await deps.execute(tc.function.name, args);
      calls.push(r);
      history.push({ role: 'tool', tool_call_id: tc.id, content: toolMessage(r) });
    }
  }
  return { reply: '(stopped: too many tool rounds in one turn)', calls };
}

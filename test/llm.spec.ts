/**
 * The LLM driver with a scripted model: the model's tool calls go through the guarded executor,
 * a deny comes back as a tool message telling it not to retry, and the loop ends on text.
 */
import { describe, expect, it } from 'vitest';
import { chatTurn, toolMessage, type CallModel, type ModelMessage } from '../lib/llm.js';
import { toLlmTools } from '../lib/surface.js';
import type { StepResult } from '../lib/runner.js';
import { SUPPORT_SURFACE } from '../examples/support/agent.js';
import { CLAIMS_SURFACE } from '../examples/claims/agent.js';

const toolCall = (id: string, name: string, args: unknown): ModelMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

function scriptedModel(replies: ModelMessage[]): CallModel & { seen: ModelMessage[][] } {
  const seen: ModelMessage[][] = [];
  const fn: CallModel = async (messages) => {
    seen.push(structuredClone(messages));
    const r = replies.shift();
    if (!r) throw new Error('model script exhausted');
    return r;
  };
  return Object.assign(fn, { seen });
}

describe('toLlmTools', () => {
  it('projects every tool with its required params, arrays typed', () => {
    const tools = toLlmTools(CLAIMS_SURFACE);
    expect(tools.map((t) => t.function.name)).toEqual(CLAIMS_SURFACE.tools.map((t) => t.name));
    const docs = tools.find((t) => t.function.name === 'request_documents')!.function.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(docs.properties.documents).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(docs.required).toEqual(['claim_id', 'documents']);
  });
});

describe('chatTurn', () => {
  it('runs the tool calls through the executor and feeds a deny back as "do not retry"', async () => {
    const model = scriptedModel([
      toolCall('1', 'issue_goodwill_credit', { policy_id: 'P-1002', amount_eur: 200, reason: 'angry' }),
      { role: 'assistant', content: 'I can offer up to €50; I have passed you to a colleague for more.' },
    ]);
    const executed: string[] = [];
    const execute = async (tool: string, args: Record<string, unknown>): Promise<StepResult> => {
      executed.push(tool);
      return { tool, args, decision: 'deny', reason: 'rule_failed', failedRules: ['goodwill_credit_cap'] };
    };
    const history: ModelMessage[] = [{ role: 'system', content: 'sys' }];
    const out = await chatTurn(history, 'I want €200', { callModel: model, tools: toLlmTools(SUPPORT_SURFACE), execute });

    expect(executed).toEqual(['issue_goodwill_credit']);
    expect(out.reply).toContain('€50');
    expect(out.calls[0]).toMatchObject({ decision: 'deny' });
    const toolMsg = model.seen[1]!.find((m) => m.role === 'tool')!;
    expect(toolMsg.tool_call_id).toBe('1');
    expect(toolMsg.content).toMatch(/BLOCKED.*goodwill_credit_cap.*Do not retry/);
  });

  it('bad JSON arguments are answered without executing anything', async () => {
    const model = scriptedModel([
      { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'lookup_policy', arguments: '{nope' } }] },
      { role: 'assistant', content: 'sorry' },
    ]);
    let ran = false;
    await chatTurn([], 'hi', { callModel: model, tools: [], execute: async () => ((ran = true), { tool: '', args: {}, decision: 'allow' }) });
    expect(ran).toBe(false);
    expect(model.seen[1]!.at(-1)!.content).toMatch(/not valid JSON/);
  });

  it('stops after maxRounds instead of looping forever', async () => {
    const model: CallModel = async () => toolCall('r', 'lookup_policy', { policy_id: 'P-1001' });
    const out = await chatTurn([], 'loop', { callModel: model, tools: [], execute: async (t, a) => ({ tool: t, args: a, decision: 'allow', result: 'ok' }), maxRounds: 3 });
    expect(out.calls).toHaveLength(3);
    expect(out.reply).toMatch(/too many tool rounds/);
  });
});

describe('toolMessage', () => {
  it('distinguishes allowed, failed, denied and unknown', () => {
    expect(toolMessage({ tool: 't', args: {}, decision: 'allow', result: 'done' })).toBe('done');
    expect(toolMessage({ tool: 't', args: {}, decision: 'allow', error: 'boom' })).toBe('FAILED: boom');
    expect(toolMessage({ tool: 't', args: {}, decision: 'deny', reason: 'stepup_declined' })).toMatch(/^BLOCKED.*stepup_declined/);
    expect(toolMessage({ tool: 'x', args: {}, decision: 'deny', reason: 'unknown_tool' })).toMatch(/no tool called x/);
  });
});

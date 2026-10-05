/**
 * apps/web/__tests__/approval-handler.test.ts
 *
 * Integration tests for the approval-handler and LLM-lane flow:
 *   task directive → earStore.set() → user "Approved" → isApprovalMessage()
 *   → earStore.get() → earStore.clear() → dispatchLeadAgent() → SSE stream
 *
 *   Normal message → sidecarRunStream() → same SSE stream format
 */

import { isApprovalMessage, POST } from '../app/api/chat/route';
import * as earStoreModule from '../lib/ear-store';
import * as agentDispatch from '../lib/agent-dispatch';
import { NextRequest } from 'next/server';
import type { EAR } from '../lib/ear-store';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRequest(body: object): NextRequest {
  return new NextRequest('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readStream(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(decoder.decode(value, { stream: true }));
  }
  return parts.join('');
}

const TEST_EAR: EAR = {
  conversationId: 'conv-001',
  directive: 'Research quantum computing advances in 2026',
  agentId: 'lead-agent',
  createdAt: Date.now(),
};

// ── setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  jest.restoreAllMocks();
});

// ── isApprovalMessage ─────────────────────────────────────────────────────────

describe('isApprovalMessage()', () => {
  const YES = ['Approved', 'approved', 'Approve', 'yes', 'Yes.', 'go ahead', 'Go Ahead!', 'confirm', 'ok', 'okay', 'do it'];
  const NO  = ['not yet', 'maybe', 'tell me more', 'approve this task', 'yes please do more'];

  test.each(YES)('returns true for "%s"', (msg) => expect(isApprovalMessage(msg)).toBe(true));
  test.each(NO)('returns false for "%s"', (msg) => expect(isApprovalMessage(msg)).toBe(false));
});

// ── Approval lane ─────────────────────────────────────────────────────────────

describe('POST /api/chat — approval lane', () => {
  test('400 when conversationId is missing', async () => {
    const res = await POST(makeRequest({ message: 'Approved' }));
    expect(res.status).toBe(400);
  });

  test('400 when message is missing', async () => {
    const res = await POST(makeRequest({ conversationId: 'conv-001' }));
    expect(res.status).toBe(400);
  });

  test('falls through to LLM lane when approval message but no pending EAR', async () => {
    jest.spyOn(earStoreModule.earStore, 'get').mockResolvedValue(null);
    const runStream = jest.spyOn(agentDispatch, 'sidecarRunStream').mockImplementation(async (_msgs, { onEnd }) => { onEnd(); });
    const dispatch = jest.spyOn(agentDispatch, 'dispatchLeadAgent').mockResolvedValue(undefined);

    const res = await POST(makeRequest({ conversationId: 'conv-001', message: 'Approved' }));
    expect(res.status).toBe(200);
    expect(runStream).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('falls through to LLM lane for non-approval message', async () => {
    jest.spyOn(earStoreModule.earStore, 'get').mockResolvedValue(TEST_EAR);
    jest.spyOn(agentDispatch, 'sidecarRunStream').mockImplementation(async (_msgs, { onEnd }) => { onEnd(); });

    const res = await POST(makeRequest({ conversationId: 'conv-001', message: 'What is the plan?' }));
    expect(res.status).toBe(200);
    // earStore.get is NOT called for non-approval messages (skips the earStore lookup entirely)
    expect(agentDispatch.sidecarRunStream).toHaveBeenCalled();
  });

  test('clears EAR before dispatching (prevents double-dispatch)', async () => {
    jest.spyOn(earStoreModule.earStore, 'get').mockResolvedValue(TEST_EAR);
    const clearSpy = jest.spyOn(earStoreModule.earStore, 'clear').mockResolvedValue(undefined);
    const dispatch = jest.spyOn(agentDispatch, 'dispatchLeadAgent').mockImplementation(async ({ onEnd }) => { onEnd(); });

    await POST(makeRequest({ conversationId: 'conv-001', message: 'Approved' }));

    expect(clearSpy).toHaveBeenCalledWith('conv-001');
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ ear: TEST_EAR }));
    // clear must be called before dispatch (order matters)
    const clearOrder = clearSpy.mock.invocationCallOrder[0];
    const dispatchOrder = dispatch.mock.invocationCallOrder[0];
    expect(clearOrder).toBeLessThan(dispatchOrder);
  });

  test('returns SSE stream with token and done events', async () => {
    jest.spyOn(earStoreModule.earStore, 'get').mockResolvedValue(TEST_EAR);
    jest.spyOn(earStoreModule.earStore, 'clear').mockResolvedValue(undefined);
    jest.spyOn(agentDispatch, 'dispatchLeadAgent').mockImplementation(async ({ onToken, onEnd }) => {
      onToken('Hello'); onToken(', world'); onEnd();
    });

    const res = await POST(makeRequest({ conversationId: 'conv-001', message: 'Approved' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/event-stream/);

    const raw = await readStream(res);
    expect(raw).toContain(JSON.stringify({ type: 'token', token: 'Hello' }));
    expect(raw).toContain(JSON.stringify({ type: 'token', token: ', world' }));
    expect(raw).toContain(JSON.stringify({ type: 'done' }));
  });

  test('error from dispatchLeadAgent emits SSE error event (GAP-4 fixed)', async () => {
    jest.spyOn(earStoreModule.earStore, 'get').mockResolvedValue(TEST_EAR);
    jest.spyOn(earStoreModule.earStore, 'clear').mockResolvedValue(undefined);
    jest.spyOn(agentDispatch, 'dispatchLeadAgent').mockRejectedValue(new Error('sidecar down'));

    const res = await POST(makeRequest({ conversationId: 'conv-001', message: 'Approved' }));
    const raw = await readStream(res);
    expect(raw).toContain(JSON.stringify({ type: 'error', message: 'sidecar down' }));
  });
});

// ── LLM lane ─────────────────────────────────────────────────────────────────

describe('POST /api/chat — LLM lane', () => {
  test('streams tokens from sidecarRunStream', async () => {
    jest.spyOn(earStoreModule.earStore, 'get').mockResolvedValue(null);
    jest.spyOn(agentDispatch, 'sidecarRunStream').mockImplementation(async (_msgs, { onToken, onEnd }) => {
      onToken('LLM '); onToken('reply'); onEnd();
    });

    const res = await POST(makeRequest({
      conversationId: 'conv-002',
      message: 'What year is it?',
    }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/event-stream/);

    const raw = await readStream(res);
    expect(raw).toContain(JSON.stringify({ type: 'token', token: 'LLM ' }));
    expect(raw).toContain(JSON.stringify({ type: 'token', token: 'reply' }));
    expect(raw).toContain(JSON.stringify({ type: 'done' }));
  });

  test('passes full message history to sidecarRunStream', async () => {
    jest.spyOn(earStoreModule.earStore, 'get').mockResolvedValue(null);
    const runStream = jest.spyOn(agentDispatch, 'sidecarRunStream').mockImplementation(async (_msgs, { onEnd }) => { onEnd(); });

    const history = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
    await POST(makeRequest({
      conversationId: 'conv-002',
      message: 'how are you?',
      messages: history,
    }));

    const calledMessages = (runStream.mock.calls[0] as [Array<{ role: string; content: string }>, unknown])[0];
    expect(calledMessages).toEqual([
      ...history,
      { role: 'user', content: 'how are you?' },
    ]);
  });

  test('SSE format identical to approval lane', async () => {
    jest.spyOn(earStoreModule.earStore, 'get').mockResolvedValue(null);
    jest.spyOn(agentDispatch, 'sidecarRunStream').mockImplementation(async (_msgs, { onToken, onEnd }) => {
      onToken('tok'); onEnd();
    });

    const res = await POST(makeRequest({ conversationId: 'conv-002', message: 'hello' }));
    const raw = await readStream(res);

    // Must use the same event shapes as the approval lane
    expect(raw).toMatch(/^data: \{"type":"token","token":"tok"\}\n\ndata: \{"type":"done"\}\n\n$/);
  });

  test('error from sidecarRunStream emits SSE error event', async () => {
    jest.spyOn(earStoreModule.earStore, 'get').mockResolvedValue(null);
    jest.spyOn(agentDispatch, 'sidecarRunStream').mockImplementation(async (_msgs, { onError }) => { onError(new Error('sidecar unreachable')); });

    const res = await POST(makeRequest({ conversationId: 'conv-002', message: 'hello' }));
    const raw = await readStream(res);
    expect(raw).toContain(JSON.stringify({ type: 'error', message: 'sidecar unreachable' }));
  });
});

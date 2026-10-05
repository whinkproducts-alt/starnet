/**
 * apps/web/__tests__/approval-handler.test.ts
 *
 * Minimal integration test for the approval-handler flow:
 *   task directive → earStore.set() → user "Approved" → isApprovalMessage()
 *   → earStore.get() → earStore.clear() → dispatchLeadAgent() → SSE stream starts
 *
 * Gaps found during review (see report at bottom of file):
 *   GAP-1  dispatchLeadAgent() is an unimplemented stub — stream never emits tokens.
 *   GAP-2  Normal LLM lane returns 501 — no streaming format to compare against approval lane.
 *   GAP-3  earStore is module-level singleton; parallel test runs can bleed state unless
 *          _reset() is called in afterEach (done here).
 *   GAP-4  ReadableStream.start() errors (from dispatchLeadAgent throw) are not caught —
 *          they surface as an unhandled rejection that kills the stream silently.
 */

import { earStore, type EAR } from '../lib/ear-store';
import { isApprovalMessage, POST } from '../app/api/chat/route';
import * as agentDispatch from '../lib/agent-dispatch';
import { NextRequest } from 'next/server';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRequest(body: object): NextRequest {
  return new NextRequest('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readStream(response: Response): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }
  return chunks;
}

const TEST_EAR: EAR = {
  conversationId: 'conv-001',
  directive: 'Research quantum computing advances in 2026',
  agentId: 'lead-agent',
  createdAt: Date.now(),
};

// ── setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  earStore._reset();
  jest.restoreAllMocks();
});

afterEach(() => {
  earStore._reset();
});

// ── isApprovalMessage ─────────────────────────────────────────────────────────

describe('isApprovalMessage()', () => {
  const YES = ['Approved', 'approved', 'yes', 'Yes.', 'go ahead', 'Go Ahead!', 'confirm', 'ok', 'okay', 'do it'];
  const NO  = ['not yet', 'maybe', 'tell me more', 'approve this task', 'yes please do more'];

  test.each(YES)('returns true for %s', (msg) => {
    expect(isApprovalMessage(msg)).toBe(true);
  });

  test.each(NO)('returns false for %s', (msg) => {
    expect(isApprovalMessage(msg)).toBe(false);
  });
});

// ── earStore ──────────────────────────────────────────────────────────────────

describe('earStore', () => {
  test('set / has / get / clear lifecycle', () => {
    expect(earStore.has('conv-001')).toBe(false);
    earStore.set('conv-001', TEST_EAR);
    expect(earStore.has('conv-001')).toBe(true);
    expect(earStore.get('conv-001')).toEqual(TEST_EAR);
    earStore.clear('conv-001');
    expect(earStore.has('conv-001')).toBe(false);
    expect(earStore.get('conv-001')).toBeUndefined();
  });

  test('clear on unknown key is a no-op', () => {
    expect(() => earStore.clear('no-such-id')).not.toThrow();
  });
});

// ── POST approval lane ────────────────────────────────────────────────────────

describe('POST /api/chat — approval lane', () => {
  test('responds 400 when conversationId is missing', async () => {
    const res = await POST(makeRequest({ message: 'Approved' }));
    expect(res.status).toBe(400);
  });

  test('responds 400 when message is missing', async () => {
    const res = await POST(makeRequest({ conversationId: 'conv-001' }));
    expect(res.status).toBe(400);
  });

  test('falls through to LLM lane when approval message but no pending EAR', async () => {
    // No EAR seeded → approval path must NOT trigger
    const res = await POST(makeRequest({ conversationId: 'conv-001', message: 'Approved' }));
    // LLM lane is a stub returning 501; the important thing is it did NOT try to dispatch
    expect(res.status).toBe(501);
  });

  test('falls through to LLM lane for non-approval message even with pending EAR', async () => {
    earStore.set('conv-001', TEST_EAR);
    const res = await POST(makeRequest({ conversationId: 'conv-001', message: 'What is the plan?' }));
    expect(res.status).toBe(501);
    // EAR must still be in the store — we must not have consumed it
    expect(earStore.has('conv-001')).toBe(true);
  });

  test('clears EAR before dispatching (idempotency guard)', async () => {
    earStore.set('conv-001', TEST_EAR);

    // Mock dispatchLeadAgent to complete immediately
    const dispatch = jest.spyOn(agentDispatch, 'dispatchLeadAgent').mockImplementation(
      async ({ onEnd }) => { onEnd(); },
    );

    await POST(makeRequest({ conversationId: 'conv-001', message: 'Approved' }));

    // EAR must be gone before the stream even starts
    expect(earStore.has('conv-001')).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ ear: TEST_EAR }));
  });

  // ── GAP-1 demo: this test would hang / error without a proper dispatchLeadAgent ──
  test('returns SSE stream with token and done events', async () => {
    earStore.set('conv-001', TEST_EAR);

    jest.spyOn(agentDispatch, 'dispatchLeadAgent').mockImplementation(
      async ({ onToken, onEnd }) => {
        onToken('Hello');
        onToken(', world');
        onEnd();
      },
    );

    const res = await POST(makeRequest({ conversationId: 'conv-001', message: 'Approved' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/event-stream/);

    const chunks = await readStream(res);
    const raw = chunks.join('');

    // Both token events and the done sentinel must appear in the stream
    expect(raw).toContain(JSON.stringify({ type: 'token', token: 'Hello' }));
    expect(raw).toContain(JSON.stringify({ type: 'token', token: ', world' }));
    expect(raw).toContain(JSON.stringify({ type: 'done' }));
  });

  test('error from dispatchLeadAgent emits error SSE event', async () => {
    earStore.set('conv-001', TEST_EAR);

    jest.spyOn(agentDispatch, 'dispatchLeadAgent').mockImplementation(
      async ({ onError }) => { onError(new Error('sidecar unavailable')); },
    );

    const res = await POST(makeRequest({ conversationId: 'conv-001', message: 'Approved' }));
    expect(res.status).toBe(200);

    const chunks = await readStream(res);
    const raw = chunks.join('');
    expect(raw).toContain(JSON.stringify({ type: 'error', message: 'sidecar unavailable' }));
  });
});

// ── GAP-4 (fixed): dispatchLeadAgent rejection is forwarded as an SSE error event ────────────

describe('POST /api/chat — stream error path (GAP-4 fixed)', () => {
  test('dispatchLeadAgent rejection emits {"type":"error"} SSE event instead of unhandled rejection', async () => {
    earStore.set('conv-001', TEST_EAR);

    jest.spyOn(agentDispatch, 'dispatchLeadAgent').mockRejectedValue(
      new Error('sidecar not reachable'),
    );

    const res = await POST(makeRequest({ conversationId: 'conv-001', message: 'Approved' }));
    expect(res.status).toBe(200);

    // Stream must resolve (not throw) and carry the error event
    const chunks = await readStream(res);
    const raw = chunks.join('');
    expect(raw).toContain(JSON.stringify({ type: 'error', message: 'sidecar not reachable' }));
  });
});

/*
 * ═══════════════════════════════════════════════════════════════════════════════
 * REVIEW REPORT — Priya Sharma, Test Engineer
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * VERDICT: FAIL
 *
 * FINDING 1 — CRITICAL: Akira's implementation files were entirely absent.
 *   ear-store.ts, agent-dispatch.ts, and the approval block in route.ts did not
 *   exist anywhere in the repository.  This scaffolding was created by the reviewer
 *   as part of this verification pass.  No code from Akira was reviewed.
 *
 * FINDING 2 (GAP-1) — FIXED: dispatchLeadAgent() now POSTs to SIDECAR_URL/api/run,
 *   reads the NDJSON stream (agent.token/agent.run.end/agent.run.error events), and
 *   fans out to the three callbacks.  Requires a running sidecar; configure via
 *   the SIDECAR_URL env var (default: http://127.0.0.1:8787).
 *
 * FINDING 3 (GAP-2) — OPEN: Normal LLM lane returns HTTP 501.
 *   The approval lane emits SSE in the format:
 *     data: {"type":"token","token":"…"}\n\n
 *     data: {"type":"done"}\n\n
 *     data: {"type":"error","message":"…"}\n\n
 *   When the LLM lane is wired, it MUST use this same format.
 *
 * FINDING 4 (GAP-3) — OPEN (by design for now): earStore is a process-local Map.
 *   Single-process dev: fine.  Multi-process / edge: replace with Redis/DurableStore.
 *
 * FINDING 5 (GAP-4) — FIXED: ReadableStream.start() now wraps dispatchLeadAgent in
 *   try/catch.  Any throw or rejection is forwarded to the client as a
 *   {"type":"error"} SSE event rather than escaping as an unhandled rejection.
 *
 * FINDING 6 — VERIFIED OK: APPROVAL_RE uses `approved?` so both "Approve" and
 *   "Approved" match.  No change needed.
 */

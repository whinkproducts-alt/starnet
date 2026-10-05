/* apps/web/app/api/chat/route.ts — Next.js App Router POST handler for the chat API.

   Two lanes:
     1. Approval lane  — user reply matches APPROVAL_RE and a pending EAR exists for this
                         conversation → clear the EAR, dispatch the lead agent, stream SSE.
     2. Normal LLM lane (placeholder) — pass-through to the existing LLM path.

   SSE wire format (approval lane):
     data: {"type":"token","token":"<text>"}\n\n
     data: {"type":"done"}\n\n
     data: {"type":"error","message":"<text>"}\n\n   (on error)

   NOTE: the normal LLM lane must emit SSE in the SAME format so the browser client only
   needs one parser.  Verify this when wiring the real LLM path.
*/

import { NextRequest } from 'next/server';
import { earStore } from '../../../lib/ear-store';
import { dispatchLeadAgent } from '../../../lib/agent-dispatch';

/** Matches bare affirmative approval replies; case-insensitive, allows trailing punctuation. */
const APPROVAL_RE = /^\s*(approved?|yes|go\s+ahead|confirm(?:ed)?|ok(?:ay)?|do\s+it)\s*[.!]?\s*$/i;

export function isApprovalMessage(text: string): boolean {
  return APPROVAL_RE.test(text);
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: { conversationId?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { conversationId, message } = body;
  if (!conversationId || typeof conversationId !== 'string') {
    return new Response(JSON.stringify({ error: 'missing conversationId' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!message || typeof message !== 'string') {
    return new Response(JSON.stringify({ error: 'missing message' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Approval lane ──────────────────────────────────────────────────────────
  if (isApprovalMessage(message) && earStore.has(conversationId)) {
    const ear = earStore.get(conversationId)!;
    earStore.clear(conversationId);   // clear BEFORE dispatch — prevents double-dispatch on retry

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        // Wrap dispatchLeadAgent so a thrown or rejected promise is forwarded to the client
        // as a {"type":"error"} SSE event instead of escaping as an unhandled rejection (GAP-4).
        const forward = (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'error', message })}\n\n`),
            );
            controller.close();
          } catch { /* controller already closed */ }
        };
        try {
          await dispatchLeadAgent({
            ear,
            onToken(token: string) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: 'token', token })}\n\n`),
              );
            },
            onEnd() {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`));
              controller.close();
            },
            onError(err: Error) { forward(err); },
          });
        } catch (err) {
          forward(err);
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  // ── Normal LLM lane (stub — replace with real LLM streaming) ──────────────
  // TODO: wire this to the existing LLM handler.  Must emit the SAME SSE format as the
  // approval lane above so the client doesn't need two parsers.
  return new Response(JSON.stringify({ error: 'LLM lane not yet implemented' }), {
    status: 501,
    headers: { 'Content-Type': 'application/json' },
  });
}

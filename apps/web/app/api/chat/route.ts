/* apps/web/app/api/chat/route.ts — Next.js App Router POST handler for the chat API.

   Two lanes share one SSE wire format:
     data: {"type":"token","token":"<text>"}\n\n
     data: {"type":"done"}\n\n
     data: {"type":"error","message":"<text>"}\n\n

   Approval lane: user reply matches APPROVAL_RE AND a pending EAR exists for this
     conversation → clear the EAR, dispatch the lead agent, stream SSE.

   LLM lane: everything else → stream a sidecar run directly over the conversation's
     message history.

   Request body:
     { conversationId: string, message: string, messages?: {role,content}[] }
   `messages` is the full conversation history (excluding the current message).
   If omitted, a single-message context is used.
*/

import { NextRequest } from 'next/server';
import { earStore } from '../../../lib/ear-store';
import { dispatchLeadAgent, sidecarRunStream } from '../../../lib/agent-dispatch';

/** Matches bare affirmative approval replies; case-insensitive, optional trailing punctuation. */
const APPROVAL_RE = /^\s*(approved?|yes|go\s+ahead|confirm(?:ed)?|ok(?:ay)?|do\s+it)\s*[.!]?\s*$/i;

export function isApprovalMessage(text: string): boolean {
  return APPROVAL_RE.test(text);
}

/** Build a ReadableStream that calls the supplied async dispatch fn and forwards SSE events. */
function makeAgentStream(
  dispatch: (callbacks: {
    onToken(t: string): void;
    onEnd(): void;
    onError(e: Error): void;
  }) => Promise<void>,
): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const forward = (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message })}\n\n`));
          controller.close();
        } catch { /* already closed */ }
      };
      try {
        await dispatch({
          onToken(token) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'token', token })}\n\n`));
          },
          onEnd() {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`));
            controller.close();
          },
          onError(err) { forward(err); },
        });
      } catch (err) {
        forward(err);
      }
    },
  });
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

export async function POST(req: NextRequest): Promise<Response> {
  let body: { conversationId?: string; message?: string; messages?: Array<{ role: string; content: string }> };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const { conversationId, message, messages = [] } = body;
  if (!conversationId || typeof conversationId !== 'string') {
    return new Response(JSON.stringify({ error: 'missing conversationId' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!message || typeof message !== 'string') {
    return new Response(JSON.stringify({ error: 'missing message' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Approval lane ──────────────────────────────────────────────────────────
  if (isApprovalMessage(message)) {
    const ear = await earStore.get(conversationId);
    if (ear) {
      await earStore.clear(conversationId);  // clear BEFORE dispatch — prevents double-dispatch on retry
      const stream = makeAgentStream((cbs) => dispatchLeadAgent({ ear, ...cbs }));
      return new Response(stream, { status: 200, headers: SSE_HEADERS });
    }
  }

  // ── LLM lane ───────────────────────────────────────────────────────────────
  const history = [...messages, { role: 'user', content: message }];
  const stream = makeAgentStream((cbs) => sidecarRunStream(history, cbs));
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

/* apps/web/lib/agent-dispatch.ts — sidecar /api/run bridge with NDJSON→SSE translation.

   Two exports:
     dispatchLeadAgent(options)  — approval lane: run a pre-approved EAR directive
     sidecarRunStream(messages, agentId?) — LLM lane: run arbitrary conversation messages

   Both translate the sidecar's NDJSON stream into the shared SSE wire format:
     data: {"type":"token","token":"…"}\n\n
     data: {"type":"done"}\n\n
     data: {"type":"error","message":"…"}\n\n

   Sidecar NDJSON input format (one JSON object per line):
     {"name":"agent.token","payload":{"delta":"<text>"}}\n
     {"name":"agent.run.end","payload":{…}}\n
     {"name":"agent.run.error","payload":{"message":"<text>"}}\n
     \n  (keepalive blank lines — skipped)
*/

import type { EAR } from './ear-store';

const SIDECAR_URL = process.env.SIDECAR_URL ?? 'http://127.0.0.1:8787';

export interface DispatchCallbacks {
  onToken(token: string): void;
  onEnd(): void;
  onError(err: Error): void;
}

export interface DispatchOptions extends DispatchCallbacks {
  ear: EAR;
}

/** POST to /api/run and fan NDJSON events out to the three callbacks. */
async function runSidecar(
  messages: Array<{ role: string; content: string }>,
  agentId: string,
  callbacks: DispatchCallbacks,
): Promise<void> {
  const { onToken, onEnd, onError } = callbacks;

  let response: Response;
  try {
    response = await fetch(`${SIDECAR_URL}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, isTask: true, messages }),
    });
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  if (!response.ok) {
    onError(new Error(`sidecar returned ${response.status}`));
    return;
  }
  if (!response.body) {
    onError(new Error('sidecar response has no body'));
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let leftover = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = leftover + decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      leftover = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;  // keepalive blank line
        let event: { name: string; payload?: Record<string, unknown> };
        try { event = JSON.parse(trimmed) as typeof event; } catch { continue; }

        if (event.name === 'agent.token') {
          const delta = String(event.payload?.delta ?? '');
          if (delta) onToken(delta);
        } else if (event.name === 'agent.run.end') {
          onEnd();
          return;
        } else if (event.name === 'agent.run.error') {
          onError(new Error(String(event.payload?.message ?? 'sidecar run error')));
          return;
        }
      }
    }
    onEnd();  // stream closed without explicit agent.run.end
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
  } finally {
    try { reader.cancel(); } catch { /* ignore */ }
  }
}

/** Approval lane: dispatch the lead agent for a pre-approved EAR. */
export async function dispatchLeadAgent(options: DispatchOptions): Promise<void> {
  const { ear, ...callbacks } = options;
  await runSidecar(
    [{ role: 'user', content: ear.directive }],
    ear.agentId,
    callbacks,
  );
}

/** LLM lane: run arbitrary conversation messages through the sidecar. */
export async function sidecarRunStream(
  messages: Array<{ role: string; content: string }>,
  callbacks: DispatchCallbacks,
  agentId = 'agent',
): Promise<void> {
  await runSidecar(messages, agentId, callbacks);
}

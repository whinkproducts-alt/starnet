/* apps/web/lib/agent-dispatch.ts — bridge from the approval handler to the sidecar lead agent.

   dispatchLeadAgent() POSTs to the sidecar's NDJSON run stream (/api/run) and fans out
   events to the three caller-supplied callbacks, matching the contract hub.js and cron-driver.js
   use:  agent.token delta → onToken  |  agent.run.end → onEnd  |  agent.run.error → onError

   Sidecar wire format (NDJSON, one JSON object per line):
     {"name":"agent.token","payload":{"delta":"<text>", ...}}\n
     {"name":"agent.run.end","payload":{...}}\n
     {"name":"agent.run.error","payload":{"message":"<text>", ...}}\n
     \n   (keepalive blank lines — skipped)
*/

import type { EAR } from './ear-store';

export interface DispatchCallbacks {
  onToken(token: string): void;
  onEnd(): void;
  onError(err: Error): void;
}

export interface DispatchOptions extends DispatchCallbacks {
  ear: EAR;
}

const SIDECAR_URL = process.env.SIDECAR_URL ?? 'http://127.0.0.1:8787';

export async function dispatchLeadAgent(options: DispatchOptions): Promise<void> {
  const { ear, onToken, onEnd, onError } = options;

  let response: Response;
  try {
    response = await fetch(`${SIDECAR_URL}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: ear.agentId,
        isTask: true,
        messages: [{ role: 'user', content: ear.directive }],
      }),
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
        try {
          event = JSON.parse(trimmed) as typeof event;
        } catch {
          continue;  // malformed line — skip
        }
        const name = event.name;
        const payload = event.payload ?? {};

        if (name === 'agent.token') {
          const delta = String(payload.delta ?? '');
          if (delta) onToken(delta);
        } else if (name === 'agent.run.end') {
          onEnd();
          return;
        } else if (name === 'agent.run.error') {
          onError(new Error(String(payload.message ?? 'sidecar run error')));
          return;
        }
      }
    }
    // Stream ended without an explicit agent.run.end — treat as done
    onEnd();
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
  } finally {
    try { reader.cancel(); } catch { /* ignore */ }
  }
}

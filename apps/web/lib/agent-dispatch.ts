/* apps/web/lib/agent-dispatch.ts — bridge from the approval handler to the sidecar lead agent.

   dispatchLeadAgent() wraps the sidecar's runOnce with a streaming adapter so the Next.js
   route can pipe agent.token deltas back to the browser as SSE.

   The three callbacks mirror the token/done/error events the sidecar's channel hub uses
   (hub.js: agent.token deltas, agent.run.end, agent.run.error) so the caller owns the
   framing and we stay decoupled from the wire format.
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

/**
 * Dispatch the lead agent for the approved EAR.  Emits token deltas via onToken, signals
 * completion via onEnd, and routes any hard error to onError.
 *
 * This stub must be replaced with a real sidecar runOnce call before production use.
 */
export async function dispatchLeadAgent(options: DispatchOptions): Promise<void> {
  const { ear, onToken, onEnd, onError } = options;
  void ear;    // consumed by the real implementation
  void onToken;
  void onEnd;
  void onError;
  throw new Error('dispatchLeadAgent: not implemented — wire to sidecar runOnce');
}

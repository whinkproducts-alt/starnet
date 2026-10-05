/* apps/web/lib/ear-store.ts — in-memory Execution Approval Request (EAR) store.

   One EAR per conversation: a task directive waiting for explicit human approval before the
   lead agent is dispatched.  The map lives in process memory (single-process Next.js server);
   a Redis/Durable-Store layer can replace it without changing the interface.

   Lifecycle:
     set(id, ear)  — called after task-brief phase produces a confirmed directive
     get(id)       — called by the approval handler to retrieve the pending EAR
     clear(id)     — called immediately AFTER get(), before dispatch, so a second "Approved"
                     message on the same conversation never double-dispatches
     has(id)       — guard check before attempting get()
*/

export interface EAR {
  conversationId: string;
  directive: string;
  agentId: string;
  createdAt: number;
}

const _store = new Map<string, EAR>();

export const earStore = {
  set(conversationId: string, ear: EAR): void {
    _store.set(conversationId, ear);
  },
  get(conversationId: string): EAR | undefined {
    return _store.get(conversationId);
  },
  clear(conversationId: string): void {
    _store.delete(conversationId);
  },
  has(conversationId: string): boolean {
    return _store.has(conversationId);
  },
  /** Test-only: wipe all entries so tests are isolated. */
  _reset(): void {
    _store.clear();
  },
};

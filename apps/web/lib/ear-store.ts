/* apps/web/lib/ear-store.ts — HTTP-backed EAR (Execution Approval Request) store.

   Delegates to the sidecar's /api/ear endpoint so EAR state is:
     • shared across all Next.js workers / edge replicas
     • durable across sidecar and Next.js restarts (backed by makeDurableJsonStore)
     • isolated from this process's memory

   The sidecar exposes:
     POST   /api/ear        { conversationId, directive, agentId } → { ok: true }
     GET    /api/ear?id=…   → { ear: EAR | null }
     DELETE /api/ear?id=…   → { ok: true }

   All methods are async. conversationId must match /^[A-Za-z0-9_-]{1,128}$/.
*/

export interface EAR {
  conversationId: string;
  directive: string;
  agentId: string;
  createdAt: number;
}

const SIDECAR_URL = process.env.SIDECAR_URL ?? 'http://127.0.0.1:8787';

async function sidecarFetch(method: string, path: string, body?: object): Promise<unknown> {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${SIDECAR_URL}${path}`, init);
  if (!res.ok) throw new Error(`ear-store: sidecar ${method} ${path} returned ${res.status}`);
  return res.json();
}

export const earStore = {
  async set(conversationId: string, ear: Omit<EAR, 'conversationId' | 'createdAt'>): Promise<void> {
    await sidecarFetch('POST', '/api/ear', { conversationId, ...ear });
  },
  async get(conversationId: string): Promise<EAR | null> {
    const data = await sidecarFetch('GET', `/api/ear?id=${encodeURIComponent(conversationId)}`) as { ear: EAR | null };
    return data.ear ?? null;
  },
  async clear(conversationId: string): Promise<void> {
    await sidecarFetch('DELETE', `/api/ear?id=${encodeURIComponent(conversationId)}`);
  },
};

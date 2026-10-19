import { vi } from 'vitest';

type Handler = (init?: RequestInit) => { status?: number; body?: unknown };

/** Routes `fetch` calls by "METHOD path" to canned responses. */
export function mockFetch(routes: Record<string, Handler>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const handler = routes[key];
    if (!handler) throw new Error(`Unexpected request: ${key}`);
    const { status = 200, body } = handler(init);
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

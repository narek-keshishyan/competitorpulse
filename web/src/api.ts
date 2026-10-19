import type {
  ApiError,
  CatalogEntry,
  Competitor,
  PollRequestAccepted,
  Snapshot,
} from '@competitorpulse/shared';

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** From a 429: how long to wait before retrying. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { accept: 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as Partial<ApiError> | null;
    throw new ApiRequestError(
      body?.message ?? `Request failed with status ${response.status}`,
      response.status,
      body?.error,
      body?.retryAfterSeconds ?? (Number(response.headers.get('retry-after')) || undefined),
    );
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

const competitorPath = (id: string) => `/api/competitors/${encodeURIComponent(id)}`;

export const api = {
  listCompetitors: () => request<Competitor[]>('/api/competitors'),

  listCatalog: () => request<CatalogEntry[]>('/api/catalog'),

  addCompetitor: (id: string) =>
    request<Competitor>('/api/competitors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    }),

  removeCompetitor: (id: string) => request<void>(competitorPath(id), { method: 'DELETE' }),

  listSnapshots: (id: string, signal?: AbortSignal) =>
    request<Snapshot[]>(`${competitorPath(id)}/snapshots`, { signal }),

  pollNow: (id: string) =>
    request<PollRequestAccepted>(`${competitorPath(id)}/poll`, { method: 'POST' }),
};

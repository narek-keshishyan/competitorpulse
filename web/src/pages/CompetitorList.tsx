import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { CatalogEntry, Competitor } from '@competitorpulse/shared';
import { api } from '../api';

export function CompetitorList() {
  const [competitors, setCompetitors] = useState<Competitor[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [newId, setNewId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setCompetitors(await api.listCompetitors());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.listCompetitors().then(
      (list) => !cancelled && setCompetitors(list),
      (err: Error) => !cancelled && setError(err.message),
    );
    // Suggestions are a convenience: if the catalog can't be loaded the form still works.
    api.listCatalog().then(
      (entries) => !cancelled && setCatalog(entries),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Derived from the live list, so suggestions update right after tracking or removing.
  const trackedIds = new Set(competitors?.map((c) => c.id));
  const suggestions = catalog.map((entry) => entry.id).filter((id) => !trackedIds.has(id));

  async function track(event: FormEvent) {
    event.preventDefault();
    const id = newId.trim().toLowerCase();
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      await api.addCompetitor(id);
      setNewId('');
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await api.removeCompetitor(id);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section>
      <form className="track-form" onSubmit={track}>
        <input
          aria-label="Competitor id"
          placeholder="competitor id, e.g. acme-crm"
          list="competitor-suggestions"
          autoComplete="off"
          value={newId}
          onChange={(e) => setNewId(e.target.value)}
        />
        <datalist id="competitor-suggestions">
          {suggestions.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        <button type="submit" disabled={busy || newId.trim() === ''}>
          Track
        </button>
      </form>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {competitors === null ? (
        <p className="muted">Loading…</p>
      ) : competitors.length === 0 ? (
        <p className="muted">
          Nothing tracked yet.
          {suggestions.length > 0 &&
            ` Start typing to pick one of ${suggestions.length} available competitors.`}
        </p>
      ) : (
        <ul className="competitor-list">
          {competitors.map((c) => (
            <li key={c.id}>
              <Link to={`/competitors/${encodeURIComponent(c.id)}`}>{c.id}</Link>
              <button type="button" onClick={() => void remove(c.id)} aria-label={`Remove ${c.id}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

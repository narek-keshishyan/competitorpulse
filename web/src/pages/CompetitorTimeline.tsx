import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Snapshot } from '@competitorpulse/shared';
import { api, ApiRequestError } from '../api';
import { SnapshotCard } from '../components/SnapshotCard';

/** New snapshots and summaries arrive in the background, so the timeline refreshes itself. */
export const REFRESH_INTERVAL_MS = 5_000;

export function CompetitorTimeline() {
  const { id = '' } = useParams();
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notTracked, setNotTracked] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      try {
        setSnapshots(await api.listSnapshots(id, controller.signal));
        setError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof ApiRequestError && err.status === 404) {
          setNotTracked(true);
          return;
        }
        setError((err as Error).message);
      }
      timer = setTimeout(() => void load(), REFRESH_INTERVAL_MS);
    };
    void load();

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, refreshKey]);

  async function pollNow() {
    try {
      await api.pollNow(id);
      setTimeout(() => setRefreshKey((k) => k + 1), 1_000);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section>
      <div className="toolbar">
        <Link to="/" className="button">
          ← Back to competitors
        </Link>
        {!notTracked && (
          <button type="button" onClick={() => void pollNow()}>
            Poll now
          </button>
        )}
      </div>
      <h2>{id}</h2>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {notTracked ? (
        <p className="muted">This competitor is not tracked.</p>
      ) : snapshots === null ? (
        <p className="muted">Loading…</p>
      ) : snapshots.length === 0 ? (
        <p className="muted">No snapshots yet. The first poll runs within a few seconds.</p>
      ) : (
        snapshots.map((s) => <SnapshotCard key={s.id} snapshot={s} />)
      )}
    </section>
  );
}

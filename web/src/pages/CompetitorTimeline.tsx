import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Snapshot } from '@competitorpulse/shared';
import { api, ApiRequestError } from '../api';
import { SnapshotCard } from '../components/SnapshotCard';

/** New snapshots and summaries arrive in the background, so the timeline refreshes itself. */
export const REFRESH_INTERVAL_MS = 5_000;

export function CompetitorTimeline() {
  const { id = '' } = useParams();
  // Keyed by id so switching competitors starts from a clean state instead of briefly
  // showing the previous competitor's snapshots.
  return <Timeline key={id} id={id} />;
}

function Timeline({ id }: { id: string }) {
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notTracked, setNotTracked] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const pollNowTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The server rate limits "Poll now" per competitor; mirror it with a countdown.
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const cooldownSeconds = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  useEffect(() => () => clearTimeout(pollNowTimer.current), []);

  useEffect(() => {
    if (cooldownUntil === 0) return;
    const ticker = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= cooldownUntil) clearInterval(ticker);
    }, 250);
    return () => clearInterval(ticker);
  }, [cooldownUntil]);

  function startCooldown(seconds: number) {
    const start = Date.now();
    setNow(start);
    setCooldownUntil(start + seconds * 1000);
  }

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
      const accepted = await api.pollNow(id);
      setError(null);
      startCooldown(accepted.retryAfterSeconds);
      // Give the poller a moment to fetch, then refresh instead of waiting for the next tick.
      clearTimeout(pollNowTimer.current);
      pollNowTimer.current = setTimeout(() => setRefreshKey((k) => k + 1), 1_000);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 429 && err.retryAfterSeconds) {
        // Polled moments ago (another tab, another person): just wait, it's not an error.
        startCooldown(err.retryAfterSeconds);
        return;
      }
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
          <button type="button" onClick={() => void pollNow()} disabled={cooldownSeconds > 0}>
            {cooldownSeconds > 0 ? `Poll again in ${cooldownSeconds}s` : 'Poll now'}
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

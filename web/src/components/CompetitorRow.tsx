import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Competitor } from '@competitorpulse/shared';
import { formatRelative } from '../time';

interface Props {
  competitor: Competitor;
  now: number;
  onRemove: (id: string) => Promise<void>;
}

function PollStatus({ competitor, now }: { competitor: Competitor; now: number }) {
  if (!competitor.lastPolledAt) {
    return <span className="muted">Waiting for the first check…</span>;
  }
  const nextIsDue = new Date(competitor.nextPollAt).getTime() <= now;
  return (
    <span className="muted">
      Checked {formatRelative(competitor.lastPolledAt, now)} · next check{' '}
      {nextIsDue ? 'due now' : formatRelative(competitor.nextPollAt, now)}
    </span>
  );
}

export function CompetitorRow({ competitor, now, onRemove }: Props) {
  const [confirming, setConfirming] = useState(false);
  const { id } = competitor;

  return (
    <li>
      <div className="competitor-info">
        <Link to={`/competitors/${encodeURIComponent(id)}`}>{id}</Link>
        <div className="competitor-status">
          <PollStatus competitor={competitor} now={now} />
          {competitor.consecutiveFailures > 0 && (
            <span className="badge badge--error" title={competitor.lastError ?? undefined}>
              Fetch failing ({competitor.consecutiveFailures}×): {competitor.lastError}
            </span>
          )}
        </div>
      </div>

      {/* Removing deletes the whole history, so it takes a second, explicit click. */}
      {confirming ? (
        <div className="confirm">
          <span>Remove {id} and its history?</span>
          <button
            type="button"
            className="danger"
            onClick={() => void onRemove(id)}
            aria-label={`Confirm removing ${id}`}
          >
            Remove
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} aria-label={`Remove ${id}`}>
          Remove
        </button>
      )}
    </li>
  );
}

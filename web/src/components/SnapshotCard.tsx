import type { Snapshot } from '@competitorpulse/shared';

function SummaryLine({ snapshot }: { snapshot: Snapshot }) {
  switch (snapshot.summaryStatus) {
    case 'done':
      return <p className="summary">{snapshot.summary}</p>;
    case 'pending':
      return <p className="muted">Changed ({snapshot.changedFields.join(', ')}). Summarizing…</p>;
    case 'failed':
      return (
        <p className="muted">
          Changed ({snapshot.changedFields.join(', ')}). The AI summary could not be generated.
        </p>
      );
    case 'not_needed':
      return <p className="muted">No change since previous snapshot.</p>;
  }
}

export function SnapshotCard({ snapshot }: { snapshot: Snapshot }) {
  return (
    <article className={`snapshot${snapshot.changed ? ' snapshot--changed' : ''}`}>
      <time dateTime={snapshot.fetchedAt} className="muted">
        {new Date(snapshot.fetchedAt).toLocaleString()}
      </time>
      <div>
        <strong>{snapshot.title}</strong> — {snapshot.tagline}
      </div>
      <div>{snapshot.price}</div>
      <div>{snapshot.description}</div>
      <SummaryLine snapshot={snapshot} />
    </article>
  );
}

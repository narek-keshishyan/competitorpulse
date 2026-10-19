import type { ReactNode } from 'react';
import type { ListingField, Snapshot } from '@competitorpulse/shared';

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

/** Highlights a listing field that differs from the previous snapshot. */
function Field({
  snapshot,
  name,
  children,
}: {
  snapshot: Snapshot;
  name: ListingField;
  children: ReactNode;
}) {
  return snapshot.changedFields.includes(name) ? (
    <mark className="changed" title={`${name} changed`}>
      {children}
    </mark>
  ) : (
    <>{children}</>
  );
}

export function SnapshotCard({ snapshot }: { snapshot: Snapshot }) {
  return (
    <article className={`snapshot${snapshot.changed ? ' snapshot--changed' : ''}`}>
      <time dateTime={snapshot.fetchedAt} className="muted">
        {new Date(snapshot.fetchedAt).toLocaleString()}
      </time>
      <div>
        <Field snapshot={snapshot} name="title">
          <strong>{snapshot.title}</strong>
        </Field>{' '}
        —{' '}
        <Field snapshot={snapshot} name="tagline">
          {snapshot.tagline}
        </Field>
      </div>
      <div>
        <Field snapshot={snapshot} name="price">
          {snapshot.price}
        </Field>
      </div>
      <div>
        <Field snapshot={snapshot} name="description">
          {snapshot.description}
        </Field>
      </div>
      <SummaryLine snapshot={snapshot} />
    </article>
  );
}

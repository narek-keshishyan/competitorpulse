import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Snapshot, TimelineEntry } from '@competitorpulse/shared';
import { CompetitorTimeline } from '../src/pages/CompetitorTimeline';
import { mockFetch } from './fetch-mock';

const base: Snapshot = {
  id: 1,
  fetchedAt: '2026-09-10T12:00:00Z',
  title: 'Acme CRM',
  tagline: 'Simple CRM for small teams',
  price: '$39/mo',
  description: 'Track leads and deals in one place.',
  changed: false,
  changedFields: [],
  summary: null,
  summaryStatus: 'not_needed',
};

const entry = (snapshot: Snapshot, unchangedChecks = 0): TimelineEntry => ({
  snapshot,
  unchangedChecks,
  lastCheckedAt: snapshot.fetchedAt,
});

const renderTimeline = () =>
  render(
    <MemoryRouter initialEntries={['/competitors/acme-crm']}>
      <Routes>
        <Route path="/competitors/:id" element={<CompetitorTimeline />} />
      </Routes>
    </MemoryRouter>,
  );

describe('CompetitorTimeline', () => {
  it('renders snapshots in the order the API returns them, with every state', async () => {
    mockFetch({
      'GET /api/competitors/acme-crm/timeline': () => ({
        body: (
          [
            {
              ...base,
              id: 4,
              changed: true,
              changedFields: ['description'],
              summaryStatus: 'failed',
            },
            { ...base, id: 3, changed: true, changedFields: ['tagline'], summaryStatus: 'pending' },
            {
              ...base,
              id: 2,
              price: '$29/mo',
              changed: true,
              changedFields: ['price'],
              summary: 'Price dropped from $39/mo to $29/mo.',
              summaryStatus: 'done',
            },
            base,
          ] satisfies Snapshot[]
        ).map((s) => entry(s)),
      }),
    });

    renderTimeline();

    const cards = await screen.findAllByRole('article');
    expect(cards).toHaveLength(4);
    expect(cards[0]).toHaveTextContent('The AI summary could not be generated');
    expect(cards[1]).toHaveTextContent('Summarizing');
    expect(cards[2]).toHaveTextContent('Price dropped from $39/mo to $29/mo.');
    expect(cards[3]).toHaveTextContent('No change since previous snapshot.');
    expect(cards[3]).toHaveTextContent('Acme CRM — Simple CRM for small teams');
  });

  it('collapses unchanged checks into one line under the change they followed', async () => {
    mockFetch({
      'GET /api/competitors/acme-crm/timeline': () => ({
        body: [
          {
            snapshot: {
              ...base,
              id: 2,
              changed: true,
              changedFields: ['price'],
              summaryStatus: 'done',
              summary: 'Price rose.',
            },
            unchangedChecks: 143,
            lastCheckedAt: '2026-09-10T14:28:00Z',
          },
          entry(base),
        ],
      }),
    });

    renderTimeline();

    expect(await screen.findAllByRole('article')).toHaveLength(2);
    expect(screen.getByText(/No change in 143 checks/)).toBeInTheDocument();
    expect(screen.getAllByText(/No change in \d+ checks/)).toHaveLength(1);
  });

  it('highlights the fields that changed since the previous snapshot', async () => {
    mockFetch({
      'GET /api/competitors/acme-crm/timeline': () => ({
        body: (
          [
            {
              ...base,
              id: 2,
              price: '$29/mo',
              changed: true,
              changedFields: ['price'],
              summaryStatus: 'pending',
            },
          ] satisfies Snapshot[]
        ).map((s) => entry(s)),
      }),
    });

    renderTimeline();

    const card = await screen.findByRole('article');
    const highlighted = [...card.querySelectorAll('mark.changed')].map((m) => m.textContent);
    expect(highlighted).toEqual(['$29/mo']);
  });

  it('counts down after Poll now until the server accepts another one', async () => {
    mockFetch({
      'GET /api/competitors/acme-crm/timeline': () => ({ body: [entry(base)] }),
      'POST /api/competitors/acme-crm/poll': () => ({
        status: 202,
        body: { id: 'acme-crm', status: 'queued', retryAfterSeconds: 10 },
      }),
    });
    renderTimeline();

    await userEvent.click(await screen.findByRole('button', { name: 'Poll now' }));

    const button = await screen.findByRole('button', { name: /Poll again in (10|9)s/ });
    expect(button).toBeDisabled();
  });

  it('treats a cooldown answer as a wait, not an error', async () => {
    mockFetch({
      'GET /api/competitors/acme-crm/timeline': () => ({ body: [entry(base)] }),
      'POST /api/competitors/acme-crm/poll': () => ({
        status: 429,
        body: { error: 'too_many_requests', message: 'wait', retryAfterSeconds: 6 },
      }),
    });
    renderTimeline();

    await userEvent.click(await screen.findByRole('button', { name: 'Poll now' }));

    expect(await screen.findByRole('button', { name: /Poll again in [56]s/ })).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('explains when the competitor is not tracked', async () => {
    mockFetch({
      'GET /api/competitors/acme-crm/timeline': () => ({
        status: 404,
        body: { error: 'not_found', message: 'acme-crm is not tracked' },
      }),
    });

    renderTimeline();

    expect(await screen.findByText('This competitor is not tracked.')).toBeInTheDocument();
  });

  it('shows an empty state before the first poll', async () => {
    mockFetch({ 'GET /api/competitors/acme-crm/timeline': () => ({ body: [] }) });

    renderTimeline();

    expect(await screen.findByText(/No snapshots yet/)).toBeInTheDocument();
  });
});

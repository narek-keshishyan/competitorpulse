import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Snapshot } from '@competitorpulse/shared';
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
      'GET /api/competitors/acme-crm/snapshots': () => ({
        body: [
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
        ],
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

  it('explains when the competitor is not tracked', async () => {
    mockFetch({
      'GET /api/competitors/acme-crm/snapshots': () => ({
        status: 404,
        body: { error: 'not_found', message: 'acme-crm is not tracked' },
      }),
    });

    renderTimeline();

    expect(await screen.findByText('This competitor is not tracked.')).toBeInTheDocument();
  });

  it('shows an empty state before the first poll', async () => {
    mockFetch({ 'GET /api/competitors/acme-crm/snapshots': () => ({ body: [] }) });

    renderTimeline();

    expect(await screen.findByText(/No snapshots yet/)).toBeInTheDocument();
  });
});

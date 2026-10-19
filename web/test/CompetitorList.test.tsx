import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CompetitorList } from '../src/pages/CompetitorList';
import type { Competitor } from '@competitorpulse/shared';
import { mockFetch } from './fetch-mock';

const competitor = (id: string, overrides: Partial<Competitor> = {}): Competitor => ({
  id,
  createdAt: '2026-09-10T12:00:00Z',
  lastPolledAt: null,
  nextPollAt: '2026-09-10T12:00:00Z',
  consecutiveFailures: 0,
  lastError: null,
  ...overrides,
});

const renderList = () =>
  render(
    <MemoryRouter>
      <CompetitorList />
    </MemoryRouter>,
  );

describe('CompetitorList', () => {
  it('shows tracked competitors as links to their timeline', async () => {
    mockFetch({
      'GET /api/competitors': () => ({ body: [competitor('acme-crm')] }),
    });

    renderList();

    expect(await screen.findByRole('link', { name: 'acme-crm' })).toHaveAttribute(
      'href',
      '/competitors/acme-crm',
    );
  });

  it('tracks a new competitor and refreshes the list', async () => {
    let tracked: Competitor[] = [];
    const fetchMock = mockFetch({
      'GET /api/competitors': () => ({ body: tracked }),
      'POST /api/competitors': (init) => {
        tracked = [competitor(JSON.parse(String(init?.body)).id)];
        return { status: 201, body: tracked[0] };
      },
    });
    renderList();

    await userEvent.type(screen.getByLabelText('Competitor id'), '  Ferry-Pay ');
    await userEvent.click(screen.getByRole('button', { name: 'Track' }));

    expect(await screen.findByRole('link', { name: 'ferry-pay' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/competitors',
      expect.objectContaining({ body: JSON.stringify({ id: 'ferry-pay' }) }),
    );
    expect(screen.getByLabelText('Competitor id')).toHaveValue('');
  });

  it('suggests competitors that are not tracked yet', async () => {
    let tracked = [competitor('acme-crm')];
    mockFetch({
      'GET /api/competitors': () => ({ body: tracked }),
      'GET /api/catalog': () => ({
        body: [
          { id: 'acme-crm', tracked: true },
          { id: 'ferry-pay', tracked: false },
          { id: 'north-analytics', tracked: false },
        ],
      }),
      'POST /api/competitors': () => {
        tracked = [...tracked, competitor('ferry-pay')];
        return { status: 201, body: tracked[1] };
      },
    });
    const { container } = renderList();
    const suggestions = () =>
      [...container.querySelectorAll('#competitor-suggestions option')].map((o) =>
        o.getAttribute('value'),
      );

    expect(screen.getByLabelText('Competitor id')).toHaveAttribute(
      'list',
      'competitor-suggestions',
    );
    await waitFor(() => expect(suggestions()).toEqual(['ferry-pay', 'north-analytics']));

    await userEvent.type(screen.getByLabelText('Competitor id'), 'ferry-pay');
    await userEvent.click(screen.getByRole('button', { name: 'Track' }));

    await waitFor(() => expect(suggestions()).toEqual(['north-analytics']));
  });

  it('still lets you type an id when the catalog is unavailable', async () => {
    mockFetch({
      'GET /api/competitors': () => ({ body: [] }),
      'GET /api/catalog': () => ({
        status: 503,
        body: { error: 'source_unavailable', message: 'down' },
      }),
    });

    renderList();

    expect(await screen.findByText('Nothing tracked yet.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the server error when tracking fails', async () => {
    mockFetch({
      'GET /api/competitors': () => ({ body: [] }),
      'POST /api/competitors': () => ({
        status: 422,
        body: { error: 'unknown_competitor', message: 'The listing source has no nope' },
      }),
    });
    renderList();

    await userEvent.type(screen.getByLabelText('Competitor id'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Track' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The listing source has no nope');
  });

  it('asks for confirmation before removing a competitor and its history', async () => {
    let tracked = [competitor('acme-crm')];
    const fetchMock = mockFetch({
      'GET /api/competitors': () => ({ body: tracked }),
      'DELETE /api/competitors/acme-crm': () => {
        tracked = [];
        return { status: 204 };
      },
    });
    renderList();

    await userEvent.click(await screen.findByRole('button', { name: 'Remove acme-crm' }));
    expect(screen.getByText('Remove acme-crm and its history?')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/competitors/acme-crm',
      expect.objectContaining({ method: 'DELETE' }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Confirm removing acme-crm' }));

    expect(await screen.findByText('Nothing tracked yet.')).toBeInTheDocument();
  });

  it('keeps the competitor when removal is cancelled', async () => {
    mockFetch({ 'GET /api/competitors': () => ({ body: [competitor('acme-crm')] }) });
    renderList();

    await userEvent.click(await screen.findByRole('button', { name: 'Remove acme-crm' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('link', { name: 'acme-crm' })).toBeInTheDocument();
    expect(screen.queryByText(/and its history\?/)).not.toBeInTheDocument();
  });

  it('shows when each competitor was checked and when it is checked next', async () => {
    const now = Date.now();
    mockFetch({
      'GET /api/competitors': () => ({
        body: [
          competitor('acme-crm', {
            lastPolledAt: new Date(now - 20_000).toISOString(),
            nextPollAt: new Date(now + 40_000).toISOString(),
          }),
          competitor('ferry-pay'),
        ],
      }),
    });

    renderList();

    expect(await screen.findByText(/Checked 2\ds ago · next check in [34]\ds/)).toBeInTheDocument();
    expect(screen.getByText('Waiting for the first check…')).toBeInTheDocument();
  });

  it('flags competitors whose listing cannot be fetched', async () => {
    mockFetch({
      'GET /api/competitors': () => ({
        body: [
          competitor('acme-crm', {
            lastPolledAt: '2026-09-10T12:00:00Z',
            consecutiveFailures: 3,
            lastError: 'Listing source answered 503',
          }),
        ],
      }),
    });

    renderList();

    expect(
      await screen.findByText('Fetch failing (3×): Listing source answered 503'),
    ).toBeInTheDocument();
  });
});

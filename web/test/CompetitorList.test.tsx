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

  const catalogRoute = () => ({
    body: [
      { id: 'acme-crm', tracked: true },
      { id: 'ferry-pay', tracked: false },
      { id: 'north-analytics', tracked: false },
    ],
  });
  const optionNames = () => screen.queryAllByRole('option').map((o) => o.textContent);

  it('suggests matching competitors that are not tracked yet while typing', async () => {
    mockFetch({
      'GET /api/competitors': () => ({ body: [competitor('acme-crm')] }),
      'GET /api/catalog': catalogRoute,
    });
    renderList();
    const input = screen.getByRole('combobox', { name: 'Competitor id' });
    await screen.findByRole('link', { name: 'acme-crm' });

    await userEvent.type(input, 'a');
    expect(optionNames()).toEqual(['ferry-pay', 'north-analytics']);

    await userEvent.type(input, 'nal');
    expect(optionNames()).toEqual(['north-analytics']);

    await userEvent.click(screen.getByRole('option', { name: 'north-analytics' }));
    expect(input).toHaveValue('north-analytics');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('picks a suggestion with the keyboard without submitting the form', async () => {
    const fetchMock = mockFetch({
      'GET /api/competitors': () => ({ body: [] }),
      'GET /api/catalog': catalogRoute,
    });
    renderList();
    const input = screen.getByRole('combobox', { name: 'Competitor id' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/catalog', expect.anything()));

    await userEvent.type(input, 'ferr');
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: 'ferry-pay' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.keyboard('{Enter}');

    expect(input).toHaveValue('ferry-pay');
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/competitors',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('says when nothing matches what was typed', async () => {
    mockFetch({
      'GET /api/competitors': () => ({ body: [] }),
      'GET /api/catalog': catalogRoute,
    });
    renderList();

    await userEvent.type(screen.getByRole('combobox', { name: 'Competitor id' }), 'zzz');

    expect(screen.getByText('No untracked competitor matches “zzz”')).toBeInTheDocument();
    expect(optionNames()).toEqual([]);
  });

  it('stops suggesting a competitor once it is tracked', async () => {
    let tracked = [competitor('acme-crm')];
    mockFetch({
      'GET /api/competitors': () => ({ body: tracked }),
      'GET /api/catalog': catalogRoute,
      'POST /api/competitors': () => {
        tracked = [...tracked, competitor('ferry-pay')];
        return { status: 201, body: tracked[1] };
      },
    });
    renderList();
    const input = screen.getByRole('combobox', { name: 'Competitor id' });
    await screen.findByRole('link', { name: 'acme-crm' });

    await userEvent.type(input, 'ferry-pay');
    await userEvent.click(screen.getByRole('button', { name: 'Track' }));
    await screen.findByRole('link', { name: 'ferry-pay' });
    await userEvent.type(input, 'a');

    expect(optionNames()).toEqual(['north-analytics']);
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
    expect(screen.getByText('Delete with history?')).toBeInTheDocument();
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
    expect(screen.queryByText('Delete with history?')).not.toBeInTheDocument();
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

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CompetitorList } from '../src/pages/CompetitorList';
import { mockFetch } from './fetch-mock';

const renderList = () =>
  render(
    <MemoryRouter>
      <CompetitorList />
    </MemoryRouter>,
  );

describe('CompetitorList', () => {
  it('shows tracked competitors as links to their timeline', async () => {
    mockFetch({
      'GET /api/competitors': () => ({ body: [{ id: 'acme-crm', createdAt: '' }] }),
    });

    renderList();

    expect(await screen.findByRole('link', { name: 'acme-crm' })).toHaveAttribute(
      'href',
      '/competitors/acme-crm',
    );
  });

  it('tracks a new competitor and refreshes the list', async () => {
    let tracked: { id: string; createdAt: string }[] = [];
    const fetchMock = mockFetch({
      'GET /api/competitors': () => ({ body: tracked }),
      'POST /api/competitors': (init) => {
        tracked = [{ id: JSON.parse(String(init?.body)).id, createdAt: '' }];
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

  it('removes a competitor', async () => {
    let tracked = [{ id: 'acme-crm', createdAt: '' }];
    mockFetch({
      'GET /api/competitors': () => ({ body: tracked }),
      'DELETE /api/competitors/acme-crm': () => {
        tracked = [];
        return { status: 204 };
      },
    });
    renderList();

    await userEvent.click(await screen.findByRole('button', { name: 'Remove acme-crm' }));

    expect(await screen.findByText(/Nothing tracked yet/)).toBeInTheDocument();
  });
});

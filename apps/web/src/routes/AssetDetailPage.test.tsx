import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssetDetailPage } from './AssetDetailPage';

afterEach(() => vi.unstubAllGlobals());

function detail(overrides: Record<string, unknown> = {}) {
  return {
    assetId: 'MY_CHAIR',
    name: 'My Chair',
    category: 'chairs',
    source: 'custom',
    author: { discordId: null, username: 'someone', displayName: 'someone', avatarUrl: null },
    tags: ['static'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    files: { sprite: '/api/v1/assets/MY_CHAIR/sprite.png' },
    manifest: [{ id: 'MY_CHAIR' }],
    ...overrides,
  };
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/assets/MY_CHAIR']}>
      <Routes>
        <Route path="assets/:id" element={<AssetDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AssetDetailPage', () => {
  it('renders the asset, its author, and an unconditional "Open in editor" link', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(detail())));
    renderDetail();

    expect(await screen.findByRole('heading', { name: 'My Chair' })).toBeInTheDocument();
    expect(screen.getByText('by someone', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in editor' })).toHaveAttribute('href', '/editor');
    expect(screen.getByText('MY_CHAIR')).toBeInTheDocument();
    expect(screen.getByText('chairs')).toBeInTheDocument();
  });

  it('shows a "Built-in" notice instead of an author link for a builtin asset', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(detail({ source: 'builtin' }))));
    renderDetail();

    expect(await screen.findByText('Built-in — bundled with Pixel Agents', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('by someone', { exact: false })).not.toBeInTheDocument();
  });

  it('shows an error notice for a 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'not_found', message: 'No custom asset "MY_CHAIR".' }, { status: 404 })),
    );
    renderDetail();
    expect(await screen.findByText('No custom asset "MY_CHAIR".')).toBeInTheDocument();
  });
});

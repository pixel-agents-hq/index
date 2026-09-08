import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestUrl } from '../test/fetchStub';
import { AuthorPage } from './AuthorPage';

afterEach(() => vi.unstubAllGlobals());

describe('AuthorPage', () => {
  it('shows the public Discord display identity and only the API-provided public layouts', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes('/api/v1/authors/author-1')) {
        return Response.json({
          schemaVersion: 1,
          author: { discordId: 'author-1', username: 'discord-handle', displayName: 'Guild Nick', avatarUrl: null },
          publicLayoutCount: 1,
        });
      }
      if (url.includes('/api/v1/layouts?')) {
        expect(url).toContain('author=author-1');
        return Response.json({
          schemaVersion: 1,
          total: 1,
          nextCursor: null,
          layouts: [{
            slug: 'public-office',
            title: 'Public Office',
            author: { discordId: 'author-1', username: 'discord-handle', displayName: 'Guild Nick', avatarUrl: null },
            description: '',
            tags: [],
            cols: 4,
            rows: 4,
            visibleCols: 4,
            visibleRows: 4,
            furniture: 0,
            areas: 0,
            pets: 0,
            carpets: 0,
            seats: 3,
            layoutRevision: 1,
            pixelAgentsVersion: null,
            bytes: 10,
            sha256: 'a'.repeat(64),
            createdAt: '2026-08-09T00:00:00.000Z',
            updatedAt: '2026-08-09T00:00:00.000Z',
            files: {
              layout: '/api/v1/layouts/public-office/download',
              preview: '/api/v1/layouts/public-office/preview.png',
              thumbnail: '/api/v1/layouts/public-office/thumbnail.png',
            },
          }],
        });
      }
      if (url.includes('/api/v1/assets?')) {
        expect(url).toContain('author=author-1');
        return Response.json({ schemaVersion: 1, total: 0, assets: [], nextCursor: null });
      }
      return new Response('not found', { status: 404 });
    }));

    render(
      <MemoryRouter initialEntries={['/authors/author-1']}>
        <Routes><Route path="authors/:id" element={<AuthorPage />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Guild Nick' })).toBeInTheDocument();
    expect(screen.getByText('@discord-handle')).toBeInTheDocument();
    expect(screen.getByText('1 public layout')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Public Office' })).toBeInTheDocument();
  });
});

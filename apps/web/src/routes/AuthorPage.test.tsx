import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestUrl } from '../test/fetchStub';
import { AuthorPage } from './AuthorPage';

afterEach(() => vi.unstubAllGlobals());

const AUTHOR = { discordId: 'author-1', username: 'discord-handle', displayName: 'Guild Nick', avatarUrl: null };

function stubApi(author: Record<string, unknown> = AUTHOR) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes('/api/v1/authors/author-1')) {
        return Response.json({
          schemaVersion: 1,
          author,
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
      if (url.includes('/api/v1/soundtracks?')) {
        expect(url).toContain('author=author-1');
        return Response.json({
          schemaVersion: 1,
          total: 1,
          nextCursor: null,
          soundtracks: [{
            id: '00000000-0000-4000-8000-000000000001',
            code: 'TOWN-5-8F3A21C0',
            mood: 'town',
            title: 'Morning standup',
            author: { discordId: 'author-1', username: 'discord-handle', displayName: 'Guild Nick', avatarUrl: null },
            createdAt: '2026-08-09T00:00:00.000Z',
          }],
        });
      }
      return new Response('not found', { status: 404 });
    }));
}

function renderPage() {
  return render(
      <MemoryRouter initialEntries={['/authors/author-1']}>
        <Routes><Route path="authors/:id" element={<AuthorPage />} /></Routes>
      </MemoryRouter>,
    );
}

describe('AuthorPage', () => {
  it('shows the public Discord display identity and only the API-provided public layouts', async () => {
    stubApi();
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Guild Nick' })).toBeInTheDocument();
    expect(screen.getByText('@discord-handle')).toBeInTheDocument();
    expect(screen.getByText('1 public layout')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Public Office' })).toBeInTheDocument();
    // Their soundtracks: the code to copy, and a way to hear them all.
    expect(screen.getByRole('heading', { name: 'Soundtracks' })).toBeInTheDocument();
    expect(screen.getByText('TOWN-5-8F3A21C0')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Listen to it on the soundtracks page' })).toHaveAttribute(
      'href',
      '/soundtracks?author=author-1&authorLabel=Guild+Nick',
    );
  });

  it('shows the avatar the author has (#133 never replaces it)', async () => {
    stubApi({ ...AUTHOR, avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png', avatarSeed: 'px.ASMB' });
    const { container } = renderPage();
    await screen.findByRole('heading', { name: 'Guild Nick' });
    const img = container.querySelector('header img');
    expect(img).toHaveAttribute('src', 'https://cdn.discordapp.com/avatars/1/a.png');
    expect(img?.className).not.toContain('pixelated');
  });

  it("draws an author without a picture from their stored seed code, not their name", async () => {
    stubApi({ ...AUTHOR, avatarSeed: 'px.ASMByrHtCcOa' });
    const { container } = renderPage();
    await screen.findByRole('heading', { name: 'Guild Nick' });
    const src = container.querySelector('header img')?.getAttribute('src') ?? '';
    expect(src).toMatch(/\/api\/v1\/avatars\/px\.ASMByrHtCcOa\.png$/);
    expect(src).not.toContain('discord-handle');
    expect(container.querySelector('header img')?.className).toContain('[image-rendering:pixelated]');
  });

  it('shows no picture for an API older than #133 that sends no seed', async () => {
    stubApi();
    const { container } = renderPage();
    await screen.findByRole('heading', { name: 'Guild Nick' });
    expect(container.querySelector('header img')).toBeNull();
  });
});

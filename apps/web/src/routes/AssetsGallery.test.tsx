import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestUrl } from '../test/fetchStub';
import { AssetsGallery } from './AssetsGallery';

afterEach(() => vi.unstubAllGlobals());

const FURNITURE_CATEGORIES = ['chairs', 'decor', 'desks', 'electronics', 'misc', 'wall'];

function renderGallery(initialEntries: string[] = ['/assets']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AssetsGallery />
    </MemoryRouter>,
  );
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    assetId: 'MY_CHAIR',
    name: 'My Chair',
    category: 'chairs',
    source: 'custom',
    author: { discordId: null, username: 'someone', displayName: 'someone', avatarUrl: null },
    variantCount: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    files: { sprite: '/api/v1/assets/MY_CHAIR/sprite.png' },
    ...overrides,
  };
}

function stubAssetsFetch(handle: (url: string) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes('furniture-categories.json')) return Response.json(FURNITURE_CATEGORIES);
      // Every rendered AssetCard fires its own AssetPreview request for
      // animation frames — stubbed to "no poses" so cards fall back to their
      // static sprite, and kept out of `handle()` so it never shadows the
      // list request a test is actually asserting against.
      if (url.includes('/frames')) return Response.json({ schemaVersion: 1, poses: [] });
      return handle(url);
    }),
  );
}

describe('AssetsGallery', () => {
  it('shows a loading state, then the asset list', async () => {
    stubAssetsFetch(() =>
      Response.json({ schemaVersion: 1, total: 1, assets: [summary()], nextCursor: null }),
    );
    renderGallery();
    expect(screen.getByText('Loading assets…')).toBeInTheDocument();
    expect(await screen.findByText('My Chair')).toBeInTheDocument();
    expect(screen.getByText('by someone')).toBeInTheDocument();
    expect(screen.getByText('chairs · 1 variant')).toBeInTheDocument();
  });

  it('shows an empty state with no filters active', async () => {
    stubAssetsFetch(() => Response.json({ schemaVersion: 1, total: 0, assets: [], nextCursor: null }));
    renderGallery();
    expect(await screen.findByText('No custom assets published yet.')).toBeInTheDocument();
  });

  it('shows a filter-aware empty state when a category excludes everything', async () => {
    stubAssetsFetch(() => Response.json({ schemaVersion: 1, total: 0, assets: [], nextCursor: null }));
    renderGallery(['/assets?category=wall']);
    expect(await screen.findByText('No assets match the current filters.')).toBeInTheDocument();
  });

  it('re-fetches from scratch when the category filter changes', async () => {
    let lastUrl = '';
    stubAssetsFetch((url) => {
      lastUrl = url;
      const wantsDecor = url.includes('category=decor');
      return Response.json({
        schemaVersion: 1,
        total: 1,
        assets: [summary(wantsDecor ? { assetId: 'MY_LAMP', name: 'My Lamp', category: 'decor' } : {})],
        nextCursor: null,
      });
    });
    renderGallery();
    await screen.findByText('My Chair');
    // The <select>'s options populate asynchronously (furniture-categories.json) —
    // wait for the real option to exist before selecting it, or jsdom leaves
    // the select's value unchanged (no matching <option> yet).
    await waitFor(() => expect(screen.getByRole('option', { name: 'decor' })).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'decor' } });

    expect(await screen.findByText('My Lamp')).toBeInTheDocument();
    expect(screen.queryByText('My Chair')).not.toBeInTheDocument();
    expect(lastUrl).toContain('category=decor');
  });

  it('shows a "Built-in" badge on a builtin asset and none on a community one', async () => {
    stubAssetsFetch(() =>
      Response.json({
        schemaVersion: 1,
        total: 2,
        assets: [
          summary({ assetId: 'BUILTIN_CHAIR', name: 'Builtin Chair', source: 'builtin' }),
          summary({ assetId: 'MY_CHAIR', name: 'My Chair', source: 'custom' }),
        ],
        nextCursor: null,
      }),
    );
    renderGallery();

    await screen.findByText('Builtin Chair');
    // Scoped to a <span>, not the filter bar's own "Built-in" <option> text.
    expect(screen.getByText('Built-in', { selector: 'span' })).toBeInTheDocument();
    expect(screen.queryAllByText('Built-in', { selector: 'span' })).toHaveLength(1);
  });

  it('re-fetches from scratch when the source filter changes', async () => {
    let lastUrl = '';
    stubAssetsFetch((url) => {
      lastUrl = url;
      const wantsBuiltin = url.includes('source=builtin');
      return Response.json({
        schemaVersion: 1,
        total: 1,
        assets: [
          summary(
            wantsBuiltin
              ? { assetId: 'BUILTIN_CHAIR', name: 'Builtin Chair', source: 'builtin' }
              : {},
          ),
        ],
        nextCursor: null,
      });
    });
    renderGallery();
    await screen.findByText('My Chair');

    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'builtin' } });

    expect(await screen.findByText('Builtin Chair')).toBeInTheDocument();
    expect(screen.queryByText('My Chair')).not.toBeInTheDocument();
    expect(lastUrl).toContain('source=builtin');
  });

  it('re-fetches from scratch when the kind filter changes', async () => {
    let lastUrl = '';
    stubAssetsFetch((url) => {
      lastUrl = url;
      const wantsPets = url.includes('assetKind=pet');
      return Response.json({
        schemaVersion: 1,
        total: 1,
        assets: [
          summary(
            wantsPets
              ? { assetId: 'MY_PET', name: 'My Pet', category: null, assetKind: 'pet' }
              : {},
          ),
        ],
        nextCursor: null,
      });
    });
    renderGallery();
    await screen.findByText('My Chair');

    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'pet' } });

    expect(await screen.findByText('My Pet')).toBeInTheDocument();
    expect(screen.queryByText('My Chair')).not.toBeInTheDocument();
    expect(lastUrl).toContain('assetKind=pet');
  });

  it('loads the next page via "Load more" and appends', async () => {
    stubAssetsFetch((url) => {
      if (url.includes('cursor=page2')) {
        return Response.json({
          schemaVersion: 1,
          total: 2,
          assets: [summary({ assetId: 'SECOND_CHAIR', name: 'Second Chair' })],
          nextCursor: null,
        });
      }
      return Response.json({ schemaVersion: 1, total: 2, assets: [summary()], nextCursor: 'page2' });
    });
    renderGallery();

    await screen.findByText('My Chair');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Second Chair')).toBeInTheDocument();
    expect(screen.getByText('My Chair')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('links to the upload page', async () => {
    stubAssetsFetch(() => Response.json({ schemaVersion: 1, total: 0, assets: [], nextCursor: null }));
    renderGallery();
    expect(await screen.findByRole('link', { name: 'Upload an asset' })).toHaveAttribute(
      'href',
      '/assets/submit',
    );
  });
});

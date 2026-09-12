import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ASSET_FILTERS } from '../routes/assetFilters';
import { requestUrl } from '../test/fetchStub';
import { AssetFilterBar } from './AssetFilterBar';

afterEach(() => vi.unstubAllGlobals());

const FURNITURE_CATEGORIES = ['chairs', 'decor'];

// `useFurnitureCategories()` memoizes its fetch at module scope
// (`furnitureCategories.ts`), so this only needs stubbing once for every
// test in this file to see the same options.
vi.stubGlobal(
  'fetch',
  vi.fn(async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.includes('furniture-categories.json')) return Response.json(FURNITURE_CATEGORIES);
    return new Response('not found', { status: 404 });
  }),
);

async function waitForCategoriesLoaded() {
  await waitFor(() => expect(screen.getByRole('option', { name: 'chairs' })).toBeInTheDocument());
}

describe('AssetFilterBar', () => {
  it('auto-switches Kind to furniture when picking a Category', async () => {
    const onChange = vi.fn();
    render(<AssetFilterBar filters={DEFAULT_ASSET_FILTERS} onChange={onChange} />);
    await waitForCategoriesLoaded();

    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'chairs' } });

    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_ASSET_FILTERS,
      category: 'chairs',
      assetKind: 'furniture',
    });
  });

  it('auto-switches Kind to furniture when selecting an Orientation tag', async () => {
    const onChange = vi.fn();
    render(<AssetFilterBar filters={DEFAULT_ASSET_FILTERS} onChange={onChange} />);
    await waitForCategoriesLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'front' }));

    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_ASSET_FILTERS,
      orientation: ['front'],
      assetKind: 'furniture',
    });
  });

  it('does not force Kind back when deselecting an already-active Orientation tag', async () => {
    const onChange = vi.fn();
    const filters = { ...DEFAULT_ASSET_FILTERS, assetKind: 'furniture' as const, orientation: ['front'] };
    render(<AssetFilterBar filters={filters} onChange={onChange} />);
    await waitForCategoriesLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'front' }));

    expect(onChange).toHaveBeenCalledWith({ ...filters, orientation: [], assetKind: 'furniture' });
  });

  it('clears Category, Orientation and Interactable when Kind switches to pet', async () => {
    const onChange = vi.fn();
    const filters = {
      ...DEFAULT_ASSET_FILTERS,
      assetKind: 'furniture' as const,
      category: 'chairs',
      orientation: ['front'],
      interactable: true,
    };
    render(<AssetFilterBar filters={filters} onChange={onChange} />);
    await waitForCategoriesLoaded();

    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'pet' } });

    expect(onChange).toHaveBeenCalledWith({
      ...filters,
      assetKind: 'pet',
      category: null,
      orientation: [],
      interactable: null,
    });
  });

  it('clears Category, Orientation and Interactable when Kind switches to character', async () => {
    const onChange = vi.fn();
    const filters = {
      ...DEFAULT_ASSET_FILTERS,
      assetKind: 'furniture' as const,
      category: 'chairs',
      orientation: ['front'],
      interactable: false,
    };
    render(<AssetFilterBar filters={filters} onChange={onChange} />);
    await waitForCategoriesLoaded();

    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'character' } });

    expect(onChange).toHaveBeenCalledWith({
      ...filters,
      assetKind: 'character',
      category: null,
      orientation: [],
      interactable: null,
    });
  });

  it.each(['pet', 'character'] as const)(
    'hides Category, Orientation and Interactable when Kind is %s, but keeps Animation',
    (assetKind) => {
      const filters = { ...DEFAULT_ASSET_FILTERS, assetKind };
      render(<AssetFilterBar filters={filters} onChange={vi.fn()} />);

      expect(screen.queryByLabelText('Category')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Interactable')).not.toBeInTheDocument();
      expect(screen.queryByText('Orientation')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'front' })).not.toBeInTheDocument();

      expect(screen.getByText('Animation')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'static' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'animated' })).toBeInTheDocument();
    },
  );

  it('shows Category, Orientation and Interactable again for furniture and Any', () => {
    for (const assetKind of ['furniture', null] as const) {
      const filters = { ...DEFAULT_ASSET_FILTERS, assetKind };
      const { unmount } = render(<AssetFilterBar filters={filters} onChange={vi.fn()} />);

      expect(screen.getByLabelText('Category')).toBeInTheDocument();
      expect(screen.getByLabelText('Interactable')).toBeInTheDocument();
      expect(screen.getByText('Orientation')).toBeInTheDocument();

      unmount();
    }
  });

  it('leaves Animation togglable regardless of Kind', () => {
    const onChange = vi.fn();
    const filters = { ...DEFAULT_ASSET_FILTERS, assetKind: 'pet' as const };
    render(<AssetFilterBar filters={filters} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'static' }));

    expect(onChange).toHaveBeenCalledWith({ ...filters, animation: ['static'] });
  });
});

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestUrl } from '../test/fetchStub';
import { AssetPreview } from './AssetPreview';

afterEach(() => vi.unstubAllGlobals());

const FALLBACK_SRC = '/api/v1/assets/MY_CHAIR/sprite.png';

function stubFrames(handle: (url: string) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => handle(requestUrl(input))),
  );
}

function framePng(byte: string): string {
  return `data:image/png;base64,${byte}`;
}

describe('AssetPreview', () => {
  it('shows the fallback image until frames load, then switches to the first pose', async () => {
    stubFrames(() =>
      Response.json({
        schemaVersion: 1,
        poses: [{ key: 'front', label: 'Front', frames: [framePng('a')] }],
      }),
    );
    render(<AssetPreview assetId="MY_CHAIR" fallbackSrc={FALLBACK_SRC} alt="My Chair sprite" />);

    expect(screen.getByAltText('My Chair sprite')).toHaveAttribute('src', FALLBACK_SRC);
    await waitFor(() => expect(screen.getByAltText('My Chair sprite')).toHaveAttribute('src', framePng('a')));
  });

  it('falls back to the static sprite when the asset has no poses', async () => {
    stubFrames(() => Response.json({ schemaVersion: 1, poses: [] }));
    render(<AssetPreview assetId="MY_CHAIR" fallbackSrc={FALLBACK_SRC} alt="My Chair sprite" />);

    // Give the (resolved) request a tick, then confirm nothing ever replaced the fallback.
    await act(async () => Promise.resolve());
    expect(screen.getByAltText('My Chair sprite')).toHaveAttribute('src', FALLBACK_SRC);
  });

  it('falls back to the static sprite when the frames request fails', async () => {
    stubFrames(() => Response.json({ error: 'not_found', message: 'nope' }, { status: 404 }));
    render(<AssetPreview assetId="MY_CHAIR" fallbackSrc={FALLBACK_SRC} alt="My Chair sprite" />);

    await act(async () => Promise.resolve());
    expect(screen.getByAltText('My Chair sprite')).toHaveAttribute('src', FALLBACK_SRC);
  });

  it('cycles through a pose’s frames over time', async () => {
    stubFrames(() =>
      Response.json({
        schemaVersion: 1,
        poses: [{ key: 'on', label: 'On', frames: [framePng('1'), framePng('2'), framePng('3')] }],
      }),
    );
    render(<AssetPreview assetId="PC" fallbackSrc={FALLBACK_SRC} alt="PC sprite" />);

    await waitFor(() => expect(screen.getByAltText('PC sprite')).toHaveAttribute('src', framePng('1')));
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    expect(screen.getByAltText('PC sprite')).toHaveAttribute('src', framePng('2'));
  });

  it('hides the variant picker unless asked for one, even with multiple poses', async () => {
    stubFrames(() =>
      Response.json({
        schemaVersion: 1,
        poses: [
          { key: 'down', label: 'Down', frames: [framePng('d')] },
          { key: 'up', label: 'Up', frames: [framePng('u')] },
        ],
      }),
    );
    render(<AssetPreview assetId="CHAR_0" fallbackSrc={FALLBACK_SRC} alt="Char 0 sprite" />);

    await waitFor(() => expect(screen.getByAltText('Char 0 sprite')).toHaveAttribute('src', framePng('d')));
    expect(screen.queryByRole('group', { name: 'Variant' })).not.toBeInTheDocument();
  });

  it('lets a visitor switch poses via the variant picker, mirroring a "left" pose', async () => {
    stubFrames(() =>
      Response.json({
        schemaVersion: 1,
        poses: [
          { key: 'right', label: 'Right', frames: [framePng('r')] },
          { key: 'left', label: 'Left', mirror: true, frames: [framePng('r')] },
        ],
      }),
    );
    render(<AssetPreview assetId="CHAR_0" fallbackSrc={FALLBACK_SRC} alt="Char 0 sprite" showVariantPicker />);

    await screen.findByRole('button', { name: 'Left' });
    expect(screen.getByAltText('Char 0 sprite')).not.toHaveStyle({ transform: 'scaleX(-1)' });

    fireEvent.click(screen.getByRole('button', { name: 'Left' }));
    expect(screen.getByAltText('Char 0 sprite')).toHaveStyle({ transform: 'scaleX(-1)' });
    expect(screen.getByRole('button', { name: 'Left' })).toHaveAttribute('aria-pressed', 'true');
  });
});

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestUrl } from '../test/fetchStub';
import { AssetPoseMontage } from './AssetPoseMontage';

afterEach(() => vi.unstubAllGlobals());

const FALLBACK_SRC = '/api/v1/assets/PC/sprite.png';

function stubFrames(handle: (url: string) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => handle(requestUrl(input))),
  );
}

function framePng(byte: string): string {
  return `data:image/png;base64,${byte}`;
}

describe('AssetPoseMontage', () => {
  it('shows the fallback image until frames load', async () => {
    stubFrames(() =>
      Response.json({
        schemaVersion: 1,
        poses: [{ key: 'front', label: 'Front', frames: [framePng('a')] }],
      }),
    );
    render(<AssetPoseMontage assetId="PC" fallbackSrc={FALLBACK_SRC} alt="PC sprite" />);

    expect(screen.getByAltText('PC sprite')).toHaveAttribute('src', FALLBACK_SRC);
    await waitFor(() => expect(screen.queryByAltText('PC sprite')).not.toBeInTheDocument());
  });

  it('falls back to the static sprite when the asset has no poses', async () => {
    stubFrames(() => Response.json({ schemaVersion: 1, poses: [] }));
    render(<AssetPoseMontage assetId="PC" fallbackSrc={FALLBACK_SRC} alt="PC sprite" />);

    await act(async () => Promise.resolve());
    expect(screen.getByAltText('PC sprite')).toHaveAttribute('src', FALLBACK_SRC);
  });

  it('renders every pose at once, not just the first', async () => {
    stubFrames(() =>
      Response.json({
        schemaVersion: 1,
        poses: [
          { key: 'front-on', label: 'Front · On', frames: [framePng('1'), framePng('2')] },
          { key: 'front-off', label: 'Front · Off', frames: [framePng('off')] },
          { key: 'back', label: 'Back', frames: [framePng('back')] },
        ],
      }),
    );
    render(<AssetPoseMontage assetId="PC" fallbackSrc={FALLBACK_SRC} alt="PC sprite" />);

    await screen.findByAltText('PC sprite — Front · On');
    expect(screen.getByAltText('PC sprite — Front · Off')).toHaveAttribute('src', framePng('off'));
    expect(screen.getByAltText('PC sprite — Back')).toHaveAttribute('src', framePng('back'));
  });

  it('animates a multi-frame pose independently of a single-frame pose beside it', async () => {
    stubFrames(() =>
      Response.json({
        schemaVersion: 1,
        poses: [
          { key: 'on', label: 'On', frames: [framePng('1'), framePng('2'), framePng('3')] },
          { key: 'off', label: 'Off', frames: [framePng('off')] },
        ],
      }),
    );
    render(<AssetPoseMontage assetId="PC" fallbackSrc={FALLBACK_SRC} alt="PC sprite" />);

    await waitFor(() => expect(screen.getByAltText('PC sprite — On')).toHaveAttribute('src', framePng('1')));
    expect(screen.getByAltText('PC sprite — Off')).toHaveAttribute('src', framePng('off'));

    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));

    expect(screen.getByAltText('PC sprite — On')).toHaveAttribute('src', framePng('2'));
    // Unaffected by the other pose's clock — still its own single frame.
    expect(screen.getByAltText('PC sprite — Off')).toHaveAttribute('src', framePng('off'));
  });
});

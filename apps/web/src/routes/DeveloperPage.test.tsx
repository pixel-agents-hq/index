import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestUrl } from '../test/fetchStub';
import { DeveloperPage } from './DeveloperPage';

afterEach(() => vi.unstubAllGlobals());

const ROOT_RESPONSE = {
  name: 'Pixel Index API',
  description: 'Third-party integration is encouraged.',
  version: '1',
  commit: 'a'.repeat(40),
  documentation: 'http://localhost:3000/docs',
  openapi: 'http://localhost:3000/openapi.json',
  repository: 'https://github.com/pixel-agents-hq/index',
};

const SPEC_RESPONSE = {
  openapi: '3.1.0',
  info: { title: 'Pixel Index API', version: '1' },
  paths: {
    '/': { get: { responses: { '200': { description: 'Default Response' } } } },
    '/api/v1/meta': { get: { responses: { '200': { description: 'Default Response' } } } },
    '/api/v1/layouts': {
      get: {
        parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }],
        responses: {
          '200': {
            description: 'Default Response',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ListLayoutsResponse' } } },
          },
        },
      },
    },
  },
};

function renderDeveloperPage() {
  render(
    <MemoryRouter initialEntries={['/developer']}>
      <Routes>
        <Route path="developer" element={<DeveloperPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DeveloperPage', () => {
  it('is publicly reachable and shows the running commit, a link to the repo, and endpoints grouped from the live spec', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(requestUrl(input)).pathname;
        if (path === '/') return Response.json(ROOT_RESPONSE);
        if (path === '/openapi.json') return Response.json(SPEC_RESPONSE);
        return new Response('not found', { status: 404 });
      }),
    );

    renderDeveloperPage();

    const repoLink = await screen.findByRole('link', { name: /github/i });
    expect(repoLink).toHaveAttribute('href', 'https://github.com/pixel-agents-hq/index');

    // The commit info card links to the exact commit on GitHub, shortened for display.
    const commitLink = await screen.findByRole('link', { name: ROOT_RESPONSE.commit.slice(0, 7) });
    expect(commitLink).toHaveAttribute('href', `https://github.com/pixel-agents-hq/index/commit/${ROOT_RESPONSE.commit}`);

    // Endpoints from the fetched spec, grouped under a plain read of their own path prefixes.
    expect(await screen.findByText('/api/v1/layouts')).toBeInTheDocument();
    expect(screen.getByText('/api/v1/meta')).toBeInTheDocument();
    expect(screen.getByText('Layouts')).toBeInTheDocument();
    expect(screen.getByText('Meta')).toBeInTheDocument();
    expect(screen.getByText('Overview')).toBeInTheDocument();
  });

  it('shows "unknown" rather than a broken link when the build did not pass a commit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(requestUrl(input)).pathname;
        if (path === '/') return Response.json({ ...ROOT_RESPONSE, commit: null });
        if (path === '/openapi.json') return Response.json(SPEC_RESPONSE);
        return new Response('not found', { status: 404 });
      }),
    );

    renderDeveloperPage();

    expect(await screen.findByText('unknown')).toBeInTheDocument();
  });

  it('degrades to an error notice when the spec fails to load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(requestUrl(input)).pathname;
        if (path === '/') return Response.json(ROOT_RESPONSE);
        return new Response('not found', { status: 404 });
      }),
    );

    renderDeveloperPage();

    expect(await screen.findByText("Couldn't load this.")).toBeInTheDocument();
  });
});

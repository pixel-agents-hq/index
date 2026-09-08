import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ApiError } from '../api/client';
import { submitAsset } from '../api/manageClient';
import { useAuth } from '../auth/authState';
import { SubmissionGate } from '../components/SubmissionGate';

const CATEGORIES = ['desks', 'chairs', 'electronics', 'storage', 'decor', 'misc', 'wall'];

/**
 * Upload + server-side validation only (#101) — no pre-publish preview here.
 * A faithful preview (animated for an animated asset, every orientation for
 * a rotation group) needs the real engine's rendering logic, which is #102's
 * job; building a naive one here would need re-doing once that lands.
 */
export function AssetSubmitPage() {
  const { accessToken } = useAuth();
  const navigate = useNavigate();

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState(CATEGORIES[0] as string);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function publish() {
    if (!accessToken || !file || !name) return;
    setPublishing(true);
    setError(null);
    try {
      const result = await submitAsset(file, { name, category }, accessToken);
      void navigate(`/assets/${result.assetId}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, 'Something unexpected went wrong.'));
    } finally {
      setPublishing(false);
    }
  }

  const fieldClass = 'border border-border bg-canvas px-2 py-1.5 text-ink';

  return (
    <div className="max-w-2xl">
      <h1 className="font-display text-2xl text-ink">Upload a custom asset</h1>
      <SubmissionGate what="Custom asset uploads">
        <p className="mt-1 text-sm text-muted">
          A zip containing a <code>manifest.json</code> and its PNG sprite(s) — the same shape
          pixel-agents' own external-asset directories use, and what pixel-art-mcp's{' '}
          <code>pixel_agents</code> export option already produces.
        </p>

        <div className="mt-6 flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm text-muted">
            Asset zip
            <input
              type="file"
              accept="application/zip,.zip"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="text-xs text-muted"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm text-muted">
            Name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={60}
              required
              className={fieldClass}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm text-muted">
            Category
            <select value={category} onChange={(event) => setCategory(event.target.value)} className={fieldClass}>
              {CATEGORIES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => void publish()}
              disabled={!file || !name || publishing}
              className="border-2 border-accent px-4 py-2 text-sm text-accent hover:bg-accent hover:text-accent-solid-ink disabled:opacity-50"
            >
              {publishing ? 'Publishing…' : 'Publish'}
            </button>
          </div>

          {error && (
            <div className="rounded-lg border-2 border-danger bg-danger-soft px-4 py-3 text-danger">
              <p className="font-medium">{error.message}</p>
              {error.issues && (
                <ul className="mt-2 list-disc pl-5 text-sm text-danger">
                  {error.issues.map((issue, i) => (
                    <li key={i}>
                      <code className="text-xs">{issue.path}</code>: {issue.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </SubmissionGate>
    </div>
  );
}

import './radio.css';

import { createRoot } from 'react-dom/client';

import { RadioApp } from './RadioApp';

// Wear the page's color-scheme: a frame whose scheme differs from its
// embedder's is painted opaque, and this one has to float over the page.
const page = window.parent === window ? null : window.parent.document.documentElement;
function syncScheme(): void {
  if (page) document.documentElement.style.colorScheme = getComputedStyle(page).colorScheme;
}
syncScheme();
if (page) new MutationObserver(syncScheme).observe(page, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });

// Duplicated from src/main.tsx on purpose — see the note there.
const root = document.getElementById('root');
if (!root) throw new Error('radio.html is missing its #root element.');

createRoot(root).render(<RadioApp />);

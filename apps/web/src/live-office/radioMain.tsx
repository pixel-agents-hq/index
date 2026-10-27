import './radio.css';

import { createRoot } from 'react-dom/client';

import { RadioApp } from './RadioApp';

// Wear the page's theme (src/theme/ThemeProvider.tsx sets data-theme on its
// <html>): the frame is same-origin, so it can simply watch it.
const page = window.parent === window ? null : window.parent.document.documentElement;
function syncTheme(): void {
  const theme = page?.dataset.theme;
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
syncTheme();
if (page) new MutationObserver(syncTheme).observe(page, { attributes: true, attributeFilter: ['data-theme'] });

// Duplicated from src/main.tsx on purpose — see the note there.
const root = document.getElementById('root');
if (!root) throw new Error('radio.html is missing its #root element.');

createRoot(root).render(<RadioApp />);

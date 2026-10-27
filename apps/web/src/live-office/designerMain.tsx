import './designer.css';

import { createRoot } from 'react-dom/client';

import { DesignerApp } from './DesignerApp';

// Duplicated from src/main.tsx on purpose — see the note there.
const root = document.getElementById('root');
if (!root) throw new Error('character-designer.html is missing its #root element.');

createRoot(root).render(<DesignerApp />);

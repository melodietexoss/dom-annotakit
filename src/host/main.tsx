/**
 * dom-annotakit — host app entry (Vite; index.html at the repo root).
 *
 * D6: also arms the static-mode GH Projects mirror client — a no-op in
 * serve/dev shapes (armProjectClient self-disarms via the mode probe).
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { armProjectClient } from './projectClient';

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(React.createElement(App));
}
void armProjectClient();

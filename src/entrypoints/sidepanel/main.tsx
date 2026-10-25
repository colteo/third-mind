import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../ui/App';
import '../../ui/styles.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('ThirdMind: the #root element is missing from the side panel page.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

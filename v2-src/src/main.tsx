import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { ensureDefaults } from './db';

async function boot(): Promise<void> {
  await ensureDefaults();
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  }
}

boot().catch((error) => {
  document.getElementById('root')!.innerHTML = `<p style="padding:24px">起動できませんでした: ${String(error)}</p>`;
});

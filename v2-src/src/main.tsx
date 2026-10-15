import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { ensureDefaults } from './db';
import { startNativeWork } from './native-work';
import { startOpenLog } from './open-log';

async function boot(): Promise<void> {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

  // WKWebView may take time to restore IndexedDB after an app update. Keep
  // that work from blocking the entire task screen.
  startNativeWork();
  startOpenLog();
  await ensureDefaults();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  }
}

boot().catch((error) => {
  document.getElementById('root')!.innerHTML = `<p style="padding:24px">起動できませんでした: ${String(error)}</p>`;
});

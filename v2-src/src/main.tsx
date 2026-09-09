import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { ensureDefaults } from './db';

async function keepServiceWorkerFresh(): Promise<void> {
  if (!('serviceWorker' in navigator) || location.protocol !== 'https:') return;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
  const registration = await navigator.serviceWorker.register('./sw.js', {
    updateViaCache: 'none',
  });
  await registration.update();
}

async function boot(): Promise<void> {
  await ensureDefaults();
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

  keepServiceWorkerFresh().catch(() => undefined);
}

boot().catch((error) => {
  const root = document.getElementById('root')!;
  root.innerHTML = '<main style="min-height:100vh;padding:24px;display:grid;place-items:center;background:#f8f8f6"><div style="max-width:420px;display:grid;gap:12px;text-align:center"><strong>起動できませんでした</strong><p style="margin:0;color:#666">端末のタスクは消えていません。古い画面キャッシュを更新して開き直します。</p><button id="sasshy-safe-reload" style="min-height:44px">安全に再読込</button></div></main>';
  root.querySelector<HTMLButtonElement>('#sasshy-safe-reload')?.addEventListener('click', async () => {
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith('sasshy-v2-')).map((name) => caches.delete(name)));
    }
    window.location.reload();
  });
  console.error('SASSHY boot error', error);
});

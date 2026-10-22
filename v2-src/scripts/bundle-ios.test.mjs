import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { inlineIOSDocument, iosTarget } from './bundle-ios.mjs';
import { resolve } from 'node:path';
const require = createRequire(new URL('../package.json', import.meta.url));
const { JSDOM, VirtualConsole } = require('jsdom');
const { indexedDB, IDBKeyRange } = require('fake-indexeddb');

test('inlined classic entry mounts after root and preserves replacement tokens', () => {
  const source = '<html><head><script defer src="./entry.js"></script></head><body><div id="root">loading</div></body></html>';
  const html = inlineIOSDocument(source, () => 'document.getElementById("root").textContent = "$& $$";');
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  assert.equal(dom.window.document.getElementById('root').textContent, '$& $$');
  dom.window.close();
});

test('the actual generated iPhone document starts with isolated storage and no network', async () => {
  const html = readFileSync(resolve(iosTarget, 'app.html'), 'utf8');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => { if (e.type !== 'css parsing') errors.push(e.message); });
  const dom = new JSDOM(html, {
    url: 'file:///SASSHYWeb/app.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(w) {
      w.indexedDB = indexedDB; w.IDBKeyRange = IDBKeyRange; w.structuredClone = structuredClone;
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      w.fetch = async () => { throw new Error('Network disabled in bundle smoke test'); };
      w.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
    },
  });
  try {
    for (let i = 0; i < 50 && !dom.window.document.querySelector('button'); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const text = dom.window.document.getElementById('root').textContent;
    assert.match(text, /設定/);
    assert.doesNotMatch(text, /SASSHYを起動しています|起動できませんでした/);
    assert.deepEqual(errors, []);
  } finally { dom.window.close(); }
});

test('bundled font urls still resolve after the stylesheet is inlined', async () => {
  const { rebaseCssUrls } = await import('./bundle-ios.mjs');
  const css = '@font-face{src:url(./zen-700.woff2) format("woff2"),url("a.woff")}.x{background:url(data:image/png;base64,AA)}';
  const out = rebaseCssUrls(css, './assets/index-1.css');
  assert.ok(out.includes('url(./assets/zen-700.woff2)'));
  assert.ok(out.includes('url("./assets/a.woff")'));
  assert.ok(out.includes('url(data:image/png;base64,AA)'));
});

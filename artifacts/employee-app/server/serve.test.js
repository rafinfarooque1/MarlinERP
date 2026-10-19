const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveStaticFilePath, resolveManifestPath, requestOrigin, escapeHtml } = require('./serve');

test('resolves a normal static asset under the static build root', () => {
  const result = resolveStaticFilePath('/assets/app.js');
  assert.equal(result, path.resolve(__dirname, '..', 'static-build', 'assets', 'app.js'));
});

test('rejects literal and encoded path traversal', () => {
  assert.equal(resolveStaticFilePath('/../../server/serve.js'), null);
  assert.equal(resolveStaticFilePath('/%2e%2e/%2e%2e/server/serve.js'), null);
  assert.equal(resolveStaticFilePath('/%2e%2e%2fserver%2fserve.js'), null);
});

test('resolves manifests only for supported Expo platforms', () => {
  assert.equal(
    resolveManifestPath('ios'),
    path.resolve(__dirname, '..', 'static-build', 'ios', 'manifest.json'),
  );
  assert.equal(
    resolveManifestPath('android'),
    path.resolve(__dirname, '..', 'static-build', 'android', 'manifest.json'),
  );
  assert.equal(resolveManifestPath('web'), null);
  assert.equal(resolveManifestPath('../../server'), null);
});

test('rejects malformed escapes and null bytes', () => {
  assert.equal(resolveStaticFilePath('/bad%escape.js'), null);
  assert.equal(resolveStaticFilePath('/%00secret'), null);
});

test('canonicalizes forwarded origins and rejects invalid protocols and host injection', () => {
  assert.equal(
    requestOrigin({ headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'erp.example.test' } }),
    'https://erp.example.test',
  );
  assert.equal(
    requestOrigin({ headers: { 'x-forwarded-proto': 'javascript', 'x-forwarded-host': 'erp.example.test' } }),
    null,
  );
  assert.equal(
    requestOrigin({ headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'erp.test"><script>' } }),
    null,
  );
});

test('escapes app names before placing them in HTML text nodes', () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
});

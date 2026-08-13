const test = require('node:test');
const assert = require('node:assert/strict');

const security = require('../server');

test('requiring server.js does not start the HTTP server', () => {
  assert.equal(typeof security.app, 'function');
  assert.equal(typeof security.start, 'function');
  assert.equal(security.server.listening, false);
});

test('safeAck preserves callbacks and replaces missing callbacks', () => {
  assert.doesNotThrow(() => security.safeAck(undefined)({ error: 'ignored' }));
  let received;
  security.safeAck(value => { received = value; })({ success: true });
  assert.deepEqual(received, { success: true });
});

test('identity and room values reject invalid or oversized input', () => {
  assert.equal(security.normalizeUsername(' Alice_1 '), 'Alice_1');
  assert.equal(security.normalizeUsername('x'.repeat(21)), null);
  assert.equal(security.normalizeDisplayName(' Alice Smith '), 'Alice Smith');
  assert.equal(security.normalizeDisplayName('<img>'), null);
  assert.equal(security.normalizeServerName(' Team Room '), 'Team Room');
  assert.equal(security.normalizeServerName('Room<script>'), null);
  assert.equal(security.normalizeServerCode(' ab12cd '), 'AB12CD');
  assert.equal(security.normalizeServerCode('global'), 'global');
  assert.equal(security.normalizeServerCode('ABC'), null);
});

test('credential and stored-profile validators enforce exact boundaries', () => {
  assert.equal(security.isValidPassword('123456'), true);
  assert.equal(security.isValidPassword('x'.repeat(129)), false);
  assert.equal(security.normalizeColor('#A1b2C3'), '#a1b2c3');
  assert.equal(security.normalizeColor("red';background:url(x)"), null);
  assert.equal(security.normalizeAvatarUrl('https://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(security.normalizeAvatarUrl('javascript:alert(1)'), null);
});

test('attachment, reaction, and object-id validators reject unsafe values', () => {
  assert.equal(security.isValidAttachment('data:image/png;base64,AAAA'), true);
  assert.equal(security.isValidAttachment('data:image/svg+xml;base64,AAAA'), false);
  assert.equal(security.isValidAttachment('javascript:alert(1)'), false);
  assert.equal(security.isValidReaction('👍'), true);
  assert.equal(security.isValidReaction('__proto__😀'), false);
  assert.equal(security.isValidObjectId('507f1f77bcf86cd799439011'), true);
  assert.equal(security.isValidObjectId('not-an-id'), false);
});

test('client ping tokens become ordinary text before mention resolution', () => {
  assert.equal(
    security.neutralizePingTokens('hello {{PING:everyone|everyone}}'),
    'hello {{ PING:everyone|everyone}}'
  );
  assert.equal(
    security.neutralizePingTokens('{{PING:alice|Alice Smith}}'),
    '{{ PING:alice|Alice Smith}}'
  );
});

test('malformed and nested client ping sentinels cannot retain trusted grammar', () => {
  const inputs = [
    '{{PING:alice|A{lice}}}',
    '{{PING:alice|Alice|extra}}',
    '{{PING:alice|{{PING:bob|Bob}}}}',
    '{{ping:alice|Alice',
    '{{PING:alice|Alice}}}'
  ];

  for (const input of inputs) {
    const neutralized = security.neutralizePingTokens(input);
    assert.equal(/\{\{PING:/i.test(neutralized), false, neutralized);
  }
});

test('rate limiter evicts the deterministic oldest key when its bounded storage is full', () => {
  assert.equal(typeof security.createRateLimiter, 'function');
  let now = 0;
  const limiter = security.createRateLimiter({
    maxEntries: 2,
    maxAttempts: 2,
    windowMs: 1_000,
    now: () => now
  });

  assert.equal(limiter.check('oldest'), true);
  assert.equal(limiter.check('newer'), true);
  assert.equal(limiter.check('newest'), true);
  assert.equal(limiter.check('oldest'), true);
  assert.equal(limiter.check('oldest'), true);
  assert.equal(limiter.check('oldest'), false);
  now = 2_000;
  assert.equal(limiter.check('newest'), true);
});

test('transport addresses are canonicalized and bounded independently of forwarded headers', () => {
  assert.equal(typeof security.normalizeTransportAddress, 'function');
  assert.equal(security.normalizeTransportAddress(' ::FFFF:127.0.0.1 '), '127.0.0.1');
  assert.equal(security.normalizeTransportAddress('[::1]'), '::1');
  assert.equal(security.normalizeTransportAddress('x'.repeat(200)).length, 128);
});

test('layered authentication limits exact account pair and network boundaries without extending rejection', () => {
  let now = 100;
  const makeLimiter = () => security.createLayeredAuthLimiter({
    now: () => now,
    salt: 'fixed-auth-test-salt'
  });

  const pairLimiter = makeLimiter();
  const pairResults = Array.from({ length: 6 }, () => pairLimiter.attempt({
    action: 'login', account: 'Alice', address: '203.0.113.1'
  }).allowed);
  assert.deepEqual(pairResults, [true, true, true, true, true, true]);
  now = 200;
  const rejectedResults = Array.from({ length: 6 }, () => pairLimiter.attempt({
    action: 'login', account: 'Alice', address: '203.0.113.1'
  }).allowed);
  assert.deepEqual(rejectedResults, [false, false, false, false, false, false]);
  now = 15 * 60 * 1000 + 100;
  assert.equal(pairLimiter.attempt({
    action: 'login', account: 'alice', address: '203.0.113.1'
  }).allowed, true);

  now = 100;
  const loginAccountLimiter = makeLimiter();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    assert.equal(loginAccountLimiter.attempt({
      action: 'login', account: 'SharedAccount', address: `203.0.113.${attempt + 1}`
    }).allowed, true, `login account attempt ${attempt + 1}`);
  }
  assert.equal(loginAccountLimiter.attempt({
    action: 'login', account: 'sharedaccount', address: '198.51.100.250'
  }).allowed, false);

  const registerAccountLimiter = makeLimiter();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assert.equal(registerAccountLimiter.attempt({
      action: 'register', account: 'SharedAccount', address: `198.51.100.${attempt + 1}`
    }).allowed, true, `registration account attempt ${attempt + 1}`);
  }
  assert.equal(registerAccountLimiter.attempt({
    action: 'register', account: 'sharedaccount', address: '192.0.2.250'
  }).allowed, false);

  const networkLimiter = makeLimiter();
  for (let attempt = 0; attempt < 300; attempt += 1) {
    assert.equal(networkLimiter.attempt({
      action: 'login', account: `account-${attempt}`, address: '192.0.2.25'
    }).allowed, true, `network attempt ${attempt + 1}`);
  }
  assert.equal(networkLimiter.attempt({
    action: 'login', account: 'account-300', address: '192.0.2.25'
  }).allowed, false);
});

test('layered authentication state bounds the union of all key types and evicts oldest deterministically', () => {
  const limiter = security.createLayeredAuthLimiter({
    now: () => 10,
    salt: 'fixed-auth-test-salt',
    maxEntries: 4
  });
  const first = limiter.attempt({ action: 'login', account: 'oldest', address: '203.0.113.10' });
  const second = limiter.attempt({ action: 'login', account: 'newer', address: '203.0.113.10' });

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(limiter.size(), 4);
  assert.equal(limiter.count(first.token.accountKey), 0);
  assert.equal(limiter.count(first.token.pairKey), 1);
  assert.equal(limiter.count(first.token.networkKey), 2);
  assert.equal(limiter.count(second.token.accountKey), 1);
  assert.equal(limiter.count(second.token.pairKey), 1);
  const third = limiter.attempt({ action: 'login', account: 'newest', address: '203.0.113.10' });
  assert.equal(third.allowed, true);
  assert.equal(limiter.size(), 4);
  assert.equal(limiter.count(third.token.networkKey), 3);

  let now = 0;
  const expiryAwareLimiter = security.createLayeredAuthLimiter({
    now: () => now,
    salt: 'expiry-aware-eviction-salt',
    maxEntries: 6
  });
  const expired = expiryAwareLimiter.attempt({
    action: 'login', account: 'expired', address: '192.0.2.1'
  });
  now = 15 * 60 * 1000 - 1;
  expiryAwareLimiter.attempt({
    action: 'login', account: 'live', address: '192.0.2.2'
  });
  now = 15 * 60 * 1000;
  expiryAwareLimiter.attempt({
    action: 'login', account: 'new', address: '192.0.2.2'
  });
  assert.equal(expiryAwareLimiter.size(), 5);
  assert.equal(expiryAwareLimiter.count(expired.token.accountKey), 0);
  assert.equal(expiryAwareLimiter.count(expired.token.pairKey), 0);
  assert.equal(expiryAwareLimiter.count(expired.token.networkKey), 0);
});

test('network buckets are salted bounded and never expose raw addresses', () => {
  const rawAddress = '203.0.113.77';
  const first = security.hashNetworkAddress(rawAddress, 'salt-one');
  const repeated = security.hashNetworkAddress(rawAddress, 'salt-one');
  const differentlySalted = security.hashNetworkAddress(rawAddress, 'salt-two');

  assert.match(first, /^[0-9a-f]{16}$/);
  assert.equal(first, repeated);
  assert.notEqual(first, differentlySalted);
  assert.equal(first.includes(rawAddress), false);

  const limiter = security.createLayeredAuthLimiter({ salt: 'salt-one' });
  const admission = limiter.attempt({ action: 'login', account: 'Alice', address: rawAddress });
  assert.equal(admission.allowed, true);
  assert.equal(Object.isFrozen(admission.token), true);
  assert.deepEqual(Object.keys(admission.token).sort(), [
    'account', 'accountKey', 'action', 'networkBucket', 'networkKey', 'pairKey'
  ]);
  assert.equal(JSON.stringify(admission.token).includes(rawAddress), false);
});

test('room access preserves global and administrator access only', () => {
  assert.equal(security.canAccessRoom({ role: 'user', joinedServers: ['global'] }, 'global'), true);
  assert.equal(security.canAccessRoom({ role: 'user', joinedServers: ['global'] }, 'ABC123'), false);
  assert.equal(security.canAccessRoom({ role: 'user', joinedServers: ['global', 'ABC123'] }, 'ABC123'), true);
  assert.equal(security.canAccessRoom({ role: 'admin', joinedServers: ['global'] }, 'ABC123'), true);
});

test('history and reply snapshots derive bounded stored data', () => {
  const history = Array.from({ length: 20 }, (_, index) => ({ text: String(index) }));
  const bounded = security.appendBoundedHistory(history, { text: 'next' });
  assert.equal(bounded.length, 20);
  assert.equal(bounded[0].text, '1');
  assert.equal(bounded[19].text, 'next');

  const snapshot = security.createReplySnapshot({
    _id: '507f1f77bcf86cd799439011',
    username: 'alice',
    displayName: 'Alice',
    text: 'x'.repeat(150),
    attachment: null
  });
  assert.deepEqual(snapshot, {
    id: '507f1f77bcf86cd799439011',
    displayname: 'Alice',
    text: 'x'.repeat(100)
  });
});

test('origin policy accepts exact deployed and configured origins only', () => {
  assert.equal(typeof security.normalizeConfiguredOrigin, 'function');
  assert.equal(typeof security.createOriginPolicy, 'function');

  const policy = security.createOriginPolicy({
    allowedOriginsValue: 'https://nathanielzhang999.github.io, https://chat.example.com, https://chat.example.com/',
    production: true
  });

  assert.deepEqual(policy.origins, [
    'https://nathanielzhang999.github.io',
    'https://chat.example.com'
  ]);

  for (const origin of ['https://nathanielzhang999.github.io', 'https://chat.example.com']) {
    assert.equal(policy.allows(origin), true, origin);
    const callbackValues = [];
    policy.corsOrigin(origin, (...values) => callbackValues.push(values));
    assert.deepEqual(callbackValues, [[null, true]], origin);
  }

  const rejectedOrigins = [
    'https://nathanielzhang999.github.io.evil.example',
    'https://user@example.com',
    'https://example.com/path',
    'https://*.example.com',
    'file:///tmp/chat.html',
    null,
    'javascript:alert(1)',
    'https://example.com?query=value',
    'https://example.com#fragment',
    'not a URL'
  ];

  for (const origin of rejectedOrigins) {
    assert.equal(policy.allows(origin), false, String(origin));
    const callbackValues = [];
    policy.corsOrigin(origin, (...values) => callbackValues.push(values));
    assert.deepEqual(callbackValues, [[null, false]], String(origin));
  }
});

test('origin policy does not reflect rejected origins to callbacks or logs', () => {
  const policy = security.createOriginPolicy({ production: true });
  const hostileOrigins = [
    'https://nathanielzhang999.github.io.evil.example/REJECTED_ORIGIN_SENTINEL',
    'javascript:REJECTED_ORIGIN_SENTINEL'
  ];
  const logs = [];
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error
  };
  const captureLog = (...values) => logs.push(values);
  console.log = captureLog;
  console.warn = captureLog;
  console.error = captureLog;

  try {
    for (const origin of hostileOrigins) {
      const corsCallbackValues = [];
      policy.corsOrigin(origin, (...values) => corsCallbackValues.push(values));
      assert.deepEqual(corsCallbackValues, [[null, false]], origin);

      const socketCallbackValues = [];
      policy.allowSocketRequest({ headers: { origin } }, (...values) => socketCallbackValues.push(values));
      assert.deepEqual(socketCallbackValues, [[null, false]], origin);
    }
    assert.deepEqual(logs, []);
  } finally {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  }
});

test('origin policy permits loopback only outside production and rejects missing socket origins', () => {
  const productionPolicy = security.createOriginPolicy({ production: true });
  const developmentPolicy = security.createOriginPolicy({ production: false });

  assert.equal(productionPolicy.allows('http://localhost:3000'), false);
  assert.equal(developmentPolicy.allows('http://localhost:3000'), true);
  assert.equal(developmentPolicy.allows('http://127.0.0.1:5173'), true);
  assert.equal(developmentPolicy.allows('https://localhost:3000'), false);
  assert.equal(developmentPolicy.allows('http://localhost.evil.example'), false);
  assert.equal(developmentPolicy.allows(undefined, { allowMissing: true }), true);
  assert.equal(developmentPolicy.allows(undefined), false);

  const expressCallbackValues = [];
  developmentPolicy.corsOrigin(undefined, (...values) => expressCallbackValues.push(values));
  assert.deepEqual(expressCallbackValues, [[null, false]]);

  const socketCallbackValues = [];
  developmentPolicy.allowSocketRequest({ headers: {} }, (...values) => socketCallbackValues.push(values));
  assert.deepEqual(socketCallbackValues, [[null, false]]);
});

test('malformed origin configuration fails before Mongo connection and listen', async () => {
  const policy = security.createOriginPolicy({
    allowedOriginsValue: 'https://chat.example.com,,https://other.example.com',
    production: true
  });
  const events = [];
  const fakeServer = {
    listen() { events.push('listen'); }
  };

  await assert.rejects(
    security.start({
      mongoUri: 'mongodb://database/chat',
      mongooseImpl: { async connect() { events.push('connect'); } },
      seedSystemFn: async () => { events.push('seed'); },
      serverInstance: fakeServer,
      validateSecurityConfigurationFn: policy.assertValid
    }),
    /ALLOWED_ORIGINS/i
  );
  assert.deepEqual(events, []);
});

test('Express and Socket.IO share one origin policy without a wildcard fallback', () => {
  assert.equal(typeof security.configureHttpSecurity, 'function');
  assert.equal(security.io.opts.cors.origin, security.originPolicy.corsOrigin);
  assert.equal(security.io.opts.allowRequest, security.originPolicy.allowSocketRequest);
  assert.notEqual(security.io.opts.cors.origin, '*');

  const configuredMiddleware = [];
  security.configureHttpSecurity({
    appInstance: { use(middleware) { configuredMiddleware.push(middleware); } },
    originPolicy: security.originPolicy,
    production: false
  });
  assert.equal(configuredMiddleware.length, 2);
  assert.equal(security.originPolicy.allows('https://nathanielzhang999.github.io'), true);
  assert.equal(security.originPolicy.allows('https://nathanielzhang999.github.io.evil.example'), false);
});

test('security headers are exact and HSTS is production only', () => {
  const developmentHeaders = {};
  let developmentNextCalls = 0;
  security.createSecurityHeadersMiddleware({ production: false })(
    {},
    { setHeader(name, value) { developmentHeaders[name] = value; } },
    () => { developmentNextCalls += 1; }
  );
  assert.deepEqual(developmentHeaders, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Resource-Policy': 'same-site'
  });
  assert.equal(developmentNextCalls, 1);

  const productionHeaders = {};
  security.createSecurityHeadersMiddleware({ production: true })(
    {},
    { setHeader(name, value) { productionHeaders[name] = value; } },
    () => {}
  );
  assert.equal(productionHeaders['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains');
});

test('start fails before listening when MONGO_URI is missing', async () => {
  const originalListen = security.server.listen;
  let listened = false;
  security.server.listen = (_port, callback) => {
    listened = true;
    callback();
  };
  try {
    await assert.rejects(
      security.start({ mongoUri: '' }),
      /MONGO_URI.*required/i
    );
    assert.equal(listened, false);
  } finally {
    security.server.listen = originalListen;
  }
});

test('start connects and seeds before it begins listening', async () => {
  const events = [];
  const fakeServer = {
    listen(_port, callback) {
      events.push('listen');
      callback();
    }
  };
  const originalListen = security.server.listen;
  security.server.listen = fakeServer.listen.bind(fakeServer);
  try {
    await security.start({
      mongoUri: 'mongodb://database/chat',
      mongooseImpl: { async connect() { events.push('connect'); } },
      seedSystemFn: async () => { events.push('seed'); },
      serverInstance: fakeServer,
      port: 4321,
      logger: { log() {} }
    });
  } finally {
    security.server.listen = originalListen;
  }
  assert.deepEqual(events, ['connect', 'seed', 'listen']);
});

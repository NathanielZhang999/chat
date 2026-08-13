const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const security = require('../server');
const { FakeSocket, FakeIo, deferred } = require('./support/fakes');

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

test('connection admission allows sixty attempts and one hundred shared-network sockets at exact boundaries', () => {
  let now = 0;
  const attempts = security.createConnectionAdmission({
    now: () => now,
    salt: 'connection-attempt-boundary'
  });
  for (let index = 0; index < 60; index += 1) {
    const result = attempts.open({ handshake: { address: '203.0.113.50' } });
    assert.equal(result.allowed, true, `attempt ${index + 1}`);
    attempts.release(result.token);
  }
  const throttled = attempts.open({ handshake: { address: '203.0.113.50' } });
  assert.deepEqual(throttled, { allowed: false, error: 'Connection unavailable.' });
  assert.equal(Object.isFrozen(throttled), true);
  now = 60_000;
  const expired = attempts.open({ handshake: { address: '203.0.113.50' } });
  assert.equal(expired.allowed, true);
  attempts.release(expired.token);

  let concurrentNow = 0;
  const concurrent = security.createConnectionAdmission({
    now: () => concurrentNow,
    salt: 'connection-concurrency-boundary'
  });
  const tokens = [];
  for (let index = 0; index < 100; index += 1) {
    if (index === 60) concurrentNow = 60_000;
    const result = concurrent.open({ handshake: { address: '198.51.100.75' } });
    assert.equal(result.allowed, true, `concurrent socket ${index + 1}`);
    tokens.push(result.token);
  }
  assert.equal(concurrent.concurrent(tokens[0].networkBucket), 100);
  assert.deepEqual(concurrent.open({ handshake: { address: '198.51.100.75' } }), {
    allowed: false,
    error: 'Connection unavailable.'
  });
});

test('connection admission releases counters on every disconnect path and bounds network keys', async () => {
  const admission = security.createConnectionAdmission({
    salt: 'disconnect-release-boundary',
    maxEntries: 2
  });
  const ioInstance = new FakeIo();
  const connectionHandler = security.createConnectionHandler({
    connectionAdmission: admission,
    ioInstance,
    onlineUsersMap: new Map(),
    broadcastOnlineUsersFn: () => {}
  });
  const anonymousSocket = new FakeSocket();
  anonymousSocket.id = 'anonymous-disconnect';
  anonymousSocket.handshake.address = '192.0.2.1';
  const authenticatedSocket = new FakeSocket();
  authenticatedSocket.id = 'authenticated-disconnect';
  authenticatedSocket.handshake.address = '192.0.2.2';
  authenticatedSocket.username = 'Alice';
  authenticatedSocket.joinedServers = [];
  connectionHandler(anonymousSocket);
  connectionHandler(authenticatedSocket);

  const anonymousBucket = security.hashNetworkAddress('192.0.2.1', 'disconnect-release-boundary');
  const authenticatedBucket = security.hashNetworkAddress('192.0.2.2', 'disconnect-release-boundary');
  assert.equal(admission.concurrent(anonymousBucket), 1);
  assert.equal(admission.concurrent(authenticatedBucket), 1);
  await anonymousSocket.trigger('disconnect');
  await authenticatedSocket.trigger('disconnect');
  await authenticatedSocket.trigger('disconnect');
  assert.equal(admission.concurrent(anonymousBucket), 0);
  assert.equal(admission.concurrent(authenticatedBucket), 0);

  for (const address of ['192.0.2.3', '192.0.2.4', '192.0.2.5']) {
    const result = admission.open({ handshake: { address } });
    assert.equal(result.allowed, true, address);
    admission.release(result.token);
  }
  assert.equal(admission.size(), 2);
});

test('socket event policy covers every registered client event exactly once', () => {
  const source = fs.readFileSync(require.resolve('../server'), 'utf8');
  const protectedEvents = [...source.matchAll(/onProtected\('([^']+)'/g)]
    .map(match => match[1]);
  const directEvents = [...source.matchAll(/socket\.on\('([^']+)'/g)]
    .map(match => match[1]);

  assert.equal(new Set(protectedEvents).size, protectedEvents.length);
  assert.deepEqual(
    [...protectedEvents].sort(),
    Object.keys(security.SOCKET_EVENT_POLICIES).sort()
  );
  assert.deepEqual(directEvents, ['disconnect']);
});

test('production protected registration routes every application event through the dispatcher', async () => {
  const socket = new FakeSocket();
  const ioInstance = new FakeIo();
  const dispatched = [];
  security.createConnectionHandler({
    socketEventDispatcher: {
      dispatch(packet) {
        dispatched.push(packet);
        return `admitted:${packet.event}`;
      }
    },
    ioInstance,
    onlineUsersMap: new Map(),
    broadcastOnlineUsersFn: () => {}
  })(socket);

  assert.deepEqual(
    [...socket.handlers.keys()].sort(),
    [...Object.keys(security.SOCKET_EVENT_POLICIES), 'disconnect'].sort()
  );
  for (const event of Object.keys(security.SOCKET_EVENT_POLICIES)) {
    assert.equal(await socket.trigger(event), `admitted:${event}`, event);
  }
  const dispatchCountBeforeDisconnect = dispatched.length;
  await socket.trigger('disconnect');

  assert.equal(dispatchCountBeforeDisconnect, 27);
  assert.equal(dispatched.length, dispatchCountBeforeDisconnect);
  assert.deepEqual(dispatched.map(packet => packet.event), Object.keys(security.SOCKET_EVENT_POLICIES));
  for (const packet of dispatched) {
    assert.equal(packet.socket, socket);
    assert.equal(Array.isArray(packet.args), true);
    assert.equal(typeof packet.handler, 'function');
  }
});

test('event byte budgets accept exact boundaries and reject one byte over', () => {
  const exactUtf8 = 'é'.repeat(4_096);
  assert.equal(security.measurePayloadBytes(exactUtf8, { maxBytes: 8_192 }), 8_192);
  assert.equal(security.measurePayloadBytes(`${exactUtf8}é`, { maxBytes: 8_192 }), 8_193);
  assert.equal(
    security.validateSocketEventEnvelope('create_server', ['x'.repeat(8_192)], security.SOCKET_EVENT_POLICIES).allowed,
    true
  );
  assert.equal(
    security.validateSocketEventEnvelope('create_server', ['x'.repeat(8_193)], security.SOCKET_EVENT_POLICIES).allowed,
    false
  );

  const editEnvelopeFixedBytes = 62; // id 26 + text key 4 + serverCode 16 + clientContextId 16.
  const exactEditEnvelope = {
    id: '507f1f77bcf86cd799439011',
    text: 'x'.repeat(16_384 - editEnvelopeFixedBytes),
    serverCode: 'global',
    clientContextId: 1
  };
  assert.equal(
    security.measurePayloadBytes(exactEditEnvelope, { maxBytes: 16_384 }),
    16_384
  );
  assert.equal(
    security.validateSocketEventEnvelope('edit_message', [exactEditEnvelope], security.SOCKET_EVENT_POLICIES).allowed,
    true
  );
  assert.equal(
    security.validateSocketEventEnvelope('edit_message', [{
      ...exactEditEnvelope,
      text: `${exactEditEnvelope.text}x`
    }], security.SOCKET_EVENT_POLICIES).allowed,
    false
  );

  const chatEnvelopeFixedBytes = 57; // serverCode 16 + clientContextId 16 + text key 4 + attachment key 10 + replyTo 11.
  const exactChatEnvelope = {
    serverCode: 'global',
    clientContextId: 1,
    text: '',
    attachment: 'x'.repeat(8_100_000 - chatEnvelopeFixedBytes),
    replyTo: null
  };
  assert.equal(
    security.measurePayloadBytes(exactChatEnvelope, { maxBytes: 8_100_000 }),
    8_100_000
  );
  assert.equal(
    security.validateSocketEventEnvelope('chat_message', [exactChatEnvelope], security.SOCKET_EVENT_POLICIES).allowed,
    true
  );
  assert.equal(
    security.validateSocketEventEnvelope('chat_message', [{
      ...exactChatEnvelope,
      attachment: `${exactChatEnvelope.attachment}x`
    }], security.SOCKET_EVENT_POLICIES).allowed,
    false
  );
});

test('event category budgets enforce exact independent account boundaries and expiry', () => {
  let now = 0;
  const controller = security.createEventBudgetController({ now: () => now });
  const cases = [
    ['light', 120, 60_000],
    ['heavy_read', 30, 60_000],
    ['sensitive_write', 10, 15 * 60_000],
    ['moderation_read', 30, 60_000]
  ];

  for (const [category, limit] of cases) {
    for (let attempt = 0; attempt < limit; attempt += 1) {
      assert.equal(controller.consume({ account: `Alice-${category}`, category }).allowed, true);
    }
    assert.equal(controller.consume({ account: ` alice-${category} `, category }).allowed, false);
    assert.equal(controller.consume({ account: `Bob-${category}`, category }).allowed, true);
  }
  assert.equal(controller.consume({ account: 'Alice-light', category: 'heavy_read' }).allowed, true);

  now = 59_999;
  assert.equal(controller.consume({ account: 'Alice-light', category: 'light' }).allowed, false);
  now = 60_000;
  for (const [category, , windowMs] of cases.filter(([, , windowMs]) => windowMs === 60_000)) {
    assert.equal(controller.consume({ account: `Alice-${category}`, category }).allowed, true);
  }
  assert.equal(controller.consume({ account: 'Alice-sensitive_write', category: 'sensitive_write' }).allowed, false);
  now = 15 * 60_000;
  assert.equal(controller.consume({ account: 'Alice-sensitive_write', category: 'sensitive_write' }).allowed, true);

  const bounded = security.createEventBudgetController({ maxEntries: 2, now: () => 0 });
  bounded.consume({ account: 'oldest', category: 'light' });
  bounded.consume({ account: 'newer', category: 'heavy_read' });
  bounded.consume({ account: 'newest', category: 'moderation_read' });
  assert.equal(bounded.size(), 2);
});

test('shared network accounts never share authenticated event budgets', async () => {
  const controller = security.createEventBudgetController({
    policies: { heavy_read: { maxAttempts: 1, windowMs: 60_000 } }
  });
  const dispatcher = security.createSocketEventDispatcher({
    eventBudgetController: controller,
    securityLogger: { warn() {} }
  });
  const alice = new FakeSocket({ dispatchPacket: dispatcher.dispatch });
  const bob = new FakeSocket({ dispatchPacket: dispatcher.dispatch });
  alice.id = 'alice-budget';
  bob.id = 'bob-budget';
  alice.username = 'Alice';
  bob.username = 'Bob';
  alice.handshake.address = '203.0.113.44';
  bob.handshake.address = '203.0.113.44';
  let aliceEntries = 0;
  let bobEntries = 0;
  alice.on('get_edit_history', () => { aliceEntries += 1; });
  bob.on('get_edit_history', () => { bobEntries += 1; });
  const rejected = [];

  await alice.trigger('get_edit_history', '507f1f77bcf86cd799439011');
  await alice.trigger('get_edit_history', '507f1f77bcf86cd799439011', value => rejected.push(value));
  await bob.trigger('get_edit_history', '507f1f77bcf86cd799439011');

  assert.equal(aliceEntries, 1);
  assert.equal(bobEntries, 1);
  assert.deepEqual(rejected, [{ error: 'Too many requests. Try again later.' }]);
});

test('a timed-out in-flight token cannot release a newer request token', () => {
  const scheduled = [];
  const cleared = [];
  const coordinator = security.createInFlightRequestCoordinator({
    schedule(callback, milliseconds) {
      const timer = { callback, milliseconds, unrefCalled: false, unref() { this.unrefCalled = true; } };
      scheduled.push(timer);
      return timer;
    },
    clearSchedule(timer) { cleared.push(timer); }
  });

  const expired = coordinator.begin('socket-1', 'switch_server');
  assert.equal(Object.isFrozen(expired), true);
  assert.equal(scheduled[0].milliseconds, 10_000);
  assert.equal(scheduled[0].unrefCalled, true);
  scheduled[0].callback();
  assert.equal(coordinator.size(), 0);

  const current = coordinator.begin('socket-1', 'switch_server');
  assert.notEqual(current, expired);
  scheduled[0].callback();
  coordinator.finish(expired);
  assert.equal(coordinator.size(), 1);
  assert.equal(coordinator.begin('socket-1', 'switch_server'), null);
  coordinator.finish(current);
  assert.equal(coordinator.size(), 0);
  assert.deepEqual(cleared, [scheduled[0], scheduled[1]]);
});

test('query deadlines degrade safely for injected thenables without maxTimeMS', async () => {
  const thenable = Promise.resolve({ ok: true });
  assert.equal(security.applyQueryDeadline(thenable), thenable);
  assert.deepEqual(await security.applyQueryDeadline(thenable), { ok: true });
  assert.equal(security.applyQueryDeadline(null), null);
});

test('security budget and duplicate logs contain categories but no private payloads', async () => {
  const logs = [];
  const securityLogger = { warn(...args) { logs.push(args); } };
  const budgetDispatcher = security.createSocketEventDispatcher({
    eventBudgetController: security.createEventBudgetController({
      policies: { sensitive_write: { maxAttempts: 1, windowMs: 60_000 } }
    }),
    securityLogger
  });
  const budgetSocket = new FakeSocket({ dispatchPacket: budgetDispatcher.dispatch });
  budgetSocket.username = 'PrivateBudgetAccount';
  budgetSocket.handshake.address = '203.0.113.211';
  budgetSocket.on('update_profile', (_payload, callback) => callback({ success: true }));
  const privateProfile = {
    displayName: 'PrivateDisplaySentinel', color: '#123456',
    avatarUrl: 'https://private.example/PrivateAvatarSentinel.png'
  };
  await budgetSocket.trigger('update_profile', privateProfile, () => {});
  await budgetSocket.trigger('update_profile', privateProfile, () => {});

  const coordinator = security.createInFlightRequestCoordinator();
  const duplicateDispatcher = security.createSocketEventDispatcher({
    inFlightCoordinator: coordinator,
    securityLogger
  });
  const duplicateSocket = new FakeSocket({ dispatchPacket: duplicateDispatcher.dispatch });
  duplicateSocket.username = 'PrivateDuplicateAccount';
  duplicateSocket.handshake.address = '198.51.100.212';
  const operationStarted = deferred();
  const releaseOperation = deferred();
  duplicateSocket.on('get_edit_history', async () => {
    operationStarted.resolve();
    await releaseOperation.promise;
  });
  const first = duplicateSocket.trigger('get_edit_history', '507f1f77bcf86cd799439011');
  await operationStarted.promise;
  await duplicateSocket.trigger('get_edit_history', '507f1f77bcf86cd799439011', () => {});
  releaseOperation.resolve();
  await first;

  assert.deepEqual(logs.map(([, metadata]) => metadata.category), [
    'sensitive_write', 'heavy_read'
  ]);
  for (const [, metadata] of logs) {
    assert.deepEqual(Object.keys(metadata).sort(), ['category', 'event']);
  }
  const serialized = JSON.stringify(logs);
  for (const sentinel of [
    'PrivateBudgetAccount', 'PrivateDisplaySentinel', 'PrivateAvatarSentinel',
    'PrivateDuplicateAccount', '203.0.113.211', '198.51.100.212'
  ]) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
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

test('complete invisible-security matrix uses registered handlers and shared production policies', async (t) => {
  await t.test('production and development origins reject hostile and missing socket origins', () => {
    const exactOrigin = 'https://chat.example.com';
    const rows = [
      { environment: 'production', production: true, kind: 'exact', origin: exactOrigin, allowed: true },
      {
        environment: 'production', production: true, kind: 'hostile',
        origin: 'https://chat.example.com.evil.invalid/origin-private-marker', allowed: false
      },
      { environment: 'production', production: true, kind: 'missing', origin: undefined, allowed: false },
      { environment: 'development', production: false, kind: 'exact', origin: exactOrigin, allowed: true },
      {
        environment: 'development', production: false, kind: 'hostile',
        origin: 'https://chat.example.com.evil.invalid/origin-private-marker', allowed: false
      },
      { environment: 'development', production: false, kind: 'missing', origin: undefined, allowed: false }
    ];

    for (const row of rows) {
      const policy = security.createOriginPolicy({
        allowedOriginsValue: exactOrigin,
        production: row.production
      });
      const callbackValues = [];
      const headers = row.origin === undefined ? {} : { origin: row.origin };
      policy.allowSocketRequest({ headers }, (...values) => callbackValues.push(values));
      assert.deepEqual(callbackValues, [[null, row.allowed]], `${row.environment} ${row.kind}`);
    }
  });

  await t.test('all registered event envelopes admit a handler and reject unexpected fields before work', async () => {
    const capturedPackets = new Map();
    let modelCalls = 0;
    let broadcasts = 0;
    const noWorkModel = Object.freeze({
      async findOne() { modelCalls += 1; throw new Error('unexpected matrix model read'); },
      async find() { modelCalls += 1; throw new Error('unexpected matrix model read'); },
      async findById() { modelCalls += 1; throw new Error('unexpected matrix model read'); },
      async create() { modelCalls += 1; throw new Error('unexpected matrix model write'); },
      async updateOne() { modelCalls += 1; throw new Error('unexpected matrix model write'); },
      async findOneAndUpdate() { modelCalls += 1; throw new Error('unexpected matrix model write'); }
    });
    const socket = new FakeSocket();
    socket.handshake.address = '192.0.2.240';
    security.createConnectionHandler({
      socketEventDispatcher: {
        dispatch(packet) {
          capturedPackets.set(packet.event, packet);
        },
        cancelSocket() {}
      },
      ioInstance: new FakeIo(),
      UserModel: noWorkModel,
      ChatServerModel: noWorkModel,
      MessageModel: noWorkModel,
      RoomRestrictionModel: noWorkModel,
      ModerationAuditModel: noWorkModel,
      ModerationReportModel: noWorkModel,
      onlineUsersMap: new Map(),
      broadcastOnlineUsersFn() { broadcasts += 1; },
      logger: { error() {} }
    })(socket);

    const eventNames = Object.keys(security.SOCKET_EVENT_POLICIES);
    for (const event of eventNames) await socket.trigger(event);
    assert.deepEqual([...capturedPackets.keys()], eventNames);

    const securityLogs = [];
    const dispatcher = security.createSocketEventDispatcher({
      securityLogger: { warn(...args) { securityLogs.push(args); } }
    });
    const privateMarker = 'matrix-private-payload-marker';
    let admittedHandlerEntries = 0;
    let rejectedHandlerEntries = 0;
    const rejectionAcks = [];

    for (const event of eventNames) {
      const policy = security.SOCKET_EVENT_POLICIES[event];
      const packet = capturedPackets.get(event);
      const acknowledgement = () => {};
      const validArgs = policy.kind === 'none'
        ? [acknowledgement]
        : [policy.kind === 'object' ? {} : '', acknowledgement];
      await dispatcher.dispatch({
        socket,
        event,
        args: validArgs,
        handler: async (...args) => {
          admittedHandlerEntries += 1;
          return packet.handler(...args);
        }
      });

      const invalidPayload = policy.kind === 'object'
        ? { [privateMarker]: true }
        : (policy.kind === 'none' ? privateMarker : { [privateMarker]: true });
      await dispatcher.dispatch({
        socket,
        event,
        args: [invalidPayload, value => rejectionAcks.push([event, value])],
        handler: () => { rejectedHandlerEntries += 1; }
      });
    }

    assert.equal(admittedHandlerEntries, eventNames.length);
    assert.equal(rejectedHandlerEntries, 0);
    assert.equal(modelCalls, 0);
    assert.equal(broadcasts, 0);
    assert.equal(rejectionAcks.length, eventNames.length);
    for (const [event, value] of rejectionAcks) {
      assert.deepEqual(value, { error: 'Invalid input format.' }, event);
    }
    assert.equal(JSON.stringify({ securityLogs, rejectionAcks }).includes(privateMarker), false);
  });

  await t.test('every payload byte class accepts the exact limit and rejects one byte over', () => {
    const scalarExact = 'x'.repeat(8_192);
    const controlExact = { username: 'u', password: 'x'.repeat(8_175) };
    const lightFixedBytes = 62;
    const lightExact = {
      id: '507f1f77bcf86cd799439011',
      text: 'x'.repeat(16_384 - lightFixedBytes),
      serverCode: 'global',
      clientContextId: 1
    };
    const attachmentFixedBytes = 57;
    const attachmentExact = {
      serverCode: 'global',
      clientContextId: 1,
      text: '',
      attachment: 'x'.repeat(8_100_000 - attachmentFixedBytes),
      replyTo: null
    };
    const rows = [
      {
        label: 'no-data', event: 'logout_all_devices', exactArgs: [], overArgs: ['x']
      },
      {
        label: 'scalar-8192', event: 'create_server', exactArgs: [scalarExact],
        overArgs: [`${scalarExact}x`]
      },
      {
        label: 'object-8192', event: 'login', exactArgs: [controlExact],
        overArgs: [{ ...controlExact, password: `${controlExact.password}x` }]
      },
      {
        label: 'object-16384', event: 'edit_message', exactArgs: [lightExact],
        overArgs: [{ ...lightExact, text: `${lightExact.text}x` }]
      },
      {
        label: 'attachment-8100000', event: 'chat_message', exactArgs: [attachmentExact],
        overArgs: [{ ...attachmentExact, attachment: `${attachmentExact.attachment}x` }]
      }
    ];

    assert.equal(security.measurePayloadBytes(controlExact, { maxBytes: 8_192 }), 8_192);
    assert.equal(security.measurePayloadBytes(lightExact, { maxBytes: 16_384 }), 16_384);
    assert.equal(security.measurePayloadBytes(attachmentExact, { maxBytes: 8_100_000 }), 8_100_000);
    for (const row of rows) {
      assert.equal(
        security.validateSocketEventEnvelope(row.event, row.exactArgs).allowed,
        true,
        `${row.label} exact`
      );
      assert.equal(
        security.validateSocketEventEnvelope(row.event, row.overArgs).allowed,
        false,
        `${row.label} over`
      );
    }
  });

  await t.test('all category budgets keep account identity, exact edges, expiry, and dispatcher order', async () => {
    const categoryRows = [
      { category: 'light', limit: 120, windowMs: 60_000 },
      { category: 'heavy_read', limit: 30, windowMs: 60_000 },
      { category: 'sensitive_write', limit: 10, windowMs: 15 * 60_000 },
      { category: 'moderation_read', limit: 30, windowMs: 60_000 }
    ];
    for (const row of categoryRows) {
      let now = 0;
      const controller = security.createEventBudgetController({ now: () => now });
      for (let attempt = 0; attempt < row.limit; attempt += 1) {
        assert.equal(controller.consume({ account: `Matrix-${row.category}`, category: row.category }).allowed, true);
      }
      assert.equal(controller.consume({ account: ` matrix-${row.category} `, category: row.category }).allowed, false);
      now = row.windowMs - 1;
      assert.equal(controller.consume({ account: `Matrix-${row.category}`, category: row.category }).allowed, false);
      now = row.windowMs;
      assert.equal(controller.consume({ account: `Matrix-${row.category}`, category: row.category }).allowed, true);
    }

    const accountController = security.createEventBudgetController({
      policies: { light: { maxAttempts: 1, windowMs: 60_000 } }
    });
    const accountDispatcher = security.createSocketEventDispatcher({
      eventBudgetController: accountController,
      securityLogger: { warn() {} }
    });
    const alice = new FakeSocket();
    const bob = new FakeSocket();
    alice.username = 'Alice';
    bob.username = 'Bob';
    alice.handshake.address = '198.51.100.77';
    bob.handshake.address = '198.51.100.77';
    let accountHandlerEntries = 0;
    const accountHandler = async () => { accountHandlerEntries += 1; };
    await accountDispatcher.dispatch({ socket: alice, event: 'typing', args: [{}], handler: accountHandler });
    const accountLimitAck = [];
    await accountDispatcher.dispatch({
      socket: alice,
      event: 'typing',
      args: [{}, value => accountLimitAck.push(value)],
      handler: accountHandler
    });
    await accountDispatcher.dispatch({ socket: bob, event: 'typing', args: [{}], handler: accountHandler });
    assert.equal(accountHandlerEntries, 2);
    assert.deepEqual(accountLimitAck, [{ error: 'Too many requests. Try again later.' }]);

    let bypassConsumes = 0;
    const bypassDispatcher = security.createSocketEventDispatcher({
      eventBudgetController: { consume() { bypassConsumes += 1; return { allowed: false }; } },
      securityLogger: { warn() {} }
    });
    const anonymous = new FakeSocket();
    const authenticated = new FakeSocket();
    authenticated.username = 'Alice';
    let bypassEntries = 0;
    await bypassDispatcher.dispatch({
      socket: anonymous, event: 'switch_server', args: ['global'],
      handler: async () => { bypassEntries += 1; }
    });
    await bypassDispatcher.dispatch({
      socket: authenticated, event: 'login', args: [{}],
      handler: async () => { bypassEntries += 1; }
    });
    assert.equal(bypassConsumes, 0);
    assert.equal(bypassEntries, 2);

    const pendingStarted = deferred();
    const releasePending = deferred();
    let inFlightBegins = 0;
    const orderingDispatcher = security.createSocketEventDispatcher({
      eventBudgetController: security.createEventBudgetController({
        policies: { heavy_read: { maxAttempts: 1, windowMs: 60_000 } }
      }),
      inFlightCoordinator: {
        begin() { inFlightBegins += 1; return Object.freeze({ id: inFlightBegins }); },
        finish() {},
        cancelSocket() {}
      },
      securityLogger: { warn() {} }
    });
    const orderingSocket = new FakeSocket();
    orderingSocket.username = 'Alice';
    const firstPending = orderingDispatcher.dispatch({
      socket: orderingSocket,
      event: 'switch_server',
      args: ['global'],
      handler: async () => {
        pendingStarted.resolve();
        await releasePending.promise;
      }
    });
    await pendingStarted.promise;
    const orderingAck = [];
    await orderingDispatcher.dispatch({
      socket: orderingSocket,
      event: 'switch_server',
      args: ['global', value => orderingAck.push(value)],
      handler: async () => {}
    });
    assert.equal(inFlightBegins, 1);
    assert.deepEqual(orderingAck, [{ error: 'Too many requests. Try again later.' }]);
    releasePending.resolve();
    await firstPending;

    const bounded = security.createEventBudgetController({ maxEntries: 2, now: () => 0 });
    bounded.consume({ account: 'oldest', category: 'light' });
    bounded.consume({ account: 'newer', category: 'heavy_read' });
    bounded.consume({ account: 'newest', category: 'moderation_read' });
    assert.equal(bounded.size(), 2);
  });

  await t.test('every expensive event suppresses duplicates with exact ownership and disconnect cleanup', async () => {
    const inFlightEvents = [
      'change_password', 'update_preferences', 'logout_all_devices', 'update_profile', 'manage_role',
      'moderate_user', 'report_moderation_target', 'list_moderation_reports',
      'resolve_moderation_report', 'list_room_restrictions', 'get_moderation_audit', 'get_automod',
      'update_automod', 'create_server', 'join_server', 'leave_server', 'delete_server',
      'switch_server', 'get_edit_history', 'get_deleted_message'
    ];
    assert.deepEqual(
      Object.entries(security.SOCKET_EVENT_POLICIES)
        .filter(([, policy]) => policy.inFlight)
        .map(([event]) => event),
      inFlightEvents
    );

    for (const event of inFlightEvents) {
      const coordinator = security.createInFlightRequestCoordinator();
      const dispatcher = security.createSocketEventDispatcher({
        inFlightCoordinator: coordinator,
        securityLogger: { warn() {} }
      });
      const socket = new FakeSocket();
      socket.id = `matrix-${event}`;
      const policy = security.SOCKET_EVENT_POLICIES[event];
      const payloadArgs = policy.kind === 'none' ? [] : [policy.kind === 'object' ? {} : ''];
      const started = deferred();
      const release = deferred();
      let handlerEntries = 0;
      const first = dispatcher.dispatch({
        socket,
        event,
        args: payloadArgs,
        handler: async () => {
          handlerEntries += 1;
          started.resolve();
          await release.promise;
        }
      });
      await started.promise;
      const duplicateAck = [];
      await dispatcher.dispatch({
        socket,
        event,
        args: [...payloadArgs, value => duplicateAck.push(value)],
        handler: async () => { handlerEntries += 1; }
      });
      assert.equal(handlerEntries, 1, event);
      assert.deepEqual(duplicateAck, [{ error: 'Request already in progress.' }], event);
      release.resolve();
      await first;
      await dispatcher.dispatch({
        socket,
        event,
        args: payloadArgs,
        handler: async () => { handlerEntries += 1; }
      });
      assert.equal(handlerEntries, 2, `${event} release`);
    }

    const timers = [];
    const exactCoordinator = security.createInFlightRequestCoordinator({
      schedule(callback) {
        const timer = { callback, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearSchedule() {}
    });
    const expiredToken = exactCoordinator.begin('generation-socket', 'switch_server');
    timers[0].callback();
    const currentToken = exactCoordinator.begin('generation-socket', 'switch_server');
    exactCoordinator.finish(expiredToken);
    exactCoordinator.cancelSocket('unrelated-socket');
    assert.equal(exactCoordinator.size(), 1);
    assert.equal(exactCoordinator.begin('generation-socket', 'switch_server'), null);
    exactCoordinator.finish(currentToken);
    assert.equal(exactCoordinator.size(), 0);

    const disconnectCoordinator = security.createInFlightRequestCoordinator();
    const disconnectDispatcher = security.createSocketEventDispatcher({
      inFlightCoordinator: disconnectCoordinator,
      securityLogger: { warn() {} }
    });
    const reconnectSocket = new FakeSocket();
    reconnectSocket.id = 'reused-socket-id';
    security.createConnectionHandler({
      socketEventDispatcher: disconnectDispatcher,
      ioInstance: new FakeIo(),
      onlineUsersMap: new Map(),
      broadcastOnlineUsersFn() {},
      logger: { error() {} }
    })(reconnectSocket);
    const oldStarted = deferred();
    const releaseOld = deferred();
    const oldRequest = disconnectDispatcher.dispatch({
      socket: reconnectSocket,
      event: 'switch_server',
      args: ['global'],
      handler: async () => { oldStarted.resolve(); await releaseOld.promise; }
    });
    await oldStarted.promise;
    await reconnectSocket.trigger('disconnect');
    const newStarted = deferred();
    const releaseNew = deferred();
    const newRequest = disconnectDispatcher.dispatch({
      socket: reconnectSocket,
      event: 'switch_server',
      args: ['global'],
      handler: async () => { newStarted.resolve(); await releaseNew.promise; }
    });
    await newStarted.promise;
    releaseOld.resolve();
    await oldRequest;
    const reconnectDuplicateAck = [];
    await disconnectDispatcher.dispatch({
      socket: reconnectSocket,
      event: 'switch_server',
      args: ['global', value => reconnectDuplicateAck.push(value)],
      handler: async () => {}
    });
    assert.deepEqual(reconnectDuplicateAck, [{ error: 'Request already in progress.' }]);
    releaseNew.resolve();
    await newRequest;
  });

  await t.test('connection attempt and concurrency edges reject without releasing newer tokens', () => {
    let attemptNow = 0;
    const attempts = security.createConnectionAdmission({
      now: () => attemptNow,
      salt: 'matrix-connection-attempts'
    });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const admission = attempts.open({ handshake: { address: '203.0.113.44' } });
      assert.equal(admission.allowed, true, `attempt ${attempt + 1}`);
      attempts.release(admission.token);
    }
    assert.deepEqual(attempts.open({ handshake: { address: '203.0.113.44' } }), {
      allowed: false,
      error: 'Connection unavailable.'
    });
    attemptNow = 60_000;
    const afterExpiry = attempts.open({ handshake: { address: '203.0.113.44' } });
    assert.equal(afterExpiry.allowed, true);
    attempts.release(afterExpiry.token);

    let concurrencyNow = 0;
    const concurrent = security.createConnectionAdmission({
      now: () => concurrencyNow,
      salt: 'matrix-connection-concurrency'
    });
    const concurrentTokens = [];
    for (let count = 0; count < 100; count += 1) {
      if (count === 60) concurrencyNow = 60_000;
      const admission = concurrent.open({ handshake: { address: '198.51.100.45' } });
      assert.equal(admission.allowed, true, `concurrent ${count + 1}`);
      concurrentTokens.push(admission.token);
    }
    const networkBucket = concurrentTokens[0].networkBucket;
    assert.equal(concurrent.concurrent(networkBucket), 100);
    assert.deepEqual(concurrent.open({ handshake: { address: '198.51.100.45' } }), {
      allowed: false,
      error: 'Connection unavailable.'
    });

    const ownership = security.createConnectionAdmission({
      salt: 'matrix-connection-ownership',
      maxAttemptsPerMinute: 10,
      maxConcurrentPerNetwork: 1
    });
    const first = ownership.open({ handshake: { address: '192.0.2.46' } });
    ownership.release(first.token);
    const second = ownership.open({ handshake: { address: '192.0.2.46' } });
    ownership.release(first.token);
    ownership.release({ networkBucket: second.token.networkBucket });
    assert.equal(ownership.concurrent(second.token.networkBucket), 1);
    assert.deepEqual(ownership.open({ handshake: { address: '192.0.2.46' } }), {
      allowed: false,
      error: 'Connection unavailable.'
    });
    ownership.release(second.token);
    assert.equal(ownership.concurrent(second.token.networkBucket), 0);
  });
});

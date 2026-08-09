const test = require('node:test');
const assert = require('node:assert/strict');

const security = require('../server');

test('requiring server.js does not start the HTTP server', () => {
  assert.equal(typeof security.app, 'function');
  assert.equal(typeof security.start, 'function');
  assert.equal(security.server.listening, false);
});

test('safeAck is once-only and contains callback delivery failures', () => {
  assert.doesNotThrow(() => security.safeAck(undefined)({ error: 'ignored' }));
  let received;
  let attempts = 0;
  const acknowledge = security.safeAck(value => {
    attempts += 1;
    received = value;
    throw new Error('trusted callback failed');
  });
  assert.doesNotThrow(() => acknowledge({ success: true }));
  assert.doesNotThrow(() => acknowledge({ error: 'must not deliver twice' }));
  assert.deepEqual(received, { success: true });
  assert.equal(attempts, 1);
});

test('message cursors require one canonical unpadded base64url representation', () => {
  const timestamp = new Date('2026-08-09T12:34:56.000Z');
  const id = '507f1f77bcf86cd799439011';
  const cursor = security.encodeCursor(timestamp, id);
  assert.deepEqual(security.decodeCursor(cursor), { date: timestamp, id });

  const encoded = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  for (const malformed of [
    `${cursor}!`,
    `${cursor}=`,
    encoded([null, id]),
    encoded([0, id]),
    encoded(['2026-08-09T12:34:56Z', id]),
    encoded([timestamp.toISOString(), id.toUpperCase()]),
    Buffer.from(` [\"${timestamp.toISOString()}\",\"${id}\"] `, 'utf8').toString('base64url')
  ]) {
    assert.equal(security.decodeCursor(malformed), null, malformed);
  }
});

test('room search gate bounds pending work, paces starts, and cleans up after failures', async () => {
  let now = 0;
  const timers = [];
  const gate = security.createRoomSearchGate({
    maxPendingPerRoom: 2,
    minStartIntervalMs: 100,
    now: () => now,
    schedule(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    }
  });
  let releaseFirst;
  const first = gate.run('ABC123', () => new Promise(resolve => { releaseFirst = resolve; }));
  const starts = [];
  const second = gate.run('ABC123', async () => { starts.push('second'); return 2; });
  const third = gate.run('ABC123', async () => { starts.push('third'); throw new Error('third failed'); });
  await assert.rejects(
    gate.run('ABC123', async () => 4),
    error => error && error.code === 'SEARCH_BUSY'
  );
  assert.deepEqual(gate.status('ABC123'), { inFlight: 1, pending: 2 });

  releaseFirst(1);
  assert.equal(await first, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(timers.map(timer => timer.delay), [100]);
  now = 100;
  timers.shift().callback();
  assert.equal(await second, 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(timers.map(timer => timer.delay), [100]);
  now = 200;
  timers.shift().callback();
  await assert.rejects(third, /third failed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(gate.status('ABC123'), { inFlight: 0, pending: 0 });
  assert.equal(gate.size(), 1, 'the final start deadline remains paced while idle');
  assert.deepEqual(timers.map(timer => timer.delay), [100]);
  now = 300;
  timers.shift().callback();
  assert.equal(gate.size(), 0);
});

test('room search gate preserves pacing across sequential idle turns', async () => {
  let now = 0;
  let sequence = 0;
  const timers = [];
  const schedule = (callback, delay) => {
    const timer = { callback, dueAt: now + delay, sequence: sequence += 1 };
    timers.push(timer);
    return timer;
  };
  const flushTimersThrough = async dueAt => {
    now = dueAt;
    while (true) {
      const ready = timers
        .filter(timer => timer.dueAt <= now)
        .sort((left, right) => left.dueAt - right.dueAt || left.sequence - right.sequence);
      if (ready.length === 0) return;
      for (const timer of ready) {
        timers.splice(timers.indexOf(timer), 1);
        timer.callback();
      }
      await new Promise(resolve => setImmediate(resolve));
    }
  };
  const gate = security.createRoomSearchGate({
    minStartIntervalMs: 100,
    now: () => now,
    schedule
  });
  const starts = [];

  assert.equal(await gate.run('ABC123', async () => { starts.push(now); return 1; }), 1);
  await new Promise(resolve => setImmediate(resolve));
  const second = gate.run('ABC123', async () => { starts.push(now); return 2; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(starts, [0], 'an idle event-loop turn does not reset the room cooldown');

  await flushTimersThrough(100);
  assert.equal(await second, 2);
  assert.deepEqual(starts, [0, 100]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gate.size(), 1, 'only the active cooldown state remains');
  await flushTimersThrough(200);
  assert.equal(gate.size(), 0, 'idle cooldown state is removed deterministically');
});

test('message search backfill is bounded, retry-safe, and idempotent', async () => {
  const rows = [
    { _id: '1', text: 'cafe\u0301' },
    { _id: '2', text: 'Ｆｕｌｌ　Ｗｉｄｔｈ', searchText: null },
    { _id: '3', text: 'already', searchText: 'already' }
  ];
  let bulkAttempts = 0;
  const observed = { filter: null, projection: null, batchSize: null, ordered: null };
  const MessageModel = {
    find(filter) {
      observed.filter = filter;
      return {
        select(projection) { observed.projection = projection; return this; },
        lean() { return this; },
        cursor({ batchSize }) {
          observed.batchSize = batchSize;
          const missing = rows.filter(row => row.searchText == null).map(row => ({ ...row }));
          return (async function * iterate() { for (const row of missing) yield row; })();
        }
      };
    },
    async bulkWrite(operations, options) {
      bulkAttempts += 1;
      observed.ordered = options.ordered;
      if (bulkAttempts === 1) throw new Error('transient write');
      for (const { updateOne } of operations) {
        const row = rows.find(candidate => candidate._id === updateOne.filter._id);
        if (row && row.searchText == null) Object.assign(row, updateOne.update.$set);
      }
    }
  };

  assert.equal(await security.backfillMessageSearchText({ MessageModel, batchSize: 2 }), 2);
  assert.equal(bulkAttempts, 2);
  assert.deepEqual(rows.map(row => row.searchText), ['café', 'Full Width', 'already']);
  assert.equal(observed.batchSize, 2);
  assert.equal(observed.ordered, false);
  assert.deepEqual(observed.projection, { _id: 1, text: 1 });
  assert.deepEqual(observed.filter, { $or: [
    { searchText: { $exists: false } },
    { searchText: null }
  ] });

  assert.equal(await security.backfillMessageSearchText({ MessageModel, batchSize: 2 }), 0);
  assert.equal(bulkAttempts, 2, 'an idempotent rerun performs no writes');
});

test('stored search normalization bounds legacy input before Unicode expansion', () => {
  const oversizedLegacyText = `${'x'.repeat(1_999)}e\u0301${'\ufdfa'.repeat(10_000)}`;
  const normalized = security.normalizeStoredMessageSearchText(oversizedLegacyText);
  assert.equal(normalized.length, 2_000);
  assert.equal(normalized.endsWith('e'), true,
    'normalization is limited to the same raw 2,000-character prefix accepted for new messages');
});

test('message search backfill fails closed after bounded write retries', async () => {
  let attempts = 0;
  const MessageModel = {
    find() {
      return {
        select() { return this; },
        lean() { return this; },
        cursor() {
          return (async function * iterate() { yield { _id: '1', text: 'secret' }; })();
        }
      };
    },
    async bulkWrite() { attempts += 1; throw new Error('database unavailable'); }
  };
  await assert.rejects(
    security.backfillMessageSearchText({ MessageModel, maxWriteAttempts: 3 }),
    /database unavailable/
  );
  assert.equal(attempts, 3);
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

test('start connects, completes search backfill, and seeds before it begins listening', async () => {
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
      backfillMessageSearchFn: async () => { events.push('backfill'); },
      seedSystemFn: async () => { events.push('seed'); },
      serverInstance: fakeServer,
      port: 4321,
      logger: { log() {} }
    });
  } finally {
    security.server.listen = originalListen;
  }
  assert.deepEqual(events, ['connect', 'backfill', 'seed', 'listen']);
});

test('start never exposes the app when required search backfill fails', async () => {
  const events = [];
  await assert.rejects(security.start({
    mongoUri: 'mongodb://database/chat',
    mongooseImpl: { async connect() { events.push('connect'); } },
    backfillMessageSearchFn: async () => { events.push('backfill'); throw new Error('backfill failed'); },
    seedSystemFn: async () => { events.push('seed'); },
    serverInstance: { listen(_port, callback) { events.push('listen'); callback(); } },
    logger: { log() {} }
  }), /backfill failed/);
  assert.deepEqual(events, ['connect', 'backfill']);
});

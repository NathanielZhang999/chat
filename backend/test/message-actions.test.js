const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const {
  createAutoModTracker,
  createConnectionHandler,
  messageRoomQuery,
  messageCursorQuery,
  nextMessagePage,
  normalizeMessageSearchQuery,
  safeMessageForViewer,
  createRateLimiter,
  createMessageSearchRateLimiter,
  MessageSchema,
  decodeCursor
} = require('../server');
const { FakeSocket, FakeIo, acknowledge, deferred } = require('./support/fakes');

test('safeMessageForViewer allowlists ordinary and deleted history fields', () => {
  const storedId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
  const stored = {
    _id: storedId, serverCode: 'ABC123', username: 'Alice',
    displayName: 'Alice', role: 'user', roomRole: 'user', color: '#123456', avatarUrl: '',
    text: 'current', attachment: 'data:image/png;base64,AAAA',
    replyTo: { id: '507f1f77bcf86cd799439012', displayname: 'Bob', text: 'reply', secret: 'never return' },
    reactions: { '👍': ['Bob'] }, edited: true, deleted: false,
    timestamp: new Date('2026-08-09T00:00:00.000Z'),
    history: [{ text: 'old secret' }], __v: 7, secret: 'never return'
  };
  const approvedKeys = [
    '_id', 'serverCode', 'username', 'displayName', 'role', 'roomRole', 'color',
    'avatarUrl', 'text', 'attachment', 'replyTo', 'reactions', 'edited', 'deleted', 'timestamp'
  ];

  const ordinary = safeMessageForViewer(stored, { username: 'Bob', role: 'user', roomRole: 'user' });
  assert.deepEqual(Object.keys(ordinary).sort(), approvedKeys.sort());
  assert.equal(ordinary._id, storedId.toString());
  assert.equal(ordinary.timestamp, stored.timestamp);
  assert.equal(ordinary.attachment, stored.attachment);
  assert.deepEqual(ordinary.replyTo, { id: stored.replyTo.id, displayname: 'Bob', text: 'reply' });
  assert.deepEqual(ordinary.reactions, { '👍': ['Bob'] });
  ordinary.replyTo.text = 'mutated reply';
  ordinary.reactions['👍'].push('Mallory');
  assert.equal(stored.replyTo.text, 'reply');
  assert.deepEqual(stored.reactions, { '👍': ['Bob'] });
  assert.equal('history' in ordinary, false);
  assert.equal('__v' in ordinary, false);
  assert.equal('secret' in ordinary, false);

  const deleted = safeMessageForViewer({ ...stored, deleted: true }, {
    username: 'Bob', role: 'user', roomRole: 'user'
  });
  assert.equal(deleted.text, '');
  assert.equal(deleted.attachment, null);
  assert.deepEqual(deleted.reactions, {});
  assert.equal(deleted.replyTo, null);
});

test('safeMessageForViewer preserves deleted content only for authorized viewers', () => {
  const stored = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'Alice',
    text: 'deleted current content', attachment: 'data:image/png;base64,AAAA',
    replyTo: { id: '507f1f77bcf86cd799439012', displayname: 'Bob', text: 'reply' },
    reactions: { '👍': ['Bob'] }, deleted: true
  };

  for (const viewer of [
    { username: 'Alice', role: 'user', roomRole: 'user' },
    { username: 'Bob', role: 'admin', roomRole: 'user' },
    { username: 'Bob', role: 'user', roomRole: 'mod' }
  ]) {
    const serialized = safeMessageForViewer(stored, viewer);
    assert.equal(serialized.text, stored.text);
    assert.equal(serialized.attachment, stored.attachment);
    assert.deepEqual(serialized.replyTo, stored.replyTo);
    assert.deepEqual(serialized.reactions, stored.reactions);
  }

  const malformedStoredForAdmin = safeMessageForViewer(
    { ...stored, username: null },
    { username: 'Bob', role: 'admin', roomRole: 'user' }
  );
  assert.equal(malformedStoredForAdmin.text, stored.text);
});

test('safeMessageForViewer redacts deleted content for malformed message or viewer identities', () => {
  const validDeleted = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'Alice',
    text: 'deleted secret', attachment: 'data:image/png;base64,AAAA',
    replyTo: { id: '507f1f77bcf86cd799439012', displayname: 'Bob', text: 'reply' },
    reactions: { '👍': ['Bob'] }, deleted: true
  };
  const cases = [
    [validDeleted, undefined],
    [validDeleted, { username: '', role: 'admin', roomRole: 'mod' }],
    [{ ...validDeleted, username: null }, { username: 'Bob', role: 'user', roomRole: 'user' }],
    [{ ...validDeleted, username: '<invalid>' }, { username: 'Bob', role: 'user', roomRole: 'user' }]
  ];

  for (const [message, viewer] of cases) {
    const serialized = safeMessageForViewer(message, viewer, { search: true });
    assert.equal(serialized.text, '');
    assert.equal('replyTo' in serialized, false);
    assert.equal('attachment' in serialized, false);
    assert.equal('reactions' in serialized, false);
  }
});

test('safeMessageForViewer omits attachment, reply, and reactions from search rows', () => {
  const serialized = safeMessageForViewer({
    _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'Alice',
    text: 'searchable text', attachment: 'data:image/png;base64,AAAA', reactions: { '👍': ['Bob'] },
    replyTo: { id: '507f1f77bcf86cd799439012', displayname: 'Bob', text: 'reply' },
    history: [{ text: 'old secret' }], __v: 7
  }, { username: 'Bob', role: 'user', roomRole: 'user' }, { search: true });

  assert.equal('attachment' in serialized, false);
  assert.equal('replyTo' in serialized, false);
  assert.equal('reactions' in serialized, false);
  assert.equal('history' in serialized, false);
  assert.equal('__v' in serialized, false);
});

test('message room query preserves legacy global messages', () => {
  assert.deepEqual(messageRoomQuery('ABC123'), { serverCode: 'ABC123' });
  assert.deepEqual(messageRoomQuery('global'), {
    $or: [
      { serverCode: 'global' },
      { serverCode: { $exists: false } },
      { serverCode: null }
    ]
  });
});

test('message keyset query and next cursor handle equal timestamps without duplicates', () => {
  const cursor = { date: new Date('2026-08-09T00:00:00.000Z'), id: '507f1f77bcf86cd799439020' };
  assert.deepEqual(messageCursorQuery(cursor), { $or: [
    { timestamp: { $lt: cursor.date } },
    { timestamp: cursor.date, _id: { $lt: cursor.id } }
  ] });
  const timestamp = new Date('2026-08-09T00:00:00.000Z');
  const rows = Array.from({ length: 23 }, (_, index) => ({
    _id: `507f1f77bcf86cd799439${String(42 - index).padStart(3, '0')}`,
    timestamp
  }));
  const result = nextMessagePage(rows, 20);
  assert.equal(result.page.length, 20);
  assert.ok(result.nextCursor);
  const decoded = decodeCursor(result.nextCursor);
  assert.deepEqual(decoded, { date: timestamp, id: rows[19]._id });
  const boundary = messageCursorQuery(decoded);
  const secondRows = rows.filter(row =>
    row.timestamp < boundary.$or[0].timestamp.$lt ||
    (row.timestamp.getTime() === boundary.$or[1].timestamp.getTime() && row._id < boundary.$or[1]._id.$lt)
  );
  const second = nextMessagePage(secondRows, 20);
  assert.deepEqual(second.page.map(row => row._id), rows.slice(20).map(row => row._id));
  assert.equal(second.nextCursor, null);
  const allIds = [...result.page, ...second.page].map(row => row._id);
  assert.equal(new Set(allIds).size, rows.length);
  assert.deepEqual(allIds, rows.map(row => row._id));
});

test('Message schema declares exact chronological indexes', () => {
  assert.deepEqual(MessageSchema.indexes().map(([keys]) => keys), [
    { serverCode: 1, timestamp: -1, _id: -1 },
    { timestamp: -1, _id: -1 }
  ]);
});

test('search normalization accepts bounded NFKC text and rejects malformed input', () => {
  assert.equal(normalizeMessageSearchQuery('  cafe\u0301  '), 'café');
  for (const value of [null, {}, 'x', 'x'.repeat(81)]) {
    assert.equal(normalizeMessageSearchQuery(value), null);
  }
});

const matchingSearchRow = {
  _id: 'matching-current-room-id',
  serverCode: 'ABC123',
  username: 'alice',
  displayName: 'Alice',
  role: 'user',
  roomRole: 'user',
  color: '#123456',
  avatarUrl: '',
  text: 'literal a+b match',
  attachment: 'data:image/png;base64,AAAA',
  replyTo: { id: '507f1f77bcf86cd799439012', displayname: 'Bob', text: 'private reply' },
  reactions: { '👍': ['bob'] },
  edited: true,
  deleted: false,
  history: [{ text: 'private history' }],
  __v: 7,
  internal: 'private internal field',
  timestamp: new Date('2026-08-09T12:00:00.000Z')
};

function boundedSearchQuery(rows, observed = {}) {
  let maximum = rows.length;
  return {
    select(value) { observed.select = value; return this; },
    sort(value) { observed.sort = value; return this; },
    limit(value) { observed.limit = value; maximum = value; return this; },
    async lean() { return rows.slice(0, maximum); }
  };
}

function registerMessages(overrides = {}) {
  const socket = new FakeSocket();
  const ioInstance = new FakeIo();
  createConnectionHandler({
    ioInstance,
    UserModel: {
      async findOne() {
        return { username: 'alice', role: 'user', servers: ['global', 'ABC123', 'BBB222'] };
      }
    },
    ChatServerModel: { async findOne(query) { return { code: query.code }; } },
    RoomRestrictionModel: { async findOne() { return null; }, async find() { return []; } },
    onlineUsersMap: new Map(),
    broadcastOnlineUsersFn: async () => {},
    getRoomRoleFn: async () => 'user',
    resolvePingsFn: async text => text,
    searchRateLimiter: { check() { return true; } },
    autoModTracker: createAutoModTracker(),
    ...overrides
  })(socket);
  return { socket, ioInstance };
}

test('search_messages escapes substring input and isolates the active room', async () => {
  let observedFilter;
  const observedQuery = {};
  const MessageModel = {
    find(filter) {
      observedFilter = filter;
      return boundedSearchQuery([matchingSearchRow], observedQuery);
    }
  };
  const { socket } = registerMessages({ MessageModel });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  const ack = acknowledge();

  await socket.trigger('search_messages', {
    serverCode: 'ABC123', clientContextId: 4, query: 'a+b', requestId: 9
  }, ack.callback);

  const response = ack.value();
  assert.deepEqual(response.results.map(row => row._id), ['matching-current-room-id']);
  assert.deepEqual(
    { serverCode: response.serverCode, clientContextId: response.clientContextId, requestId: response.requestId },
    { serverCode: 'ABC123', clientContextId: 4, requestId: 9 }
  );
  assert.deepEqual(observedFilter.$and.slice(0, 2), [
    { serverCode: 'ABC123' },
    { deleted: { $ne: true } }
  ]);
  assert.equal(observedFilter.$and[2].text.source, 'a\\+b');
  assert.equal(observedFilter.$and[2].text.flags, 'i');
  assert.deepEqual(observedQuery.sort, { timestamp: -1, _id: -1 });
  assert.equal(observedQuery.limit, 20);
  assert.deepEqual(observedQuery.select, {
    _id: 1,
    serverCode: 1,
    username: 1,
    displayName: 1,
    role: 1,
    roomRole: 1,
    color: 1,
    avatarUrl: 1,
    text: 1,
    edited: 1,
    timestamp: 1
  });
  for (const privateField of ['attachment', 'replyTo', 'reactions', 'history', '__v', 'internal']) {
    assert.equal(privateField in response.results[0], false, privateField);
  }
});

test('search_messages excludes deleted rows before matching current text or history', async () => {
  const deletedSearchRow = {
    ...matchingSearchRow,
    _id: 'deleted-search-row',
    text: 'current secret',
    deleted: true,
    history: [{ text: 'older secret' }]
  };
  let observedFilter;
  const MessageModel = {
    find(filter) {
      observedFilter = filter;
      const excludesDeleted = filter.$and.some(clause =>
        clause.deleted && clause.deleted.$ne === true
      );
      return boundedSearchQuery(excludesDeleted ? [] : [deletedSearchRow]);
    }
  };
  const { socket } = registerMessages({ MessageModel });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  const ack = acknowledge();

  await socket.trigger('search_messages', {
    serverCode: 'ABC123', clientContextId: 5, query: 'secret', requestId: 10
  }, ack.callback);

  assert.deepEqual(observedFilter.$and[1], { deleted: { $ne: true } });
  assert.deepEqual(ack.value().results, []);
  assert.equal(JSON.stringify(observedFilter).includes('history'), false);
});

test('search_messages identifies missing and null legacy Global rows with the active room code', async () => {
  const missingGlobalRow = { ...matchingSearchRow, _id: 'missing-global-id' };
  delete missingGlobalRow.serverCode;
  const nullGlobalRow = { ...matchingSearchRow, _id: 'null-global-id', serverCode: null };
  let observedFilter;
  const { socket } = registerMessages({
    MessageModel: {
      find(filter) {
        observedFilter = filter;
        return boundedSearchQuery([missingGlobalRow, nullGlobalRow]);
      }
    }
  });
  authenticate(socket, { serverCode: 'global', joinedServers: ['global'] });
  const ack = acknowledge();

  await socket.trigger('search_messages', {
    serverCode: 'global', clientContextId: 6, query: 'literal', requestId: 15
  }, ack.callback);

  assert.deepEqual(observedFilter.$and[0], messageRoomQuery('global'));
  assert.deepEqual(
    ack.value().results.map(row => ({ _id: row._id, serverCode: row.serverCode })),
    [
      { _id: 'missing-global-id', serverCode: 'global' },
      { _id: 'null-global-id', serverCode: 'global' }
    ]
  );
});

test('search_messages validates plain payloads, active room, contexts, request IDs, and query bounds', async () => {
  const observedPatterns = [];
  let queries = 0;
  const { socket } = registerMessages({
    MessageModel: {
      find(filter) {
        queries += 1;
        observedPatterns.push(filter.$and[2].text.source);
        return boundedSearchQuery([]);
      }
    }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  const invalidPayloads = [
    null,
    [],
    new Date(),
    'not-an-object',
    { serverCode: 'ABC123', clientContextId: 4, query: 'x', requestId: 1 },
    { serverCode: 'ABC123', clientContextId: 4, query: 'x'.repeat(81), requestId: 1 },
    { serverCode: 'ABC123', clientContextId: 4, query: 12, requestId: 1 },
    { serverCode: 'ABC123', clientContextId: 0, query: 'ok', requestId: 1 },
    { serverCode: 'ABC123', clientContextId: 1.5, query: 'ok', requestId: 1 },
    { serverCode: 'ABC123', clientContextId: 4, query: 'ok', requestId: 0 },
    { serverCode: 'ABC123', clientContextId: 4, query: 'ok', requestId: -1 },
    { serverCode: 'ABC123', clientContextId: 4, query: 'ok', requestId: 1.5 },
    { serverCode: 'ABC123', clientContextId: 4, query: 'ok', requestId: Number.MAX_SAFE_INTEGER + 1 },
    { serverCode: 'global', clientContextId: 4, query: 'ok', requestId: 1 }
  ];
  for (const payload of invalidPayloads) {
    const ack = acknowledge();
    await socket.trigger('search_messages', payload, ack.callback);
    assert.deepEqual(ack.value(), { error: 'Invalid input format.' }, JSON.stringify(payload));
  }
  assert.equal(queries, 0);

  for (const [query, source] of [
    ['ab', 'ab'],
    ['x'.repeat(80), 'x'.repeat(80)],
    ['  cafe\u0301  ', 'café']
  ]) {
    const ack = acknowledge();
    await socket.trigger('search_messages', {
      serverCode: 'abc123', clientContextId: 4, query, requestId: queries + 1
    }, ack.callback);
    assert.equal(ack.value().requestId, queries);
    assert.equal(observedPatterns.at(-1), source);
  }
  assert.equal(queries, 3);
});

test('search_messages returns at most twenty newest projected rows', async () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({
    ...matchingSearchRow,
    _id: String(index + 1),
    text: `matching row ${index + 1}`,
    timestamp: new Date(1_800_000_000_000 - index)
  }));
  const observedQuery = {};
  const { socket } = registerMessages({
    MessageModel: { find() { return boundedSearchQuery(rows, observedQuery); } }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  const ack = acknowledge();

  await socket.trigger('search_messages', {
    serverCode: 'ABC123', clientContextId: 4, query: 'matching', requestId: 11
  }, ack.callback);

  assert.equal(ack.value().results.length, 20);
  assert.deepEqual(ack.value().results.map(row => row._id), rows.slice(0, 20).map(row => row._id));
  assert.deepEqual(observedQuery.sort, { timestamp: -1, _id: -1 });
  assert.equal(observedQuery.limit, 20);
});

test('search rate limiter production factory wires exact bounds and unrefd pruning', () => {
  const now = () => 123;
  let observedOptions;
  let scheduledCallback;
  let scheduledDelay;
  let pruneCalls = 0;
  let unrefCalls = 0;
  const injectedLimiter = {
    check() { return true; },
    prune() { pruneCalls += 1; }
  };

  const result = createMessageSearchRateLimiter({
    now,
    createLimiter(options) {
      observedOptions = options;
      return injectedLimiter;
    },
    schedule(callback, delay) {
      scheduledCallback = callback;
      scheduledDelay = delay;
      return { unref() { unrefCalls += 1; } };
    }
  });

  assert.equal(result, injectedLimiter);
  assert.deepEqual(
    {
      maxEntries: observedOptions.maxEntries,
      maxAttempts: observedOptions.maxAttempts,
      windowMs: observedOptions.windowMs
    },
    { maxEntries: 10_000, maxAttempts: 30, windowMs: 60_000 }
  );
  assert.equal(observedOptions.now, now);
  assert.equal(scheduledDelay, 60_000);
  assert.equal(unrefCalls, 1);
  assert.equal(pruneCalls, 0);
  scheduledCallback();
  assert.equal(pruneCalls, 1);
});

test('search rate limiter production defaults enforce a rolling sixty-second window', () => {
  let currentTime = 0;
  const searchRateLimiter = createMessageSearchRateLimiter({
    now: () => currentTime,
    schedule() { return { unref() {} }; }
  });

  for (let attempt = 0; attempt < 15; attempt += 1) {
    assert.equal(searchRateLimiter.check('alice'), true);
  }
  currentTime = 30_000;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    assert.equal(searchRateLimiter.check('alice'), true);
  }
  assert.equal(searchRateLimiter.check('alice'), false);

  currentTime = 60_000;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    assert.equal(searchRateLimiter.check('alice'), true);
  }
  currentTime = 89_999;
  assert.equal(searchRateLimiter.check('alice'), false);
  currentTime = 90_000;
  assert.equal(searchRateLimiter.check('alice'), true);
});

test('search_messages uses the production default thirty-attempt limiter', async () => {
  const { socket } = registerMessages({
    searchRateLimiter: undefined,
    MessageModel: { find() { return boundedSearchQuery([]); } }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  socket.username = 'limituser';
  socket.handshake.address = '203.0.113.77';

  for (let requestId = 1; requestId <= 30; requestId += 1) {
    const ack = acknowledge();
    await socket.trigger('search_messages', {
      serverCode: 'ABC123', clientContextId: 4, query: 'default', requestId
    }, ack.callback);
    assert.deepEqual(ack.value().results, []);
  }
  const limitedAck = acknowledge();
  await socket.trigger('search_messages', {
    serverCode: 'ABC123', clientContextId: 4, query: 'default', requestId: 31
  }, limitedAck.callback);
  assert.deepEqual(limitedAck.value(), { error: 'Too many requests. Try again later.' });
});

test('search_messages limiter keys normalize accounts and isolate transport addresses', async () => {
  const observedKeys = [];
  const limiter = createRateLimiter({
    maxEntries: 10,
    maxAttempts: 1,
    windowMs: 60_000,
    now: () => 0
  });
  const searchRateLimiter = {
    check(key) {
      observedKeys.push(key);
      return limiter.check(key);
    }
  };
  const { socket } = registerMessages({
    searchRateLimiter,
    MessageModel: { find() { return boundedSearchQuery([]); } }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  socket.username = 'Alice';
  socket.handshake.address = ' ::FFFF:127.0.0.1 ';

  async function search(requestId) {
    const ack = acknowledge();
    await socket.trigger('search_messages', {
      serverCode: 'ABC123', clientContextId: 4, query: 'keys', requestId
    }, ack.callback);
    return ack.value();
  }

  assert.deepEqual((await search(1)).results, []);
  socket.username = 'ALICE';
  assert.deepEqual(await search(2), { error: 'Too many requests. Try again later.' });
  socket.handshake.address = '127.0.0.2';
  assert.deepEqual((await search(3)).results, []);
  socket.username = 'Bob';
  assert.deepEqual((await search(4)).results, []);

  assert.deepEqual(observedKeys, [
    'message_search:alice:127.0.0.1',
    'message_search:alice:127.0.0.1',
    'message_search:alice:127.0.0.2',
    'message_search:bob:127.0.0.2'
  ]);
});

test('search_messages allows active timeouts but denies active bans to global admins', async () => {
  let queries = 0;
  const timedOut = registerMessages({
    RoomRestrictionModel: {
      async findOne() { return { bannedAt: null, timeoutUntil: new Date(Date.now() + 60_000) }; },
      async find() { return []; }
    },
    MessageModel: {
      find() { queries += 1; return boundedSearchQuery([matchingSearchRow]); }
    }
  });
  authenticate(timedOut.socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  const timeoutAck = acknowledge();
  await timedOut.socket.trigger('search_messages', {
    serverCode: 'ABC123', clientContextId: 4, query: 'literal', requestId: 12
  }, timeoutAck.callback);
  assert.deepEqual(timeoutAck.value().results.map(row => row._id), ['matching-current-room-id']);

  const bannedAdmin = registerMessages({
    UserModel: {
      async findOne() { return { username: 'alice', role: 'admin', servers: ['global'] }; }
    },
    RoomRestrictionModel: {
      async findOne() { return { bannedAt: new Date(), timeoutUntil: null }; },
      async find() { return []; }
    },
    MessageModel: {
      find() { queries += 1; return boundedSearchQuery([matchingSearchRow]); }
    }
  });
  authenticate(bannedAdmin.socket, { serverCode: 'ABC123', joinedServers: ['global'] });
  bannedAdmin.socket.role = 'admin';
  const banAck = acknowledge();
  await bannedAdmin.socket.trigger('search_messages', {
    serverCode: 'ABC123', clientContextId: 4, query: 'literal', requestId: 13
  }, banAck.callback);
  assert.deepEqual(banAck.value(), { error: 'Permission denied.' });
  assert.equal(queries, 1);
});

test('search_messages logs only generic error metadata without query or message content', async () => {
  const logged = [];
  const secretQuery = 'needle-private-query';
  const secretText = 'matching private message text';
  const { socket } = registerMessages({
    MessageModel: {
      find() { throw new Error(`${secretQuery}: ${secretText}`); }
    },
    logger: { error(...args) { logged.push(args); } }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  const ack = acknowledge();

  await socket.trigger('search_messages', {
    serverCode: 'ABC123', clientContextId: 4, query: secretQuery, requestId: 14
  }, ack.callback);

  assert.deepEqual(ack.value(), { error: 'Search failed.' });
  assert.deepEqual(logged, [[
    'Chat operation failed.',
    { event: 'search_messages', errorType: 'Error' }
  ]]);
  assert.equal(JSON.stringify(logged).includes(secretQuery), false);
  assert.equal(JSON.stringify(logged).includes(secretText), false);
});

function authenticate(socket, { serverCode = 'global', joinedServers = ['global'] } = {}) {
  socket.username = 'alice';
  socket.displayName = 'Alice';
  socket.role = 'user';
  socket.serverCode = serverCode;
  socket.joinedServers = joinedServers;
}

test('reaction in an inaccessible message room does not save or emit', async () => {
  let saved = false;
  const message = {
    serverCode: 'ABC123', deleted: false, reactions: {},
    markModified() {}, async save() { saved = true; }
  };
  const MessageModel = { findById: async () => message };
  const { socket, ioInstance } = registerMessages({ MessageModel });
  authenticate(socket);
  await socket.trigger('toggle_reaction', { id: '507f1f77bcf86cd799439011', emoji: '👍' });
  assert.equal(saved, false);
  assert.deepEqual(ioInstance.outbound, []);
});

test('editing emits only to the active stored message room', async () => {
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'alice',
    role: 'user', roomRole: 'user', text: 'before', history: [], deleted: false,
    markModified() {}, async save() {}
  };
  const MessageModel = { findById: async () => message };
  const { socket, ioInstance } = registerMessages({ MessageModel });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  await socket.trigger('edit_message', { id: message._id, text: 'after' });
  assert.equal(ioInstance.outbound.at(-1).room, 'ABC123');
  assert.equal(ioInstance.outbound.at(-1).event, 'message_edited');
});

test('message reply snapshot comes from the stored same-room message', async () => {
  let created;
  const referenced = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'bob',
    displayName: 'Bob', text: 'trusted stored text', deleted: false
  };
  const MessageModel = {
    findById: async () => referenced,
    async create(value) {
      created = value;
      return { ...value, _id: '507f191e810c19729de860ea', timestamp: new Date() };
    }
  };
  const { socket } = registerMessages({ MessageModel });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  await socket.trigger('chat_message', {
    text: 'reply',
    replyTo: { id: referenced._id, displayname: '<img>', text: '<script>' }
  });
  assert.deepEqual(created.replyTo, {
    id: referenced._id,
    displayname: 'Bob',
    text: 'trusted stored text'
  });
});

test('chat message is rejected when its active room changes while mention resolution is pending', async () => {
  const resolverStarted = deferred();
  const resolver = deferred();
  let created;
  const { socket, ioInstance } = registerMessages({
    resolvePingsFn: async () => {
      resolverStarted.resolve();
      return resolver.promise;
    },
    MessageModel: {
      async create(value) {
        created = value;
        return { ...value, _id: '507f191e810c19729de860ea', timestamp: new Date() };
      }
    }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123', 'BBB222'] });

  const pending = socket.trigger('chat_message', { text: '@Bob hello' });
  await resolverStarted.promise;
  socket.serverCode = 'BBB222';
  resolver.resolve('hello');
  await pending;

  assert.equal(created, undefined);
  assert.deepEqual(ioInstance.outbound, []);
});

test('chat message emits to its stored room when persistence is pending', async () => {
  const createStarted = deferred();
  const releaseCreate = deferred();
  let created;
  const { socket, ioInstance } = registerMessages({
    MessageModel: {
      async create(value) {
        created = value;
        createStarted.resolve();
        await releaseCreate.promise;
        return { ...value, _id: '507f191e810c19729de860ea', timestamp: new Date() };
      }
    }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123', 'BBB222'] });

  const pending = socket.trigger('chat_message', { text: 'hello' });
  await createStarted.promise;
  socket.serverCode = 'BBB222';
  releaseCreate.resolve();
  await pending;

  assert.equal(created.serverCode, 'ABC123');
  assert.equal(ioInstance.outbound.at(-1).room, 'ABC123');
});

test('chat message rechecks membership immediately before persistence', async () => {
  const resolverStarted = deferred();
  const resolver = deferred();
  let created = 0;
  const user = { username: 'alice', role: 'user', servers: ['global', 'ABC123'] };
  const { socket, ioInstance } = registerMessages({
    UserModel: { async findOne() { return user; } },
    resolvePingsFn: async () => {
      resolverStarted.resolve();
      return resolver.promise;
    },
    MessageModel: { async create() { created += 1; } }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });

  const pending = socket.trigger('chat_message', { text: '@Bob hello' });
  await resolverStarted.promise;
  user.servers = ['global'];
  socket.joinedServers = ['global'];
  resolver.resolve('hello');
  await pending;

  assert.equal(created, 0);
  assert.deepEqual(ioInstance.outbound, []);
});

test('chat messages reject malformed payloads without rejecting the handler or writing', async () => {
  let created = 0;
  const { socket } = registerMessages({
    MessageModel: { async create() { created += 1; } }
  });
  authenticate(socket);

  for (const payload of [null, undefined, 12, 'raw message', [], { text: null }, { text: 12 }]) {
    await assert.doesNotReject(socket.trigger('chat_message', payload));
  }
  assert.equal(created, 0);
});

test('chat messages reject invalid attachments without writing', async () => {
  let created = 0;
  const { socket } = registerMessages({
    MessageModel: { async create() { created += 1; } }
  });
  authenticate(socket);
  await socket.trigger('chat_message', { text: 'hello', attachment: 'javascript:alert(1)' });
  assert.equal(created, 0);
});

test('chat messages neutralize client ping tokens before resolving mentions', async () => {
  let resolverInput;
  const { socket } = registerMessages({
    resolvePingsFn: async text => { resolverInput = text; return text; },
    MessageModel: {
      async create(value) { return { ...value, _id: '507f191e810c19729de860ea', timestamp: new Date() }; }
    }
  });
  authenticate(socket);
  await socket.trigger('chat_message', { text: '{{PING:everyone|everyone}}' });
  assert.equal(resolverInput, '{{ PING:everyone|everyone}}');
});

test('client-supplied ping tokens cannot be re-promoted by mention resolution during creation', async () => {
  let created;
  const { socket } = registerMessages({
    resolvePingsFn: async text => text.replace('@everyone', '{{PING:everyone|everyone}}'),
    MessageModel: {
      async create(value) {
        created = value;
        return { ...value, _id: '507f191e810c19729de860ea', timestamp: new Date() };
      }
    }
  });
  authenticate(socket);

  await socket.trigger('chat_message', { text: '{{PING:everyone|everyone}}' });

  assert.ok(created);
  assert.equal(/\{\{PING:/i.test(created.text), false);
});

test('chat messages neutralize brace-bearing ping sentinels before mention resolution', async () => {
  let resolverInput;
  const { socket } = registerMessages({
    resolvePingsFn: async text => { resolverInput = text; return text; },
    MessageModel: {
      async create(value) { return { ...value, _id: '507f191e810c19729de860ea', timestamp: new Date() }; }
    }
  });
  authenticate(socket);
  await socket.trigger('chat_message', { text: '{{PING:alice|A{lice}}}' });
  assert.equal(/\{\{PING:/i.test(resolverInput), false);
});

test('an invalid reply reference does not prevent creating a message with no reply snapshot', async () => {
  let created;
  const { socket } = registerMessages({
    MessageModel: {
      async findById() { return { serverCode: 'ABC123', deleted: true }; },
      async create(value) {
        created = value;
        return { ...value, _id: '507f191e810c19729de860ea', timestamp: new Date() };
      }
    }
  });
  authenticate(socket);
  await socket.trigger('chat_message', {
    text: 'still sends',
    replyTo: { id: '507f1f77bcf86cd799439011', displayname: 'forged', text: 'forged' }
  });
  assert.equal(created.replyTo, null);
});

test('invalid reaction values do not look up, save, or emit messages', async () => {
  let lookups = 0;
  let saved = 0;
  const { socket, ioInstance } = registerMessages({
    MessageModel: {
      async findById() {
        lookups += 1;
        return { reactions: {}, markModified() {}, async save() { saved += 1; } };
      }
    }
  });
  authenticate(socket);
  await socket.trigger('toggle_reaction', { id: '507f1f77bcf86cd799439011', emoji: '__proto__😀' });
  assert.equal(lookups, 0);
  assert.equal(saved, 0);
  assert.deepEqual(ioInstance.outbound, []);
});

test('message-id actions reject malformed ids without rejecting their handlers', async () => {
  let lookups = 0;
  const { socket } = registerMessages({ MessageModel: { async findById() { lookups += 1; } } });
  authenticate(socket);
  const events = [
    ['toggle_reaction', [{ id: 'not-an-id', emoji: '👍' }]],
    ['edit_message', [{ id: 'not-an-id', text: 'after' }]],
    ['delete_message', ['not-an-id']],
    ['get_edit_history', ['not-an-id']],
    ['get_deleted_message', ['not-an-id']]
  ];
  for (const [event, args] of events) {
    await assert.doesNotReject(socket.trigger(event, ...args));
  }
  assert.equal(lookups, 0);
});

test('editing ignores null, undefined, and malformed data without rejecting', async () => {
  let lookups = 0;
  const { socket } = registerMessages({ MessageModel: { async findById() { lookups += 1; } } });
  authenticate(socket);
  for (const data of [null, undefined, [], {}, { id: '507f1f77bcf86cd799439011' }, { text: 'after' }]) {
    await assert.doesNotReject(socket.trigger('edit_message', data));
  }
  assert.equal(lookups, 0);
});

test('editing a message bounds an oversized legacy history to its newest twenty entries', async () => {
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', username: 'alice',
    text: 'before', deleted: false,
    history: Array.from({ length: 21 }, (_, index) => ({ text: `old-${index}` })),
    markModified() {}, async save() {}
  };
  const { socket } = registerMessages({ MessageModel: { findById: async () => message } });
  authenticate(socket);
  await socket.trigger('edit_message', { id: message._id, text: 'after' });
  assert.equal(message.history.length, 20);
  assert.equal(message.history[0].text, 'old-2');
  assert.equal(message.history.at(-1).text, 'before');
});

test('edit history reads return only the newest twenty legacy entries', async () => {
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', username: 'alice',
    history: Array.from({ length: 21 }, (_, index) => ({ text: `old-${index}` }))
  };
  const { socket } = registerMessages({ MessageModel: { findById: async () => message } });
  authenticate(socket);
  const ack = acknowledge();
  await socket.trigger('get_edit_history', message._id, ack.callback);
  assert.equal(ack.value().history.length, 20);
  assert.equal(ack.value().history[0].text, 'old-1');
  assert.equal(ack.value().history.at(-1).text, 'old-20');
});

test('room history strips unsafe legacy attachments before acknowledgement', async () => {
  const history = [
    { _id: '507f1f77bcf86cd799439011', serverCode: 'global', attachment: 'javascript:alert(1)' },
    { _id: '507f191e810c19729de860ea', serverCode: 'global', attachment: 'data:image/png;base64,AAAA' }
  ];
  const { socket } = registerMessages({
    MessageModel: {
      find() {
        return {
          sort() { return this; },
          limit() { return this; },
          async lean() { return history; }
        };
      }
    }
  });
  authenticate(socket);
  const ack = acknowledge();
  await socket.trigger('switch_server', 'global', ack.callback);
  assert.equal(ack.value().history[0].attachment, 'data:image/png;base64,AAAA');
  assert.equal(ack.value().history[1].attachment, null);
});

test('deleted-message reads strip unsafe legacy attachments', async () => {
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', username: 'alice',
    text: 'deleted', attachment: 'data:text/html;base64,PHNjcmlwdD4=', deleted: true
  };
  const { socket } = registerMessages({ MessageModel: { async findById() { return message; } } });
  authenticate(socket);
  const ack = acknowledge();
  await socket.trigger('get_deleted_message', message._id, ack.callback);
  assert.deepEqual(ack.value(), { success: true, text: 'deleted', attachment: null });
});

test('a sender who left a room cannot edit, read, or delete its old messages', async () => {
  let roomRoleLookups = 0;
  const editable = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'alice', text: 'before', deleted: false,
    markModified() {}, async save() { throw new Error('must not save'); }
  };
  const deleted = {
    _id: '507f191e810c19729de860ea', serverCode: 'ABC123', username: 'alice', text: 'secret', attachment: null, deleted: true
  };
  const { socket } = registerMessages({
    MessageModel: {
      async findById(id) { return id === editable._id ? editable : deleted; }
    },
    getRoomRoleFn: async () => { roomRoleLookups += 1; return 'user'; }
  });
  authenticate(socket);
  const historyAck = acknowledge();
  const deletedAck = acknowledge();
  await assert.doesNotReject(socket.trigger('edit_message', { id: editable._id, text: 'after' }));
  await assert.doesNotReject(socket.trigger('delete_message', editable._id));
  await socket.trigger('get_edit_history', editable._id, historyAck.callback);
  await socket.trigger('get_deleted_message', deleted._id, deletedAck.callback);
  assert.deepEqual(historyAck.value(), { error: 'Permission denied.' });
  assert.deepEqual(deletedAck.value(), { error: 'Permission denied.' });
  assert.equal(roomRoleLookups, 0);
});

test('stale cached admin and moderator roles cannot delete another user message', async () => {
  for (const staleRole of ['admin', 'mod']) {
    let saved = false;
    const message = {
      _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'bob',
      role: 'user', roomRole: 'user', text: 'protected', history: [], deleted: false,
      markModified() {}, async save() { saved = true; }
    };
    const { socket, ioInstance } = registerMessages({
      MessageModel: { findById: async () => message },
      getRoomRoleFn: async () => staleRole === 'mod' ? 'mod' : 'user'
    });
    authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
    socket.role = staleRole === 'admin' ? 'admin' : 'user';

    await socket.trigger('delete_message', message._id);

    assert.equal(saved, false, staleRole);
    assert.equal(message.deleted, false, staleRole);
    assert.deepEqual(ioInstance.outbound, [], staleRole);
  }
});

test('a persisted room ban blocks an administrator from deleting another user message', async () => {
  let saved = false;
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'bob',
    role: 'user', roomRole: 'user', text: 'protected', history: [], deleted: false,
    markModified() {}, async save() { saved = true; }
  };
  const { socket, ioInstance } = registerMessages({
    MessageModel: { findById: async () => message },
    UserModel: {
      async findOne() {
        return { username: 'alice', role: 'admin', servers: ['global', 'ABC123'] };
      }
    },
    RoomRestrictionModel: {
      async findOne() { return { bannedAt: new Date(), timeoutUntil: null }; },
      async find() { return []; }
    }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  socket.role = 'admin';

  await socket.trigger('delete_message', message._id);

  assert.equal(saved, false);
  assert.equal(message.deleted, false);
  assert.deepEqual(ioInstance.outbound, []);
});

test('typing emits a complete payload only for accessible active rooms and boolean states', async () => {
  const { socket } = registerMessages();
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global'] });
  await socket.trigger('typing', true);
  await socket.trigger('typing', 'true');
  assert.deepEqual(socket.outbound, []);

  socket.joinedServers.push('ABC123');
  await socket.trigger('typing', 'true');
  await socket.trigger('typing', true);
  assert.deepEqual(socket.outbound, [{
    target: 'ABC123',
    event: 'typing',
    payload: { username: 'alice', displayName: 'Alice', isTyping: true }
  }]);
});

test('editing neutralizes client ping tokens before resolving mentions', async () => {
  let resolverInput;
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', username: 'alice',
    text: 'before', history: [], deleted: false,
    markModified() {}, async save() {}
  };
  const { socket } = registerMessages({
    MessageModel: { findById: async () => message },
    resolvePingsFn: async text => { resolverInput = text; return text; }
  });
  authenticate(socket);
  await socket.trigger('edit_message', { id: message._id, text: '{{PING:everyone|everyone}}' });
  assert.equal(resolverInput, '{{ PING:everyone|everyone}}');
});

test('client-supplied ping tokens cannot be re-promoted by mention resolution during editing', async () => {
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', username: 'alice',
    text: 'before', history: [], deleted: false,
    markModified() {}, async save() {}
  };
  const { socket } = registerMessages({
    MessageModel: { findById: async () => message },
    resolvePingsFn: async text => text.replace('@everyone', '{{PING:everyone|everyone}}')
  });
  authenticate(socket);

  await socket.trigger('edit_message', { id: message._id, text: '{{PING:everyone|everyone}}' });

  assert.equal(/\{\{PING:/i.test(message.text), false);
});

test('editing neutralizes nested ping sentinels before mention resolution', async () => {
  let resolverInput;
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', username: 'alice',
    text: 'before', history: [], deleted: false,
    markModified() {}, async save() {}
  };
  const { socket } = registerMessages({
    MessageModel: { findById: async () => message },
    resolvePingsFn: async text => { resolverInput = text; return text; }
  });
  authenticate(socket);
  await socket.trigger('edit_message', {
    id: message._id,
    text: '{{PING:alice|{{PING:bob|Bob}}}}'
  });
  assert.equal(/\{\{PING:/i.test(resolverInput), false);
});

test('chat messages do not persist or emit text expanded beyond two thousand characters', async () => {
  let created = 0;
  const { socket, ioInstance } = registerMessages({
    resolvePingsFn: async () => 'x'.repeat(2001),
    MessageModel: {
      async create(value) {
        created += 1;
        return { ...value, _id: '507f191e810c19729de860ea', timestamp: new Date() };
      }
    }
  });
  authenticate(socket);
  await socket.trigger('chat_message', { text: 'short input' });
  assert.equal(created, 0);
  assert.deepEqual(ioInstance.outbound, []);
});

test('edits do not persist or emit text expanded beyond two thousand characters', async () => {
  let saved = 0;
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', username: 'alice',
    text: 'before', history: [], deleted: false,
    markModified() {}, async save() { saved += 1; }
  };
  const { socket, ioInstance } = registerMessages({
    MessageModel: { findById: async () => message },
    resolvePingsFn: async () => 'x'.repeat(2001)
  });
  authenticate(socket);
  await socket.trigger('edit_message', { id: message._id, text: 'short input' });
  assert.equal(saved, 0);
  assert.equal(message.text, 'before');
  assert.deepEqual(message.history, []);
  assert.deepEqual(ioInstance.outbound, []);
});

test('Blocked edit leaves the saved message and history unchanged without leaking raw text', async () => {
  const blockedText = 'Never Persist ＦＯＲＢＩＤＤＥＮ Edit';
  let saved = 0;
  const audits = [];
  const logged = [];
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', username: 'alice',
    role: 'user', roomRole: 'user', text: 'before', history: [], deleted: false,
    markModified() {}, async save() { saved += 1; }
  };
  const { socket, ioInstance } = registerMessages({
    ChatServerModel: {
      async findOne() {
        return {
          code: 'global', moderators: [],
          autoMod: {
            blockedKeywords: ['forbidden'], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30
          }
        };
      }
    },
    MessageModel: { async findById() { return message; } },
    ModerationAuditModel: { async create(value) { audits.push(value); return value; } },
    logger: { error(...args) { logged.push(args); } }
  });
  authenticate(socket);

  await socket.trigger('edit_message', { id: message._id, text: blockedText });

  assert.equal(saved, 0);
  assert.equal(message.text, 'before');
  assert.deepEqual(message.history, []);
  assert.deepEqual(ioInstance.outbound, []);
  assert.deepEqual(socket.outbound, [{
    target: 'self', event: 'message_blocked',
    payload: { rule: 'content_policy', serverCode: 'global', clientContextId: 1 }
  }]);
  assert.deepEqual(logged, []);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].metadata.rule, 'blocked_keyword');
  assert.match(audits[0].metadata.contentDigest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(audits).includes(blockedText), false);
  assert.equal(JSON.stringify(audits).includes('Never Persist'), false);
});

test('reaction handlers reject non-pictographic permitted sequence characters before lookup', async () => {
  let lookups = 0;
  let saved = 0;
  const { socket, ioInstance } = registerMessages({
    MessageModel: {
      async findById() {
        lookups += 1;
        return { serverCode: 'global', reactions: {}, markModified() {}, async save() { saved += 1; } };
      }
    }
  });
  authenticate(socket);
  for (const emoji of ['\uFE0F', '\u200D', '🏻']) {
    await socket.trigger('toggle_reaction', { id: '507f1f77bcf86cd799439011', emoji });
  }
  assert.equal(lookups, 0);
  assert.equal(saved, 0);
  assert.deepEqual(ioInstance.outbound, []);
});

test('reaction key cardinality allows the twentieth key and rejects the twenty-first', async () => {
  const reactions = Object.fromEntries(Array.from({ length: 19 }, (_, index) => [`😀${'️'.repeat(index)}`, ['bob']]));
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', deleted: false, reactions,
    markModified() {}, async save() {}
  };
  const { socket } = registerMessages({ MessageModel: { async findById() { return message; } } });
  authenticate(socket);
  await socket.trigger('toggle_reaction', { id: message._id, emoji: '👍' });
  assert.equal(Object.keys(message.reactions).length, 20);
  await socket.trigger('toggle_reaction', { id: message._id, emoji: '🔥' });
  assert.equal(Object.keys(message.reactions).length, 20);
  assert.equal(message.reactions['🔥'], undefined);
});

test('reaction user cardinality allows the two-hundredth user and rejects the next', async () => {
  const users = Array.from({ length: 199 }, (_, index) => `user-${index}`);
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', deleted: false,
    reactions: { '👍': users }, markModified() {}, async save() {}
  };
  const { socket } = registerMessages({ MessageModel: { async findById() { return message; } } });
  authenticate(socket);
  await socket.trigger('toggle_reaction', { id: message._id, emoji: '👍' });
  assert.equal(message.reactions['👍'].length, 200);
  socket.username = 'charlie';
  await socket.trigger('toggle_reaction', { id: message._id, emoji: '👍' });
  assert.equal(message.reactions['👍'].length, 200);
  assert.equal(message.reactions['👍'].includes('charlie'), false);
});

test('per-user reaction cardinality allows twenty distinct reactions and rejects the next', async () => {
  const reactions = Object.fromEntries(Array.from({ length: 19 }, (_, index) => [`😀${'️'.repeat(index)}`, ['alice']]));
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', deleted: false, reactions,
    markModified() {}, async save() {}
  };
  const { socket } = registerMessages({ MessageModel: { async findById() { return message; } } });
  authenticate(socket);
  await socket.trigger('toggle_reaction', { id: message._id, emoji: '👍' });
  assert.equal(Object.values(message.reactions).filter(users => users.includes('alice')).length, 20);
  await socket.trigger('toggle_reaction', { id: message._id, emoji: '🔥' });
  assert.equal(message.reactions['🔥'], undefined);
});

test('toggling an existing reaction off remains allowed at every cardinality limit', async () => {
  const reactions = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
    index === 0 ? '👍' : `😀${'️'.repeat(index)}`,
    index === 0 ? ['alice', ...Array.from({ length: 199 }, (_, userIndex) => `user-${userIndex}`)] : ['alice']
  ]));
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', deleted: false, reactions,
    markModified() {}, async save() {}
  };
  const { socket } = registerMessages({ MessageModel: { async findById() { return message; } } });
  authenticate(socket);
  await socket.trigger('toggle_reaction', { id: message._id, emoji: '👍' });
  assert.equal(message.reactions['👍'].includes('alice'), false);
  assert.equal(message.reactions['👍'].length, 199);
});

test('absent rooms cannot receive new messages or orphaned message mutations', async () => {
  let created = 0;
  let saved = 0;
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'alice',
    text: 'before', history: [], deleted: false, reactions: {},
    markModified() {}, async save() { saved += 1; }
  };
  const { socket, ioInstance } = registerMessages({
    ChatServerModel: { async findOne() { return null; } },
    MessageModel: {
      async findById() { return message; },
      async create() { created += 1; }
    }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });

  await socket.trigger('chat_message', { text: 'orphan' });
  await socket.trigger('toggle_reaction', { id: message._id, emoji: '👍' });
  await socket.trigger('edit_message', { id: message._id, text: 'after' });
  await socket.trigger('delete_message', message._id);

  assert.equal(created, 0);
  assert.equal(saved, 0);
  assert.deepEqual(ioInstance.outbound, []);
});

test('room deletion cannot overtake an in-flight reaction persistence', async () => {
  const saveStarted = deferred();
  const releaseSave = deferred();
  const state = { roomExists: true, savedAfterDeletion: false };
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', deleted: false, reactions: {},
    markModified() {},
    async save() {
      saveStarted.resolve();
      await releaseSave.promise;
      state.savedAfterDeletion = !state.roomExists;
    }
  };
  const ChatServerModel = {
    async findOne() {
      return state.roomExists ? { code: 'ABC123', owner: 'alice' } : null;
    },
    async deleteOne() { state.roomExists = false; }
  };
  const MessageModel = {
    async findById() { return message; },
    async deleteMany() {}
  };
  const { socket, ioInstance } = registerMessages({
    ChatServerModel,
    MessageModel,
    UserModel: {
      async findOne() { return { username: 'alice', role: 'admin', servers: ['global', 'ABC123'] }; },
      async updateMany() {}
    }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  socket.role = 'admin';
  socket.joinedRooms.add('ABC123');
  ioInstance.sockets = [socket];

  const reactionPending = socket.trigger('toggle_reaction', { id: message._id, emoji: '👍' });
  await saveStarted.promise;
  const deleteAck = acknowledge();
  const deletionPending = socket.trigger('delete_server', 'ABC123', deleteAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  releaseSave.resolve();
  await Promise.all([reactionPending, deletionPending]);

  assert.equal(state.savedAfterDeletion, false);
  const reactionIndex = ioInstance.outbound.findIndex(item => item.event === 'reaction_updated');
  const deletionIndex = ioInstance.outbound.findIndex(item => item.event === 'server_deleted');
  assert.ok(reactionIndex >= 0);
  assert.ok(deletionIndex > reactionIndex);
});

for (const action of [
  {
    name: 'edit',
    event: 'edit_message',
    payload: { id: '507f1f77bcf86cd799439011', text: 'after' },
    emittedEvent: 'message_edited'
  },
  {
    name: 'message deletion',
    event: 'delete_message',
    payload: '507f1f77bcf86cd799439011',
    emittedEvent: 'message_deleted'
  }
]) {
  test(`room deletion cannot overtake an in-flight ${action.name} persistence`, async () => {
    const saveStarted = deferred();
    const releaseSave = deferred();
    const state = { roomExists: true, savedAfterDeletion: false };
    const message = {
      _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'alice',
      role: 'admin', roomRole: 'user', text: 'before', history: [], deleted: false,
      reactions: {}, markModified() {},
      async save() {
        saveStarted.resolve();
        await releaseSave.promise;
        state.savedAfterDeletion = !state.roomExists;
      }
    };
    const ChatServerModel = {
      async findOne() {
        return state.roomExists ? { code: 'ABC123', owner: 'alice' } : null;
      },
      async deleteOne() { state.roomExists = false; }
    };
    const MessageModel = {
      async findById() { return message; },
      async deleteMany() {}
    };
    const { socket, ioInstance } = registerMessages({
      ChatServerModel,
      MessageModel,
      UserModel: {
        async findOne() { return { username: 'alice', role: 'admin', servers: ['global', 'ABC123'] }; },
        async updateMany() {}
      },
      getRoomRoleFn: async () => 'user'
    });
    authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
    socket.role = 'admin';
    socket.joinedRooms.add('ABC123');
    ioInstance.sockets = [socket];

    const actionPending = socket.trigger(action.event, action.payload);
    await saveStarted.promise;
    const deleteAck = acknowledge();
    const deletionPending = socket.trigger('delete_server', 'ABC123', deleteAck.callback);
    await new Promise(resolve => setImmediate(resolve));
    releaseSave.resolve();
    await Promise.all([actionPending, deletionPending]);

    assert.equal(state.savedAfterDeletion, false);
    const actionIndex = ioInstance.outbound.findIndex(item => item.event === action.emittedEvent);
    const deletionIndex = ioInstance.outbound.findIndex(item => item.event === 'server_deleted');
    assert.ok(actionIndex >= 0);
    assert.ok(deletionIndex > actionIndex);
  });
}

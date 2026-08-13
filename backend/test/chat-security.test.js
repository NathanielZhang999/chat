const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { Server: SocketIoServer } = require('socket.io');

const security = require('../server');
const { FakeSocket, FakeIo, deferred, createMemoryModel } = require('./support/fakes');

const MATRIX_ACTIVE_MESSAGE_ID = '507f1f77bcf86cd799439011';
const MATRIX_DELETED_MESSAGE_ID = '507f1f77bcf86cd799439012';
const MATRIX_REPORT_ID = '507f1f77bcf86cd799439013';

function deepFreezeFixture(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreezeFixture(item);
  return Object.freeze(value);
}

function matrixSuccessAck(acknowledgements, event) {
  assert.equal(acknowledgements.length, 1, `${event}: acknowledgement count`);
  assert.equal(acknowledgements[0] && acknowledgements[0].success, true,
    `${event}: success ${JSON.stringify(acknowledgements[0])}`);
}

const REGISTERED_HANDLER_FIXTURES = Object.freeze([
  {
    event: 'register', shape: 'object', authenticated: false,
    args: [{ username: 'MatrixNew', displayName: 'Matrix New', password: 'new-password' }],
    verify({ acknowledgements, models }) {
      matrixSuccessAck(acknowledgements, 'register');
      assert.equal(models.UserModel.rows.some(user => user.username === 'MatrixNew'), true);
    }
  },
  {
    event: 'login', shape: 'object', authenticated: false,
    args: [{ username: 'Actor', password: 'correct-password' }],
    verify({ acknowledgements, socket }) {
      matrixSuccessAck(acknowledgements, 'login');
      assert.equal(socket.username, 'Actor');
    }
  },
  {
    event: 'change_password', shape: 'object',
    args: [{ oldPassword: 'correct-password', newPassword: 'new-password' }],
    verify({ acknowledgements, models }) {
      matrixSuccessAck(acknowledgements, 'change_password');
      assert.equal(models.UserModel.rows.find(user => user.username === 'Actor').password,
        '$2b$11$new-password');
    }
  },
  {
    event: 'update_preferences', shape: 'object',
    args: [{
      preferences: { theme: 'light', textScale: 112.5, compactMessages: true, motion: 'reduce' },
      expectedVersion: 0
    }],
    verify({ acknowledgements, models }) {
      matrixSuccessAck(acknowledgements, 'update_preferences');
      assert.equal(models.UserModel.rows.find(user => user.username === 'Actor').preferencesVersion, 1);
    }
  },
  {
    event: 'logout_all_devices', shape: 'none', args: [],
    verify({ acknowledgements, remoteActor }) {
      matrixSuccessAck(acknowledgements, 'logout_all_devices');
      assert.equal(remoteActor.disconnected, true);
      assert.equal(remoteActor.outbound.some(item => item.event === 'force_logout'), true);
    }
  },
  {
    event: 'update_profile', shape: 'object',
    args: [{ displayName: 'Matrix Actor', color: '#112233', avatarUrl: 'https://example.com/a.png' }],
    verify({ acknowledgements, models }) {
      matrixSuccessAck(acknowledgements, 'update_profile');
      assert.equal(models.UserModel.rows.find(user => user.username === 'Actor').displayName,
        'Matrix Actor');
    }
  },
  {
    event: 'manage_role', shape: 'object',
    args: [{ action: 'promote_global_admin', targetUser: 'Target' }],
    verify({ acknowledgements, models }) {
      matrixSuccessAck(acknowledgements, 'manage_role');
      assert.equal(models.UserModel.rows.find(user => user.username === 'Target').role, 'admin');
    }
  },
  {
    event: 'moderate_user', shape: 'object',
    args: [{ serverCode: 'ABC123', targetUser: 'Target', action: 'timeout', reason: 'matrix reason', duration: '10m' }],
    verify({ acknowledgements, models }) {
      matrixSuccessAck(acknowledgements, 'moderate_user');
      assert.equal(models.RoomRestrictionModel.rows.some(row =>
        row.serverCode === 'ABC123' && row.username === 'target' && row.timeoutUntil instanceof Date), true);
    }
  },
  {
    event: 'report_moderation_target', shape: 'object',
    args: [{ serverCode: 'ABC123', targetUser: 'Target', reason: 'matrix report', messageId: null }],
    verify({ acknowledgements, models }) {
      matrixSuccessAck(acknowledgements, 'report_moderation_target');
      assert.equal(models.ModerationReportModel.rows.some(row => row.reason === 'matrix report'), true);
    }
  },
  {
    event: 'list_moderation_reports', shape: 'object',
    args: [{ serverCode: 'ABC123', status: 'open', limit: 10 }],
    verify({ acknowledgements, trace }) {
      assert.equal(acknowledgements.length, 1);
      assert.equal(Array.isArray(acknowledgements[0].items), true);
      assert.equal(acknowledgements[0].items[0]._id, MATRIX_REPORT_ID);
      assert.equal(trace.modelCalls > 0, true);
    }
  },
  {
    event: 'resolve_moderation_report', shape: 'object',
    args: [{ serverCode: 'ABC123', reportId: MATRIX_REPORT_ID, status: 'resolved', resolution: 'matrix resolution' }],
    verify({ acknowledgements, models }) {
      matrixSuccessAck(acknowledgements, 'resolve_moderation_report');
      assert.equal(models.ModerationReportModel.rows.find(row => row._id === MATRIX_REPORT_ID).status,
        'resolved');
    }
  },
  {
    event: 'list_room_restrictions', shape: 'object',
    args: [{ serverCode: 'JOIN12', limit: 10 }],
    verify({ acknowledgements, trace }) {
      assert.equal(acknowledgements.length, 1);
      assert.equal(Array.isArray(acknowledgements[0].items), true);
      assert.equal(trace.modelCalls > 0, true);
    }
  },
  {
    event: 'get_moderation_audit', shape: 'object',
    args: [{ serverCode: 'ABC123', limit: 10 }],
    verify({ acknowledgements, trace }) {
      assert.equal(acknowledgements.length, 1);
      assert.equal(Array.isArray(acknowledgements[0].items), true);
      assert.equal(trace.modelCalls > 0, true);
    }
  },
  {
    event: 'get_automod', shape: 'object', args: [{ serverCode: 'ABC123' }],
    verify({ acknowledgements }) {
      assert.equal(acknowledgements.length, 1);
      assert.deepEqual(acknowledgements[0].autoMod.blockedKeywords, []);
    }
  },
  {
    event: 'update_automod', shape: 'object',
    args: [{
      serverCode: 'ABC123', blockedKeywords: ['matrixword'], mentionLimit: 7,
      repeatLimit: 3, repeatWindowSeconds: 30, messageLimit: 6, messageWindowSeconds: 10
    }],
    verify({ acknowledgements, models }) {
      matrixSuccessAck(acknowledgements, 'update_automod');
      assert.deepEqual(models.ChatServerModel.rows.find(room => room.code === 'ABC123').autoMod.blockedKeywords,
        ['matrixword']);
    }
  },
  {
    event: 'create_server', shape: 'scalar', args: ['Matrix Room'],
    verify({ acknowledgements, models }) {
      matrixSuccessAck(acknowledgements, 'create_server');
      assert.equal(models.ChatServerModel.rows.some(room => room.name === 'Matrix Room'), true);
    }
  },
  {
    event: 'join_server', shape: 'scalar', args: ['JOIN12'],
    verify({ acknowledgements, models }) {
      matrixSuccessAck(acknowledgements, 'join_server');
      assert.equal(models.UserModel.rows.find(user => user.username === 'Actor').servers.includes('JOIN12'), true);
    }
  },
  {
    event: 'leave_server', shape: 'scalar', args: ['DEL123'],
    verify({ acknowledgements, models }) {
      matrixSuccessAck(acknowledgements, 'leave_server');
      assert.equal(models.UserModel.rows.find(user => user.username === 'Actor').servers.includes('DEL123'), false);
    }
  },
  {
    event: 'delete_server', shape: 'scalar', args: ['DEL123'],
    verify({ acknowledgements, models }) {
      matrixSuccessAck(acknowledgements, 'delete_server');
      assert.equal(models.ChatServerModel.rows.some(room => room.code === 'DEL123'), false);
    }
  },
  {
    event: 'switch_server', shape: 'scalar', args: ['global'],
    verify({ acknowledgements, socket }) {
      assert.equal(acknowledgements.length, 1);
      assert.equal(Array.isArray(acknowledgements[0].history), true);
      assert.equal(socket.serverCode, 'global');
    }
  },
  {
    event: 'chat_message', shape: 'object',
    args: [{ serverCode: 'ABC123', clientContextId: 1, text: 'matrix chat', attachment: null, replyTo: null }],
    verify({ models, ioInstance, trace, socket }) {
      assert.equal(models.MessageModel.rows.some(message => message.text === 'matrix chat'), true,
        JSON.stringify({
          modelCalls: trace.modelCalls,
          modelWrites: trace.modelWrites,
          logs: trace.logs.map(args => args.map(String)),
          socket: { username: socket.username, role: socket.role, serverCode: socket.serverCode,
            joinedServers: socket.joinedServers },
          user: models.UserModel.rows.find(user => user.username === 'Actor'),
          room: models.ChatServerModel.rows.find(room => room.code === 'ABC123')
        }));
      assert.equal(ioInstance.outbound.some(item => item.event === 'chat_message'), true);
    }
  },
  {
    event: 'toggle_reaction', shape: 'object',
    args: [{ id: MATRIX_ACTIVE_MESSAGE_ID, emoji: '👍', serverCode: 'ABC123', clientContextId: 1 }],
    verify({ models, ioInstance }) {
      assert.deepEqual(models.MessageModel.rows.find(message => message._id === MATRIX_ACTIVE_MESSAGE_ID).reactions,
        { '👍': ['Actor'] });
      assert.equal(ioInstance.outbound.some(item => item.event === 'reaction_updated'), true);
    }
  },
  {
    event: 'edit_message', shape: 'object',
    args: [{ id: MATRIX_ACTIVE_MESSAGE_ID, text: 'matrix edited', serverCode: 'ABC123', clientContextId: 1 }],
    verify({ models, ioInstance }) {
      assert.equal(models.MessageModel.rows.find(message => message._id === MATRIX_ACTIVE_MESSAGE_ID).text,
        'matrix edited');
      assert.equal(ioInstance.outbound.some(item => item.event === 'message_edited'), true);
    }
  },
  {
    event: 'delete_message', shape: 'object',
    args: [{ id: MATRIX_ACTIVE_MESSAGE_ID, serverCode: 'ABC123', clientContextId: 1 }],
    verify({ models, ioInstance }) {
      assert.equal(models.MessageModel.rows.find(message => message._id === MATRIX_ACTIVE_MESSAGE_ID).deleted, true);
      assert.equal(ioInstance.outbound.some(item => item.event === 'message_deleted'), true);
    }
  },
  {
    event: 'get_edit_history', shape: 'scalar', args: [MATRIX_ACTIVE_MESSAGE_ID],
    verify({ acknowledgements }) {
      matrixSuccessAck(acknowledgements, 'get_edit_history');
      assert.deepEqual(acknowledgements[0].history, [{ text: 'matrix previous' }]);
    }
  },
  {
    event: 'get_deleted_message', shape: 'scalar', args: [MATRIX_DELETED_MESSAGE_ID],
    verify({ acknowledgements }) {
      matrixSuccessAck(acknowledgements, 'get_deleted_message');
      assert.equal(acknowledgements[0].text, 'matrix deleted');
    }
  },
  {
    event: 'typing', shape: 'object',
    args: [{ serverCode: 'ABC123', clientContextId: 1, isTyping: true }],
    verify({ socket }) {
      assert.equal(socket.outbound.some(item => item.event === 'typing' && item.payload.isTyping === true), true);
    }
  }
].map(deepFreezeFixture));

function addMatrixMutationMethods(model) {
  if (typeof model.updateMany !== 'function') {
    model.updateMany = async (_query, update) => {
      for (const row of model.rows) {
        if (update.$set) Object.assign(row, update.$set);
        if (update.$pull && update.$pull.servers) {
          row.servers = (Array.isArray(row.servers) ? row.servers : [])
            .filter(code => code !== update.$pull.servers);
        }
      }
      return { matchedCount: model.rows.length, modifiedCount: model.rows.length };
    };
  }
  if (typeof model.deleteOne !== 'function') {
    model.deleteOne = async query => {
      const index = model.rows.findIndex(row => Object.entries(query).every(([key, value]) => row[key] === value));
      if (index >= 0) model.rows.splice(index, 1);
    };
  }
  if (typeof model.deleteMany !== 'function') {
    model.deleteMany = async query => {
      for (let index = model.rows.length - 1; index >= 0; index -= 1) {
        if (Object.entries(query).every(([key, value]) => model.rows[index][key] === value)) {
          model.rows.splice(index, 1);
        }
      }
    };
  }
}

function createRegisteredHandlerFixture(row) {
  const trace = {
    handlerEntries: 0, modelCalls: 0, modelWrites: 0, broadcasts: 0, fetches: 0, logs: []
  };
  const automod = {
    blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30,
    messageLimit: 6, messageWindowSeconds: 10
  };
  const users = [
    {
      username: 'Actor', displayName: 'Actor', password: '$2b$11$actor-hash', role: 'admin',
      color: '', avatarUrl: '', servers: ['global', 'ABC123', 'DEL123'],
      preferences: { theme: 'dark', textScale: 100, compactMessages: false, motion: 'system' },
      preferencesVersion: 0
    },
    {
      username: 'Target', displayName: 'Target', password: '$2b$11$target-hash', role: 'user',
      color: '', avatarUrl: '', servers: ['global', 'ABC123'], preferencesVersion: 0
    }
  ];
  const rooms = [
    { code: 'global', name: 'Global Chat', owner: 'System', moderators: [], autoMod: automod },
    { code: 'ABC123', name: 'Matrix Room', owner: 'Actor', moderators: ['Actor'], autoMod: automod },
    { code: 'JOIN12', name: 'Join Room', owner: 'Target', moderators: [], autoMod: automod },
    { code: 'DEL123', name: 'Delete Room', owner: 'Actor', moderators: ['Actor'], autoMod: automod }
  ];
  const messages = [
    {
      _id: MATRIX_ACTIVE_MESSAGE_ID, serverCode: 'ABC123', username: 'Actor', displayName: 'Actor',
      role: 'admin', roomRole: 'mod', text: 'matrix original', attachment: null,
      history: [{ text: 'matrix previous' }], reactions: {}, deleted: false,
      timestamp: new Date('2026-08-13T12:00:00.000Z')
    },
    {
      _id: MATRIX_DELETED_MESSAGE_ID, serverCode: 'ABC123', username: 'Actor', displayName: 'Actor',
      role: 'admin', roomRole: 'mod', text: 'matrix deleted', attachment: null,
      history: [], reactions: {}, deleted: true, timestamp: new Date('2026-08-13T12:01:00.000Z')
    }
  ];
  const models = {
    UserModel: createMemoryModel(users),
    ChatServerModel: createMemoryModel(rooms),
    MessageModel: createMemoryModel(messages),
    RoomRestrictionModel: createMemoryModel([{
      _id: '507f1f77bcf86cd799439014', serverCode: 'JOIN12', username: 'target',
      bannedAt: new Date('2026-08-13T11:00:00.000Z'), timeoutUntil: null,
      createdAt: new Date('2026-08-13T11:00:00.000Z')
    }]),
    ModerationAuditModel: createMemoryModel([{
      _id: '507f1f77bcf86cd799439015', correlationId: 'matrix-audit', action: 'timeout',
      serverCode: 'ABC123', actorUsername: 'Actor', actorRole: 'admin', actorRoomRole: 'mod',
      targetUsername: 'Target', targetRole: 'user', targetRoomRole: 'user', reason: 'matrix audit',
      createdAt: new Date('2026-08-13T11:30:00.000Z')
    }]),
    ModerationReportModel: createMemoryModel([{
      _id: MATRIX_REPORT_ID, serverCode: 'ABC123', reporterUsername: 'Other', targetUsername: 'Target',
      messageId: null, reason: 'existing report', status: 'open',
      createdAt: new Date('2026-08-13T11:45:00.000Z')
    }])
  };
  for (const model of Object.values(models)) addMatrixMutationMethods(model);
  for (const model of Object.values(models)) {
    for (const method of ['find', 'findOne', 'findById', 'countDocuments']) {
      if (typeof model[method] !== 'function') continue;
      const original = model[method].bind(model);
      model[method] = (...args) => {
        trace.modelCalls += 1;
        return original(...args);
      };
    }
    for (const method of ['create', 'findOneAndUpdate', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany']) {
      if (typeof model[method] !== 'function') continue;
      const original = model[method].bind(model);
      model[method] = (...args) => {
        trace.modelCalls += 1;
        trace.modelWrites += 1;
        return original(...args);
      };
    }
  }

  const ioInstance = new FakeIo();
  const originalFetchSockets = ioInstance.fetchSockets.bind(ioInstance);
  ioInstance.fetchSockets = async () => {
    trace.fetches += 1;
    return originalFetchSockets();
  };
  const socket = new FakeSocket();
  socket.id = 'matrix-actor';
  Object.assign(socket, {
    username: 'Actor', displayName: 'Actor', role: 'admin', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'DEL123'], bannedRooms: [], clientContextId: 1
  });
  socket.joinedRooms.add('ABC123');
  const remoteActor = new FakeSocket();
  Object.assign(remoteActor, {
    id: 'matrix-actor-remote', username: 'Actor', displayName: 'Actor', role: 'admin',
    serverCode: 'global', joinedServers: ['global', 'ABC123'], bannedRooms: []
  });
  const targetSocket = new FakeSocket();
  Object.assign(targetSocket, {
    id: 'matrix-target', username: 'Target', displayName: 'Target', role: 'user',
    serverCode: 'ABC123', joinedServers: ['global', 'ABC123'], bannedRooms: []
  });
  ioInstance.sockets = [socket, remoteActor, targetSocket];
  const onlineUsersMap = new Map([
    [socket.id, {
      username: 'Actor', displayName: 'Actor', role: 'admin', serverCode: 'ABC123',
      joinedServers: ['global', 'ABC123', 'DEL123'], bannedRooms: []
    }],
    [remoteActor.id, {
      username: 'Actor', displayName: 'Actor', role: 'admin', serverCode: 'global',
      joinedServers: ['global', 'ABC123'], bannedRooms: []
    }],
    [targetSocket.id, {
      username: 'Target', displayName: 'Target', role: 'user', serverCode: 'ABC123',
      joinedServers: ['global', 'ABC123'], bannedRooms: []
    }]
  ]);
  const productionDispatcher = security.createSocketEventDispatcher({
    inFlightCoordinator: security.createInFlightRequestCoordinator(),
    securityLogger: { warn(...args) { trace.logs.push(args); } }
  });
  const socketEventDispatcher = {
    dispatch(packet) {
      return productionDispatcher.dispatch({
        ...packet,
        handler: (...args) => {
          trace.handlerEntries += 1;
          return packet.handler(...args);
        }
      });
    },
    cancelSocket(...args) { return productionDispatcher.cancelSocket(...args); }
  };
  security.createConnectionHandler({
    ioInstance,
    ...models,
    onlineUsersMap,
    socketEventDispatcher,
    authLimiter: { attempt() { return { allowed: true, token: Object.freeze({}) }; }, success() {} },
    rateLimiter: { check() { return true; }, clear() {} },
    bcryptImpl: {
      async compare() { return true; },
      getRounds() { return 11; },
      async hash(value) { return `$2b$11$${value}`; }
    },
    dummyPasswordHash: '$2b$11$matrix-dummy-hash',
    readRawPreferencesVersionFn: async () => ({ exists: true, value: 0 }),
    autoModTracker: security.createAutoModTracker(),
    broadcastOnlineUsersFn() { trace.broadcasts += 1; },
    getRoomRoleFn: async () => 'mod',
    resolvePingsFn: async text => text,
    logger: { error(...args) { trace.logs.push(args); } }
  })(socket);
  if (row.authenticated === false) {
    delete socket.username;
    delete socket.displayName;
    delete socket.role;
    socket.serverCode = null;
    socket.joinedServers = [];
    onlineUsersMap.delete(socket.id);
  } else {
    Object.assign(socket, {
      username: 'Actor', displayName: 'Actor', role: 'admin', serverCode: 'ABC123',
      joinedServers: ['global', 'ABC123', 'DEL123'], bannedRooms: [], clientContextId: 1
    });
    socket.joinedRooms.add('ABC123');
  }
  return {
    row, trace, models, socket, ioInstance, onlineUsersMap, remoteActor, targetSocket
  };
}

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

test('client address resolver trusts only explicitly enabled valid leftmost forwarding', () => {
  assert.equal(typeof security.createClientAddressResolver, 'function');
  const peer = '192.0.2.200';
  const socketFor = forwarded => ({
    handshake: { address: peer, headers: { 'x-forwarded-for': forwarded } },
    request: { headers: { 'x-forwarded-for': forwarded }, socket: { remoteAddress: peer } }
  });
  const trusted = security.createClientAddressResolver({ trustProxy: true });
  const untrusted = security.createClientAddressResolver({ trustProxy: false });

  assert.equal(trusted(socketFor(' 203.0.113.8 , 198.51.100.2, 198.51.100.3 ')), '203.0.113.8');
  assert.equal(trusted(socketFor('::ffff:203.0.113.9, 198.51.100.2')), '203.0.113.9');
  assert.equal(trusted(socketFor('2001:db8::8, 198.51.100.2')), '2001:db8::8');
  assert.equal(untrusted(socketFor('203.0.113.8')), peer);

  for (const forwarded of [
    '', ' , 203.0.113.8', 'not-an-ip, 203.0.113.8',
    '::ffff:not-an-ip, 203.0.113.8', ['203.0.113.8'], 'x'.repeat(1_025)
  ]) {
    assert.equal(trusted(socketFor(forwarded)), peer, JSON.stringify(forwarded));
  }
});

test('Render runtime proxy trust requires the exact platform marker', () => {
  assert.equal(typeof security.isTrustedRenderRuntime, 'function');
  assert.equal(security.isTrustedRenderRuntime({ RENDER: 'true' }), true);
  for (const value of [undefined, '', 'false', 'TRUE', true, '1']) {
    assert.equal(security.isTrustedRenderRuntime({ RENDER: value }), false, String(value));
  }
});

test('deployment network composition injects one Render-aware resolver into every network owner', () => {
  assert.equal(typeof security.createDeploymentNetworkSecurity, 'function');
  const eventBudgetController = {};
  const inFlightCoordinator = {};
  const captured = {};
  const connectionAdmission = {};
  const socketEventDispatcher = {};
  const composition = security.createDeploymentNetworkSecurity({
    environment: { RENDER: 'true' },
    eventBudgetController,
    inFlightCoordinator,
    createConnectionAdmissionFn(options) {
      captured.admission = options;
      return connectionAdmission;
    },
    createSocketEventDispatcherFn(options) {
      captured.dispatcher = options;
      return socketEventDispatcher;
    }
  });

  assert.equal(composition.connectionAdmission, connectionAdmission);
  assert.equal(composition.socketEventDispatcher, socketEventDispatcher);
  assert.equal(captured.admission.clientAddressResolver, composition.clientAddressResolver);
  assert.equal(captured.dispatcher.clientAddressResolver, composition.clientAddressResolver);
  assert.equal(captured.dispatcher.eventBudgetController, eventBudgetController);
  assert.equal(captured.dispatcher.inFlightCoordinator, inFlightCoordinator);
  const renderSocket = {
    handshake: { address: '10.0.0.7', headers: { 'x-forwarded-for': '203.0.113.44' } },
    request: { headers: { 'x-forwarded-for': '203.0.113.44' } }
  };
  assert.equal(composition.clientAddressResolver(renderSocket), '203.0.113.44');

  const direct = security.createDeploymentNetworkSecurity({
    environment: { RENDER: 'false' },
    createConnectionAdmissionFn: () => ({}),
    createSocketEventDispatcherFn: () => ({})
  });
  assert.equal(direct.clientAddressResolver(renderSocket), '10.0.0.7');

  const source = fs.readFileSync(require.resolve('../server'), 'utf8');
  const productionOwners = source.slice(
    source.indexOf('const authNetworkSalt'),
    source.indexOf('// --- DATABASE SCHEMAS ---')
  );
  assert.match(productionOwners,
    /createDeploymentNetworkSecurity\(\{[\s\S]*environment:\s*process\.env[\s\S]*eventBudgetController:\s*serverEventBudgetController[\s\S]*inFlightCoordinator:\s*serverInFlightCoordinator/);
  assert.match(productionOwners,
    /productionNetworkSecurity\.connectionAdmission\.prune\(\)/,
    'periodic cleanup targets the composed admission owner');
  assert.doesNotMatch(productionOwners,
    /serverConnectionAdmission|serverSocketEventDispatcher|productionClientAddressResolver/);
  const installation = source.slice(
    source.indexOf('function installDefaultConnectionHandler'),
    source.indexOf('const PORT')
  );
  assert.match(installation,
    /connectionAdmission:\s*productionNetworkSecurity\.connectionAdmission/);
  assert.match(installation,
    /socketEventDispatcher:\s*productionNetworkSecurity\.socketEventDispatcher/);
  assert.match(installation,
    /clientAddressResolver:\s*productionNetworkSecurity\.clientAddressResolver/);
});

test('trusted proxy network limits separate clients and preserve shared NAT boundaries', () => {
  const resolver = security.createClientAddressResolver({ trustProxy: true });
  const socketFor = (peer, forwarded) => ({
    handshake: { address: peer, headers: { 'x-forwarded-for': forwarded } },
    request: { headers: { 'x-forwarded-for': forwarded }, socket: { remoteAddress: peer } }
  });

  let now = 0;
  const attempts = security.createConnectionAdmission({
    now: () => now,
    salt: 'trusted-proxy-attempt-boundary',
    clientAddressResolver: resolver
  });
  for (let index = 0; index < 60; index += 1) {
    const admitted = attempts.open(socketFor('10.0.0.7', '203.0.113.10, 10.0.0.6'));
    assert.equal(admitted.allowed, true, `client A attempt ${index + 1}`);
    attempts.release(admitted.token);
  }
  assert.equal(attempts.open(socketFor('10.0.0.7', '203.0.113.10')).allowed, false);
  const independent = attempts.open(socketFor('10.0.0.7', '203.0.113.11'));
  assert.equal(independent.allowed, true, 'distinct clients behind one Render peer stay independent');
  attempts.release(independent.token);

  const concurrent = security.createConnectionAdmission({
    now: () => now,
    salt: 'trusted-proxy-concurrent-boundary',
    clientAddressResolver: resolver
  });
  const sharedNatTokens = [];
  for (let index = 0; index < 100; index += 1) {
    if (index === 60) now = 60_000;
    const admitted = concurrent.open(socketFor(`10.0.1.${index + 1}`, '198.51.100.44'));
    assert.equal(admitted.allowed, true, `shared NAT socket ${index + 1}`);
    sharedNatTokens.push(admitted.token);
  }
  assert.equal(concurrent.open(socketFor('10.0.2.250', '198.51.100.44')).allowed, false);
  assert.equal(concurrent.open(socketFor('10.0.2.250', '198.51.100.45')).allowed, true);

  const auth = security.createLayeredAuthLimiter({ salt: 'trusted-proxy-auth-boundary' });
  for (let index = 0; index < 6; index += 1) {
    assert.equal(auth.attempt({
      action: 'login', account: 'Alice',
      address: resolver(socketFor(`10.1.0.${index + 1}`, '192.0.2.88'))
    }).allowed, true, `pair attempt ${index + 1}`);
  }
  assert.equal(auth.attempt({
    action: 'login', account: 'Alice',
    address: resolver(socketFor('10.1.0.250', '192.0.2.88'))
  }).allowed, false);

  const aggregate = security.createLayeredAuthLimiter({ salt: 'trusted-proxy-aggregate-boundary' });
  for (let index = 0; index < 300; index += 1) {
    assert.equal(aggregate.attempt({
      action: 'login', account: `account-${index}`,
      address: resolver(socketFor('10.2.0.9', '192.0.2.99'))
    }).allowed, true, `aggregate attempt ${index + 1}`);
  }
  assert.equal(aggregate.attempt({
    action: 'login', account: 'account-300',
    address: resolver(socketFor('10.2.0.9', '192.0.2.99'))
  }).allowed, false);
});

test('network consumers receive one resolved address and telemetry never exposes raw sentinels', async () => {
  const forwardedSentinel = '203.0.113.252';
  const peerSentinel = '192.0.2.252';
  const socket = new FakeSocket();
  socket.handshake.address = peerSentinel;
  socket.handshake.headers['x-forwarded-for'] = forwardedSentinel;
  const resolverCalls = [];
  const resolver = candidate => {
    resolverCalls.push(candidate);
    return forwardedSentinel;
  };
  const authAttempts = [];
  const rateKeys = [];
  const logs = [];
  const dispatcher = security.createSocketEventDispatcher({
    clientAddressResolver: resolver,
    securityLogger: { warn(...args) { logs.push(args); } }
  });
  security.createConnectionHandler({
    clientAddressResolver: resolver,
    authLimiter: {
      attempt(value) {
        authAttempts.push(value);
        return value.action === 'login'
          ? { allowed: false }
          : { allowed: true, token: {} };
      },
      success() {}
    },
    rateLimiter: {
      check(value) { rateKeys.push(value); return false; },
      clear() {}
    },
    socketEventDispatcher: dispatcher,
    ioInstance: new FakeIo(),
    onlineUsersMap: new Map(),
    broadcastOnlineUsersFn() {}
  })(socket);

  const registerAck = [];
  await socket.trigger('register', {
    username: 'NYZhang1', displayName: 'Owner', password: '123456'
  }, value => registerAck.push(value));
  socket.username = 'Alice';
  const passwordAck = [];
  await socket.trigger('change_password', {
    oldPassword: 'old-password', newPassword: 'new-password'
  }, value => passwordAck.push(value));
  socket.username = null;
  const loginAck = [];
  await socket.trigger('login', {
    username: 'Alice', password: 'private-password'
  }, value => loginAck.push(value));
  await socket.trigger('login', {
    username: 'Alice', password: 'private-password', unexpected: true
  }, () => {});

  assert.deepEqual(authAttempts.map(attempt => [attempt.action, attempt.address]), [
    ['register', forwardedSentinel],
    ['login', forwardedSentinel]
  ]);
  assert.equal(rateKeys.length, 1);
  assert.match(rateKeys[0], /^change_password:alice:[0-9a-f]{16}$/);
  assert.equal(resolverCalls.every(candidate => candidate === socket), true);
  const serialized = JSON.stringify({ registerAck, passwordAck, loginAck, logs, rateKeys });
  assert.equal(serialized.includes(forwardedSentinel), false);
  assert.equal(serialized.includes(peerSentinel), false);
  assert.match(logs[0][1].networkBucket, /^[0-9a-f]{16}$/);
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

test('configured origins reject forbidden lexical syntax before URL canonicalization', () => {
  const accepted = [
    ['https://chat.example.com', 'https://chat.example.com'],
    ['https://chat.example.com/', 'https://chat.example.com'],
    ['https://chat.example.com:8443/', 'https://chat.example.com:8443'],
    ['http://[2001:db8::1]:8080', 'http://[2001:db8::1]:8080'],
    ['HTTPS://CHAT.EXAMPLE.COM', 'https://chat.example.com']
  ];
  for (const [raw, canonical] of accepted) {
    assert.equal(security.normalizeConfiguredOrigin(raw), canonical, raw);
  }

  const rejected = [
    'https://example.com?',
    'https://example.com#',
    'https://@example.com',
    'https://:@example.com',
    'https://example.com\\',
    'https:\\example.com',
    'https://example.com/.',
    'https://example.com/..',
    'https://example.com/a/..',
    'https://example.com/%2e',
    'https://example.com//',
    'https://exa\tmple.com',
    'https://exa\nmple.com',
    'https://exa\rmple.com'
  ];
  for (const raw of rejected) {
    assert.equal(security.normalizeConfiguredOrigin(raw), null, JSON.stringify(raw));
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

test('production loopback origins fail configuration and remain defensively rejected at runtime', async () => {
  const loopbackOrigins = [
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://127.42.9.8:8080',
    'http://[::1]:3000',
    'http://[::ffff:127.0.0.1]:3000',
    'http://[::ffff:127.42.9.8]:8080',
    'http://[::ffff:7f00:1]:3000'
  ];

  for (const origin of loopbackOrigins) {
    const policy = security.createOriginPolicy({
      allowedOriginsValue: origin,
      production: true
    });
    assert.throws(policy.assertValid, /ALLOWED_ORIGINS/i, origin);
    assert.equal(policy.allows(origin), false, `${origin} runtime`);

    const events = [];
    await assert.rejects(
      security.start({
        mongoUri: 'mongodb://database/chat',
        mongooseImpl: { async connect() { events.push('connect'); } },
        seedSystemFn: async () => { events.push('seed'); },
        serverInstance: { listen() { events.push('listen'); } },
        validateSecurityConfigurationFn: policy.assertValid
      }),
      /ALLOWED_ORIGINS/i,
      origin
    );
    assert.deepEqual(events, [], origin);
  }

  const defensiveRuntimePolicy = security.createOriginPolicy({
    allowedOriginsValue: 'https://chat.example.com',
    production: true
  });
  defensiveRuntimePolicy.assertValid();
  for (const origin of loopbackOrigins) {
    defensiveRuntimePolicy.origins.push(security.normalizeConfiguredOrigin(origin));
    assert.equal(defensiveRuntimePolicy.allows(origin), false, `${origin} defensive runtime`);
  }

  const development = security.createOriginPolicy({
    allowedOriginsValue: loopbackOrigins.join(','),
    production: false
  });
  development.assertValid();
  for (const origin of loopbackOrigins) assert.equal(development.allows(origin), true, origin);

  const publicIpv6 = security.createOriginPolicy({
    allowedOriginsValue: 'https://[2001:db8::8]:8443',
    production: true
  });
  publicIpv6.assertValid();
  assert.equal(publicIpv6.allows('https://[2001:db8::8]:8443'), true);

  const source = fs.readFileSync(require.resolve('../server'), 'utf8');
  const startComposition = source.slice(
    source.indexOf('async function start'),
    source.indexOf('if (require.main === module)')
  );
  assert.match(startComposition,
    /validateSecurityConfigurationFn\s*=\s*originPolicy\.assertValid/,
    'deployed startup defaults to the configured production origin policy');
  assert.match(startComposition,
    /validateSecurityConfigurationFn\(\);[\s\S]*mongooseImpl\.connect/,
    'default validation remains before Mongo connection');
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

const REQUIRED_ENGINE_SECURITY_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cross-origin-resource-policy': 'same-site'
});

function listenOnLoopback(serverInstance) {
  return new Promise((resolve, reject) => {
    serverInstance.once('error', reject);
    serverInstance.listen(0, '127.0.0.1', () => {
      serverInstance.removeListener('error', reject);
      resolve(serverInstance.address().port);
    });
  });
}

function requestEnginePolling(port, origin) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: `/socket.io/?EIO=4&transport=polling&t=${Date.now()}`,
      headers: { Origin: origin }
    }, response => {
      response.resume();
      response.once('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers
      }));
    });
    request.setTimeout(2_000, () => request.destroy(new Error('polling handshake timed out')));
    request.once('error', reject);
    request.end();
  });
}

function requestEngineWebSocketUpgrade(port, origin) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/socket.io/?EIO=4&transport=websocket',
      headers: {
        Origin: origin,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': Buffer.from('engine-security!').toString('base64'),
        'Sec-WebSocket-Version': '13'
      }
    });
    request.setTimeout(2_000, () => request.destroy(new Error('WebSocket upgrade timed out')));
    request.once('upgrade', (response, socket) => {
      const result = { statusCode: response.statusCode, headers: response.headers };
      socket.destroy();
      resolve(result);
    });
    request.once('response', response => {
      response.resume();
      response.once('end', () => reject(new Error(`expected WebSocket 101, received ${response.statusCode}`)));
    });
    request.once('error', reject);
    request.end();
  });
}

test('Engine.IO security configuration attaches both supported response header hooks', () => {
  const hooks = new Map();
  security.configureEngineSecurity({
    ioInstance: {
      engine: {
        on(name, handler) {
          assert.equal(hooks.has(name), false, name);
          hooks.set(name, handler);
        }
      }
    },
    production: true
  });
  assert.deepEqual([...hooks.keys()], ['initial_headers', 'headers']);
  for (const [name, handler] of hooks) {
    const headers = {};
    handler(headers);
    assert.equal(headers['X-Content-Type-Options'], 'nosniff', name);
    assert.equal(
      headers['Strict-Transport-Security'],
      'max-age=31536000; includeSubDomains',
      name
    );
  }
});

test('deployed Engine.IO instance carries the shared security header hooks', () => {
  for (const name of ['initial_headers', 'headers']) {
    const listeners = security.io.engine.listeners(name);
    assert.equal(listeners.length, 1, name);
    const headers = {};
    listeners[0](headers);
    assert.equal(headers['X-Content-Type-Options'], 'nosniff', name);
    assert.equal(headers['Referrer-Policy'], 'no-referrer', name);
    assert.equal(headers['X-Frame-Options'], 'DENY', name);
    assert.equal(headers['Permissions-Policy'], 'camera=(), microphone=(), geolocation=()', name);
    assert.equal(headers['Cross-Origin-Resource-Policy'], 'same-site', name);
    assert.equal(Object.prototype.hasOwnProperty.call(headers, 'Content-Security-Policy'), false);
  }
  const source = fs.readFileSync(require.resolve('../server'), 'utf8');
  assert.match(source,
    /configureEngineSecurity\(\{\s*ioInstance:\s*io,\s*production:\s*isProduction\s*\}\)/);
});

test('Engine.IO polling and WebSocket upgrades receive exact security headers in development and production', async (t) => {
  assert.equal(typeof security.configureEngineSecurity, 'function');

  for (const production of [false, true]) {
    await t.test(production ? 'production' : 'development', async t => {
      const allowedOrigin = 'https://transport.example.test';
      const observedOrigins = [];
      const serverInstance = http.createServer();
      const ioInstance = new SocketIoServer(serverInstance, {
        cors: { origin: allowedOrigin },
        allowRequest(request, callback) {
          observedOrigins.push(request.headers.origin);
          callback(null, request.headers.origin === allowedOrigin);
        }
      });
      security.configureEngineSecurity({ ioInstance, production });
      const port = await listenOnLoopback(serverInstance);
      t.after(async () => {
        await new Promise(resolve => ioInstance.close(resolve));
        if (serverInstance.listening) {
          await new Promise(resolve => serverInstance.close(resolve));
        }
      });

      const polling = await requestEnginePolling(port, allowedOrigin);
      const websocket = await requestEngineWebSocketUpgrade(port, allowedOrigin);

      assert.equal(polling.statusCode, 200);
      assert.equal(websocket.statusCode, 101);
      assert.deepEqual(observedOrigins, [allowedOrigin, allowedOrigin]);
      for (const response of [polling, websocket]) {
        assert.equal(response.headers['access-control-allow-origin'], allowedOrigin);
        for (const [name, value] of Object.entries(REQUIRED_ENGINE_SECURITY_HEADERS)) {
          assert.equal(response.headers[name], value, `${name} on ${response.statusCode}`);
        }
        assert.equal(Object.prototype.hasOwnProperty.call(response.headers, 'content-security-policy'), false);
        if (production) {
          assert.equal(
            response.headers['strict-transport-security'],
            'max-age=31536000; includeSubDomains'
          );
        } else {
          assert.equal(Object.prototype.hasOwnProperty.call(response.headers, 'strict-transport-security'), false);
        }
      }
    });
  }
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

  await t.test('exported Socket.IO boundary executes the production allowRequest policy', () => {
    const allowRequest = security.io && security.io.opts && security.io.opts.allowRequest;
    assert.equal(typeof allowRequest, 'function');
    assert.equal(allowRequest, security.originPolicy.allowSocketRequest);
    const exactOrigin = security.originPolicy.origins[0];
    assert.equal(typeof exactOrigin, 'string');
    const rows = [
      { name: 'exact', headers: { origin: exactOrigin }, allowed: true },
      { name: 'hostile', headers: { origin: `${exactOrigin}.evil.invalid` }, allowed: false },
      { name: 'missing', headers: {}, allowed: false }
    ];
    for (const row of rows) {
      const calls = [];
      allowRequest({ headers: row.headers }, (...args) => calls.push(args));
      assert.deepEqual(calls, [[null, row.allowed]], row.name);
    }
  });

  await t.test('literal all-27 fixtures reach real registered handlers and reject before private work', async () => {
    const literalEventNames = [
      'register', 'login', 'change_password', 'update_preferences', 'logout_all_devices',
      'update_profile', 'manage_role', 'moderate_user', 'report_moderation_target',
      'list_moderation_reports', 'resolve_moderation_report', 'list_room_restrictions',
      'get_moderation_audit', 'get_automod', 'update_automod', 'create_server', 'join_server',
      'leave_server', 'delete_server', 'switch_server', 'chat_message', 'toggle_reaction',
      'edit_message', 'delete_message', 'get_edit_history', 'get_deleted_message', 'typing'
    ];
    assert.deepEqual(REGISTERED_HANDLER_FIXTURES.map(row => row.event), literalEventNames);
    assert.equal(Object.isFrozen(REGISTERED_HANDLER_FIXTURES), true);
    assert.equal(REGISTERED_HANDLER_FIXTURES.every(row => Object.isFrozen(row) && Object.isFrozen(row.args)), true);

    for (const row of REGISTERED_HANDLER_FIXTURES) {
      const admitted = createRegisteredHandlerFixture(row);
      assert.equal(admitted.socket.handlers.has(row.event), true, `${row.event}: registered`);
      const acknowledgements = [];
      await admitted.socket.trigger(
        row.event,
        ...row.args,
        value => acknowledgements.push(value)
      );
      assert.equal(admitted.trace.handlerEntries, 1, `${row.event}: real handler entry`);
      row.verify({ ...admitted, acknowledgements });

      const denied = createRegisteredHandlerFixture(row);
      assert.equal(denied.socket.handlers.has(row.event), true, `${row.event}: denial registered`);
      const privateMarker = `matrix-private-${row.event}`;
      const invalidPayload = row.shape === 'object'
        ? { ...row.args[0], unexpectedPrivateField: privateMarker }
        : (row.shape === 'scalar' ? { unexpectedPrivateField: privateMarker } : privateMarker);
      const deniedAcks = [];
      const beforeRows = JSON.stringify(Object.fromEntries(
        Object.entries(denied.models).map(([name, model]) => [name, model.rows])
      ));
      await denied.socket.trigger(row.event, invalidPayload, value => deniedAcks.push(value));
      assert.equal(denied.trace.handlerEntries, 0, `${row.event}: denied handler entry`);
      assert.equal(denied.trace.modelCalls, 0, `${row.event}: denied model work`);
      assert.equal(denied.trace.modelWrites, 0, `${row.event}: denied model writes`);
      assert.equal(denied.trace.broadcasts, 0, `${row.event}: denied broadcasts`);
      assert.equal(denied.trace.fetches, 0, `${row.event}: denied socket discovery`);
      assert.deepEqual(deniedAcks, [{ error: 'Invalid input format.' }], `${row.event}: generic denial`);
      assert.equal(JSON.stringify(Object.fromEntries(
        Object.entries(denied.models).map(([name, model]) => [name, model.rows])
      )), beforeRows, `${row.event}: denied persistence`);
      assert.deepEqual(denied.socket.outbound, [], `${row.event}: denied socket events`);
      assert.deepEqual(denied.ioInstance.outbound, [], `${row.event}: denied room events`);
      assert.deepEqual(denied.remoteActor.outbound, [], `${row.event}: denied remote events`);
      assert.equal(JSON.stringify({ logs: denied.trace.logs, acks: deniedAcks }).includes(privateMarker),
        false, `${row.event}: private marker`);
    }
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

  });

  await t.test('stale same-ID disconnect cleanup cannot release the newer in-flight owner', async () => {
    const timers = [];
    const coordinator = security.createInFlightRequestCoordinator({
      schedule(callback) {
        const timer = { callback, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearSchedule() {}
    });
    const productionDispatcher = security.createSocketEventDispatcher({
      inFlightCoordinator: coordinator,
      securityLogger: { warn() {} }
    });
    const owners = new Map();
    const connectionDispatcher = {
      dispatch(packet) {
        owners.set(packet.socket, packet.ownerToken);
        return productionDispatcher.dispatch(packet);
      },
      cancelSocket(...args) { return productionDispatcher.cancelSocket(...args); }
    };
    const connect = socket => security.createConnectionHandler({
      socketEventDispatcher: connectionDispatcher,
      ioInstance: new FakeIo(),
      onlineUsersMap: new Map(),
      broadcastOnlineUsersFn() {},
      logger: { error() {} }
    })(socket);

    const oldSocket = new FakeSocket();
    const newerSocket = new FakeSocket();
    oldSocket.id = 'matrix-reused-id';
    newerSocket.id = 'matrix-reused-id';
    connect(oldSocket);
    connect(newerSocket);
    await oldSocket.trigger('login', {}, () => {});
    await newerSocket.trigger('login', {}, () => {});

    const oldStarted = deferred();
    const releaseOld = deferred();
    const oldRequest = productionDispatcher.dispatch({
      socket: oldSocket,
      ownerToken: owners.get(oldSocket),
      event: 'switch_server',
      args: ['global'],
      handler: async () => { oldStarted.resolve(); await releaseOld.promise; }
    });
    await oldStarted.promise;
    assert.equal(coordinator.size(), 1);
    timers[0].callback();
    assert.equal(coordinator.size(), 0, 'safety timeout releases only the old token');

    const newerStarted = deferred();
    const releaseNewer = deferred();
    const newerRequest = productionDispatcher.dispatch({
      socket: newerSocket,
      ownerToken: owners.get(newerSocket),
      event: 'switch_server',
      args: ['global'],
      handler: async () => { newerStarted.resolve(); await releaseNewer.promise; }
    });
    await newerStarted.promise;
    assert.equal(coordinator.size(), 1);

    await oldSocket.trigger('disconnect');
    let staleDuplicateEntries = 0;
    const staleDuplicateAcks = [];
    await productionDispatcher.dispatch({
      socket: newerSocket,
      ownerToken: owners.get(newerSocket),
      event: 'switch_server',
      args: ['global', value => staleDuplicateAcks.push(value)],
      handler: async () => { staleDuplicateEntries += 1; }
    });
    assert.equal(staleDuplicateEntries, 0);
    assert.deepEqual(staleDuplicateAcks, [{ error: 'Request already in progress.' }]);
    assert.equal(coordinator.size(), 1);

    releaseOld.resolve();
    await oldRequest;
    assert.equal(coordinator.size(), 1, 'old completion cannot finish the newer token');
    releaseNewer.resolve();
    await newerRequest;
    assert.equal(coordinator.size(), 0);

    const normalSocket = new FakeSocket();
    normalSocket.id = 'matrix-normal-disconnect';
    connect(normalSocket);
    await normalSocket.trigger('login', {}, () => {});
    const normalStarted = deferred();
    const releaseNormal = deferred();
    const normalRequest = productionDispatcher.dispatch({
      socket: normalSocket,
      ownerToken: owners.get(normalSocket),
      event: 'switch_server',
      args: ['global'],
      handler: async () => { normalStarted.resolve(); await releaseNormal.promise; }
    });
    await normalStarted.promise;
    assert.equal(coordinator.size(), 1);
    await normalSocket.trigger('disconnect');
    assert.equal(coordinator.size(), 0, 'normal disconnect releases its exact owner');
    releaseNormal.resolve();
    await normalRequest;
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

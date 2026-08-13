const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAutoModTracker,
  createConnectionHandler,
  createSocketEventDispatcher,
  measurePayloadBytes
} = require('../server');
const { FakeSocket, FakeIo, acknowledge, deferred } = require('./support/fakes');

function registerMessages(overrides = {}) {
  const { dispatchPacket, ...handlerOverrides } = overrides;
  const socket = new FakeSocket({ dispatchPacket });
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
    autoModTracker: createAutoModTracker(),
    ...handlerOverrides
  })(socket);
  return { socket, ioInstance };
}

function authenticate(socket, { serverCode = 'global', joinedServers = ['global'] } = {}) {
  socket.username = 'alice';
  socket.displayName = 'Alice';
  socket.role = 'user';
  socket.serverCode = serverCode;
  socket.joinedServers = joinedServers;
}

test('FakeSocket dispatcher can reject a packet before its registered handler', async () => {
  let handlerCalls = 0;
  const socket = new FakeSocket({
    dispatchPacket({ event }) {
      return { allowed: false, event };
    }
  });
  socket.on('protected_event', () => {
    handlerCalls += 1;
    return { allowed: true };
  });

  assert.deepEqual(await socket.trigger('protected_event', { secret: true }), {
    allowed: false,
    event: 'protected_event'
  });
  assert.equal(handlerCalls, 0);
});

test('socket envelopes reject unknown events extra fields cycles depth and item overflow before handlers', async () => {
  const dispatcher = createSocketEventDispatcher({ securityLogger: { warn() {} } });
  const socket = new FakeSocket({ dispatchPacket: dispatcher.dispatch });
  let handlerCalls = 0;
  const handler = () => { handlerCalls += 1; };
  const results = [];
  const callback = result => results.push(result);
  const cyclic = {};
  cyclic.self = cyclic;
  const tooDeep = { a: { b: { c: { d: { e: true } } } } };

  await dispatcher.dispatch({
    socket,
    event: 'unknown_event',
    args: [{ value: true }, callback],
    handler
  });
  for (const [event, payload] of [
    ['login', { username: 'alice', password: 'correct-password', secret: 'private' }],
    ['login', { username: cyclic, password: 'correct-password' }],
    ['update_preferences', { preferences: tooDeep, expectedVersion: 0 }],
    ['update_preferences', { preferences: Array.from({ length: 101 }, () => 0), expectedVersion: 0 }]
  ]) {
    socket.on(event, handler);
    await socket.trigger(event, payload, callback);
  }
  socket.on('chat_message', handler);
  await socket.trigger('chat_message', {
    serverCode: 'global', clientContextId: 1, text: 'silent', unexpected: true
  });

  assert.equal(handlerCalls, 0);
  assert.deepEqual(results, Array.from({ length: 5 }, () => ({ error: 'Invalid input format.' })));
});

test('socket proxy traps fail closed with one generic callback and bounded telemetry', async () => {
  const logs = [];
  const dispatcher = createSocketEventDispatcher({
    securityLogger: { warn(...args) { logs.push(args); } }
  });
  const socket = new FakeSocket({ dispatchPacket: dispatcher.dispatch });
  let handlerCalls = 0;
  socket.on('login', () => { handlerCalls += 1; });
  const privateSentinel = 'PrivateProxyPayloadSentinel';
  const hostilePayloads = [
    ['prototype', new Proxy({ username: privateSentinel, password: 'private-password' }, {
      getPrototypeOf() { throw new Error(`prototype-${privateSentinel}`); }
    })],
    ['ownKeys', new Proxy({ username: privateSentinel, password: 'private-password' }, {
      ownKeys() { throw new Error(`ownKeys-${privateSentinel}`); }
    })],
    ['descriptor', new Proxy({ username: privateSentinel, password: 'private-password' }, {
      getOwnPropertyDescriptor() { throw new Error(`descriptor-${privateSentinel}`); }
    })]
  ];
  const callbackCounts = new Map();
  const callbackValues = new Map();

  for (const [label, payload] of hostilePayloads) {
    callbackCounts.set(label, 0);
    assert.equal(measurePayloadBytes(payload, { maxBytes: 8_192 }), null, label);
    await assert.doesNotReject(socket.trigger('login', payload, value => {
      callbackCounts.set(label, callbackCounts.get(label) + 1);
      callbackValues.set(label, value);
    }), label);
  }

  assert.equal(handlerCalls, 0);
  assert.deepEqual([...callbackCounts.values()], [1, 1, 1]);
  assert.deepEqual([...callbackValues.values()], Array.from({ length: 3 }, () => ({
    error: 'Invalid input format.'
  })));
  assert.equal(logs.length, 3);
  for (const [message, metadata] of logs) {
    assert.equal(message, 'payload_rejected');
    assert.deepEqual(Object.keys(metadata).sort(), ['category', 'event', 'networkBucket']);
    assert.equal(metadata.event, 'login');
    assert.equal(metadata.category, 'auth');
    assert.match(metadata.networkBucket, /^[0-9a-f]{16}$/);
  }
  assert.equal(JSON.stringify(logs).includes(privateSentinel), false);
  assert.equal(JSON.stringify([...callbackValues.values()]).includes(privateSentinel), false);
});

test('maximum valid chat attachment still reaches existing validation while oversized control data does no work', async () => {
  const dispatcher = createSocketEventDispatcher({ securityLogger: { warn() {} } });
  const attachmentPrefix = 'data:image/png;base64,';
  const attachment = attachmentPrefix + 'A'.repeat(8_000_000 - attachmentPrefix.length);
  let creates = 0;
  const { socket } = registerMessages({
    dispatchPacket: dispatcher.dispatch,
    MessageModel: {
      async create(value) {
        creates += 1;
        return { ...value, _id: '507f1f77bcf86cd799439011', timestamp: new Date(0) };
      }
    }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });

  await socket.trigger('chat_message', { text: '', attachment });

  assert.equal(creates, 1);

  const validLoginUser = {
    username: 'Alice', displayName: 'Alice', password: '$2b$11$current-hash', role: 'user',
    color: '', avatarUrl: '', servers: ['global']
  };
  const { socket: loginSocket } = registerMessages({
    dispatchPacket: dispatcher.dispatch,
    UserModel: { async findOne() { return validLoginUser; } },
    ChatServerModel: {
      async find() { return [{ code: 'global', moderators: [] }]; },
      async findOne() { return null; }
    },
    bcryptImpl: {
      async compare() { return true; },
      getRounds() { return 11; }
    }
  });
  const loginAck = acknowledge();
  await loginSocket.trigger('login', {
    username: 'alice',
    password: 'correct-password'
  }, loginAck.callback);
  assert.equal(loginAck.value().success, true);

  let userReads = 0;
  const { socket: controlSocket } = registerMessages({
    dispatchPacket: dispatcher.dispatch,
    UserModel: { async findOne() { userReads += 1; return null; } }
  });
  const ack = acknowledge();
  await controlSocket.trigger('login', {
    username: 'alice',
    password: 'x'.repeat(8_193)
  }, ack.callback);
  assert.deepEqual(ack.value(), { error: 'Invalid input format.' });
  assert.equal(userReads, 0);
});

test('payload rejection telemetry contains no payload username attachment or raw-address sentinel', async () => {
  const logs = [];
  const dispatcher = createSocketEventDispatcher({
    securityLogger: { warn(...args) { logs.push(args); } }
  });
  const socket = new FakeSocket({ dispatchPacket: dispatcher.dispatch });
  const usernameSentinel = 'PrivateUsernameSentinel';
  const attachmentSentinel = 'PrivateAttachmentSentinel';
  const addressSentinel = '203.0.113.199';
  socket.username = usernameSentinel;
  socket.handshake.address = addressSentinel;
  let handlerCalls = 0;
  socket.on('chat_message', () => { handlerCalls += 1; });

  await socket.trigger('chat_message', {
    serverCode: 'global',
    clientContextId: 1,
    text: 'private message payload',
    attachment: `data:image/png;base64,${attachmentSentinel}`,
    secret: 'unapproved'
  });

  assert.equal(handlerCalls, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], 'payload_rejected');
  assert.deepEqual(Object.keys(logs[0][1]).sort(), ['category', 'event', 'networkBucket']);
  assert.equal(logs[0][1].event, 'chat_message');
  assert.equal(logs[0][1].category, null);
  assert.match(logs[0][1].networkBucket, /^[0-9a-f]{16}$/);
  const serialized = JSON.stringify(logs);
  for (const sentinel of [
    usernameSentinel,
    attachmentSentinel,
    addressSentinel,
    'private message payload'
  ]) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
});

test('rate-limited messages skip reply lookup, ping resolution, persistence, and broadcast', async () => {
  let currentTime = 1_000;
  let replyLookups = 0;
  let pingResolutions = 0;
  let creates = 0;
  const audits = [];
  const logs = [];
  const attachmentSentinel = 'PRIVATEATTACHMENT123';
  const privateAttachment = `data:image/png;base64,${attachmentSentinel}==`;
  const { socket, ioInstance } = registerMessages({
    autoModTracker: createAutoModTracker({ now: () => currentTime }),
    ChatServerModel: { async findOne(query) {
      return { code: query.code, moderators: [], autoMod: {
        blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30,
        messageLimit: 2, messageWindowSeconds: 5
      } };
    } },
    MessageModel: {
      async findById() { replyLookups += 1; return null; },
      async create(value) {
        creates += 1;
        return { ...value, _id: String(creates).padStart(24, '0'), timestamp: new Date(currentTime) };
      }
    },
    resolvePingsFn: async text => { pingResolutions += 1; return text; },
    ModerationAuditModel: { async create(value) { audits.push(value); return value; } },
    logger: { error(...args) { logs.push(args); } }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });

  await socket.trigger('chat_message', { serverCode: 'ABC123', clientContextId: 1, text: 'one' });
  await socket.trigger('chat_message', { serverCode: 'ABC123', clientContextId: 1, text: 'two' });
  replyLookups = 0;
  pingResolutions = 0;
  await socket.trigger('chat_message', {
    serverCode: 'ABC123', clientContextId: 1, text: 'blocked secret',
    attachment: privateAttachment,
    replyTo: { id: '507f1f77bcf86cd799439011' }
  });
  await socket.trigger('chat_message', { serverCode: 'ABC123', clientContextId: 1, text: 'blocked again' });

  assert.equal(creates, 2);
  assert.equal(replyLookups, 0);
  assert.equal(pingResolutions, 0);
  assert.equal(ioInstance.outbound.filter(item => item.event === 'chat_message').length, 2);
  assert.equal(socket.outbound.filter(item => item.event === 'message_blocked').length, 2);
  assert.equal(audits.filter(item => item.metadata?.rule === 'message_rate').length, 1);
  for (const [label, records] of [
    ['direct socket events', socket.outbound],
    ['room broadcasts', ioInstance.outbound],
    ['moderation audits', audits],
    ['captured logs', logs]
  ]) {
    const serialized = JSON.stringify(records);
    assert.equal(serialized.includes('blocked secret'), false, `${label} must not expose rejected text`);
    assert.equal(serialized.includes(attachmentSentinel), false, `${label} must not expose rejected attachments`);
  }
});

test('default AutoMod accepts five immediate distinct sends and blocks the sixth', async () => {
  let currentTime = 0;
  let creates = 0;
  const { socket, ioInstance } = registerMessages({
    autoModTracker: createAutoModTracker({ now: () => currentTime }),
    ChatServerModel: { async findOne(query) {
      return { code: query.code, moderators: [], autoMod: {
        blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30
      } };
    } },
    MessageModel: { async create(value) {
      creates += 1;
      return { ...value, _id: String(creates).padStart(24, '0'), timestamp: new Date(currentTime) };
    } },
    ModerationAuditModel: { async create(value) { return value; } }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  for (let index = 0; index < 5; index += 1) {
    await socket.trigger('chat_message', { text: `distinct message ${index}` });
  }
  await socket.trigger('chat_message', { text: 'sixth distinct message' });
  assert.equal(creates, 5);
  assert.equal(ioInstance.outbound.filter(item => item.event === 'chat_message').length, 5);
  assert.equal(socket.outbound.filter(item => item.event === 'message_blocked').length, 1);
});

test('strict one-per-second AutoMod expires at the exact rolling boundary', async () => {
  let currentTime = 0;
  let creates = 0;
  const audits = [];
  const { socket } = registerMessages({
    autoModTracker: createAutoModTracker({ now: () => currentTime }),
    ChatServerModel: { async findOne(query) {
      return { code: query.code, moderators: [], autoMod: {
        blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30,
        messageLimit: 1, messageWindowSeconds: 1
      } };
    } },
    MessageModel: { async create(value) {
      creates += 1;
      return { ...value, _id: String(creates).padStart(24, '0'), timestamp: new Date(currentTime) };
    } },
    ModerationAuditModel: { async create(value) { audits.push(value); return value; } }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  await socket.trigger('chat_message', { text: 'first' });
  currentTime = 999;
  await socket.trigger('chat_message', { text: 'blocked' });
  currentTime = 1_000;
  await socket.trigger('chat_message', { text: 'accepted at boundary' });
  await socket.trigger('chat_message', { text: 'second episode rejection' });
  assert.equal(creates, 2);
  assert.equal(socket.outbound.filter(item => item.event === 'message_blocked').length, 2);
  assert.equal(audits.filter(item => item.metadata?.rule === 'message_rate').length, 2);
});

test('malformed stored message-rate settings fail closed without persistence or broadcast', async () => {
  for (const invalid of [
    { messageLimit: '1', messageWindowSeconds: 1 },
    { messageLimit: 1, messageWindowSeconds: 61 }
  ]) {
    let creates = 0;
    const { socket, ioInstance } = registerMessages({
      ChatServerModel: { async findOne(query) {
        return { code: query.code, moderators: [], autoMod: {
          blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30,
          ...invalid
        } };
      } },
      MessageModel: { async create() { creates += 1; } }
    });
    authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
    await socket.trigger('chat_message', { text: 'malformed setting must fail closed' });
    assert.equal(creates, 0);
    assert.deepEqual(ioInstance.outbound, []);
  }
});

test('tracker failures fail closed without raw content', async () => {
  let creates = 0;
  const logged = [];
  const { socket, ioInstance } = registerMessages({
    autoModTracker: { recordMessageAttempt() { throw new Error('tracker failure containing NeverLogRaw'); } },
    ChatServerModel: { async findOne(query) {
      return { code: query.code, moderators: [], autoMod: {
        blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30,
        messageLimit: 1, messageWindowSeconds: 1
      } };
    } },
    MessageModel: { async create() { creates += 1; } },
    logger: { error(...args) { logged.push(args); } }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  await socket.trigger('chat_message', { text: 'NeverLogRaw message' });
  assert.equal(creates, 0);
  assert.deepEqual(ioInstance.outbound, []);
  assert.equal(JSON.stringify(logged).includes('NeverLogRaw'), false);
});

test('attachment-only sends consume rate capacity while edits do not', async () => {
  let currentTime = 0;
  const tracker = createAutoModTracker({ now: () => currentTime });
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'alice', role: 'user', roomRole: 'user',
    text: 'before', history: [], deleted: false, markModified() {}, async save() {}
  };
  let creates = 0;
  const { socket } = registerMessages({
    autoModTracker: tracker,
    ChatServerModel: { async findOne(query) {
      return { code: query.code, moderators: [], autoMod: {
        blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30,
        messageLimit: 2, messageWindowSeconds: 5
      } };
    } },
    MessageModel: {
      async findById() { return message; },
      async create(value) {
        creates += 1;
        return { ...value, _id: String(creates).padStart(24, '0'), timestamp: new Date(currentTime) };
      }
    }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  await socket.trigger('chat_message', { text: '', attachment: 'data:image/png;base64,AA==' });
  assert.equal(tracker.messageAttemptCount('ABC123\0alice'), 1);
  await socket.trigger('edit_message', { id: message._id, text: 'after' });
  assert.equal(tracker.messageAttemptCount('ABC123\0alice'), 1);
  await socket.trigger('chat_message', { text: 'second accepted' });
  assert.equal(creates, 2);
  assert.equal(tracker.messageAttemptCount('ABC123\0alice'), 2);
});

test('content-blocked sends consume their admitted message-rate slot', async () => {
  const tracker = createAutoModTracker({ now: () => 0 });
  let creates = 0;
  const { socket } = registerMessages({
    autoModTracker: tracker,
    ChatServerModel: { async findOne(query) {
      return { code: query.code, moderators: [], autoMod: {
        blockedKeywords: ['forbidden'], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30,
        messageLimit: 1, messageWindowSeconds: 5
      } };
    } },
    MessageModel: { async create() { creates += 1; } },
    ModerationAuditModel: { async create(value) { return value; } }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  await socket.trigger('chat_message', { text: 'forbidden content' });
  assert.equal(tracker.messageAttemptCount('ABC123\0alice'), 1);
  await socket.trigger('chat_message', { text: 'otherwise valid but rate limited' });
  assert.equal(creates, 0);
  assert.equal(socket.outbound.filter(item => item.event === 'message_blocked').length, 2);
});

test('mention and repeat content blocks consume their admitted message-rate slots', async () => {
  for (const scenario of [
    {
      name: 'mention',
      settings: { blockedKeywords: [], mentionLimit: 1, repeatLimit: 3, repeatWindowSeconds: 30, messageLimit: 1, messageWindowSeconds: 5 },
      sends: ['two mentions'],
      resolvePingsFn: async () => '{{PING:one|One}} {{PING:two|Two}}',
      expectedCount: 1
    },
    {
      name: 'repeat',
      settings: { blockedKeywords: [], mentionLimit: 8, repeatLimit: 2, repeatWindowSeconds: 30, messageLimit: 2, messageWindowSeconds: 5 },
      sends: ['same content', 'same content'],
      resolvePingsFn: async text => text,
      expectedCount: 2
    }
  ]) {
    const tracker = createAutoModTracker({ now: () => 0 });
    let creates = 0;
    const { socket } = registerMessages({
      autoModTracker: tracker,
      ChatServerModel: { async findOne(query) { return { code: query.code, moderators: [], autoMod: scenario.settings }; } },
      MessageModel: { async create(value) {
        creates += 1;
        return { ...value, _id: String(creates).padStart(24, '0'), timestamp: new Date() };
      } },
      resolvePingsFn: scenario.resolvePingsFn,
      ModerationAuditModel: { async create(value) { return value; } }
    });
    authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
    for (const text of scenario.sends) await socket.trigger('chat_message', { text });
    assert.equal(tracker.messageAttemptCount('ABC123\0alice'), scenario.expectedCount, scenario.name);
    assert.equal(socket.outbound.filter(item => item.event === 'message_blocked').length, 1, scenario.name);
  }
});

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

test('room-scoped backend events preserve payloads and attach canonical room metadata', async () => {
  const message = {
    _id: '507f1f77bcf86cd799439011',
    serverCode: 'ABC123',
    username: 'alice',
    displayName: 'Alice',
    role: 'user',
    roomRole: 'user',
    text: 'before',
    history: [],
    reactions: {},
    deleted: false,
    markModified() {},
    async save() {}
  };
  const { socket, ioInstance } = registerMessages({
    ChatServerModel: {
      async findOne(query) {
        return {
          code: query.code,
          moderators: [],
          autoMod: {
            blockedKeywords: ['blocked'], mentionLimit: 8,
            repeatLimit: 3, repeatWindowSeconds: 30,
            messageLimit: 10, messageWindowSeconds: 30
          }
        };
      }
    },
    MessageModel: {
      async findById() { return message; },
      async create(value) {
        return {
          ...value,
          _id: '507f1f77bcf86cd799439012',
          timestamp: new Date('2026-08-11T00:00:00.000Z')
        };
      }
    },
    ModerationAuditModel: { async create(value) { return value; } }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });

  await socket.trigger('chat_message', { text: 'new message' });
  await socket.trigger('toggle_reaction', { id: message._id, emoji: '👍' });
  await socket.trigger('edit_message', { id: message._id, text: 'after' });
  await socket.trigger('typing', true);
  await socket.trigger('delete_message', message._id);
  await socket.trigger('chat_message', { text: 'blocked phrase' });

  const expectedEvents = [
    [ioInstance.outbound, 'chat_message'],
    [ioInstance.outbound, 'reaction_updated'],
    [ioInstance.outbound, 'message_edited'],
    [ioInstance.outbound, 'message_deleted'],
    [socket.outbound, 'typing'],
    [socket.outbound, 'message_blocked']
  ];
  for (const [records, eventName] of expectedEvents) {
    const record = records.find(item => item.event === eventName);
    assert.ok(record, `${eventName} was emitted through its real handler`);
    assert.equal(record.args[0], record.payload, `${eventName} keeps its first payload argument`);
    assert.deepEqual(record.args[1], { serverCode: 'ABC123' },
      `${eventName} has canonical second-argument room metadata`);
    assert.equal(record.args.length, 2, `${eventName} exposes only payload plus room metadata`);
  }

  const source = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../server.js'), 'utf8');
  for (const eventName of ['online_users', 'system_message', 'room_role_updated',
    'moderation_queue_updated', 'message_blocked', 'chat_message', 'reaction_updated',
    'message_edited', 'message_deleted', 'typing']) {
    assert.match(source, new RegExp(`emitRoomEvent\\([\\s\\S]{0,180}['"]${eventName}['"]`),
      `${eventName} routes through canonical metadata emission`);
  }
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

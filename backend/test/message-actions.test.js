const test = require('node:test');
const assert = require('node:assert/strict');
const { createAutoModTracker, createConnectionHandler } = require('../server');
const { FakeSocket, FakeIo, acknowledge, deferred, createMemoryModel } = require('./support/fakes');

function registerMessages(overrides = {}) {
  const socket = new FakeSocket();
  const ioInstance = new FakeIo();
  const RoomMemberStateModel = overrides.RoomMemberStateModel || createMemoryModel([]);
  const UserExperienceStateModel = overrides.UserExperienceStateModel || createMemoryModel([]);
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
    ...overrides,
    RoomMemberStateModel,
    UserExperienceStateModel
  })(socket);
  return { socket, ioInstance, RoomMemberStateModel, UserExperienceStateModel };
}

function authenticate(socket, { serverCode = 'global', joinedServers = ['global'] } = {}) {
  socket.username = 'alice';
  socket.displayName = 'Alice';
  socket.role = 'user';
  socket.serverCode = serverCode;
  socket.joinedServers = joinedServers;
}

test('new messages store immutable normalized author and canonical send-time mentions', async () => {
  const MessageModel = createMemoryModel([]);
  const { socket } = registerMessages({
    MessageModel,
    resolvePingsFn: async () =>
      '{{PING:Bob|Bob}} {{PING:BOB|Bob}} {{PING:everyone|everyone}}'
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });

  await socket.trigger('chat_message', { text: '@Bob @BOB @everyone' });

  assert.equal(MessageModel.rows.length, 1);
  assert.equal(MessageModel.rows[0].serverCode, 'ABC123');
  assert.equal(MessageModel.rows[0].authorKey, 'alice');
  assert.deepEqual(MessageModel.rows[0].notificationMentions, ['bob', '*']);
});

test('everyone mention stores the reserved star exactly once', async () => {
  const MessageModel = createMemoryModel([]);
  const { socket } = registerMessages({
    MessageModel,
    resolvePingsFn: async () =>
      '{{PING:everyone|everyone}} {{PING:everyone|everyone}}'
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });

  await socket.trigger('chat_message', { text: '@everyone @everyone' });

  assert.deepEqual(MessageModel.rows[0].notificationMentions, ['*']);
});

test('edits do not change mention metadata or create activity', async () => {
  const MessageModel = createMemoryModel([]);
  const { socket } = registerMessages({
    MessageModel,
    resolvePingsFn: async text => text === 'original'
      ? '{{PING:bob|Bob}}'
      : '{{PING:carol|Carol}}'
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  await socket.trigger('chat_message', { text: 'original' });
  const stored = MessageModel.rows[0];
  assert.deepEqual(stored.notificationMentions, ['bob']);
  const immutableBefore = {
    authorKey: stored.authorKey,
    notificationMentions: [...stored.notificationMentions]
  };
  socket.outbound.length = 0;

  await socket.trigger('edit_message', { id: stored._id, text: 'edited' });

  assert.deepEqual({
    authorKey: MessageModel.rows[0].authorKey,
    notificationMentions: MessageModel.rows[0].notificationMentions
  }, immutableBefore);
  assert.deepEqual(socket.outbound.filter(item => item.event === 'room_activity'), []);
});

test('pin mutation binds the live target to the requested room without exposing message content', async () => {
  const messageId = '507f1f77bcf86cd799439011';
  const secret = 'PIN_ACTION_SECRET';
  const ChatServerModel = createMemoryModel([{
    code: 'ABC123', owner: 'alice', moderators: [], pinnedMessages: [], pinVersion: 0
  }]);
  const MessageModel = createMemoryModel([{
    _id: messageId, serverCode: 'BBB222', username: 'bob', displayName: 'Bob', authorKey: 'bob',
    text: secret, attachment: 'data:image/png;base64,UElOU0VDUkVU', deleted: false,
    timestamp: new Date()
  }]);
  const audits = createMemoryModel([]);
  const { socket, ioInstance } = registerMessages({
    ChatServerModel,
    MessageModel,
    ModerationAuditModel: audits,
    UserModel: createMemoryModel([userDocumentForPinAction()])
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  socket.role = 'admin';
  const ack = acknowledge();

  await socket.trigger('set_message_pin', {
    serverCode: 'ABC123', messageId, pinned: true, clientContextId: 1
  }, ack.callback);

  assert.deepEqual(ack.value(), { error: 'Permission denied.' });
  assert.deepEqual(ChatServerModel.rows[0].pinnedMessages, []);
  assert.equal(ChatServerModel.rows[0].pinVersion, 0);
  assert.deepEqual(audits.rows, []);
  assert.equal(JSON.stringify(ioInstance.outbound).includes(secret), false);
  assert.equal(JSON.stringify(ioInstance.outbound).includes('UElOU0VDUkVU'), false);
});

function userDocumentForPinAction() {
  return { username: 'alice', displayName: 'Alice', role: 'admin', servers: ['global', 'ABC123'] };
}

test('unpinned deletion does not advance pinVersion', async () => {
  const messageId = '507f1f77bcf86cd799439011';
  const ChatServerModel = createMemoryModel([{
    code: 'ABC123', owner: 'alice', moderators: [], pinnedMessages: [], pinVersion: 4
  }]);
  const MessageModel = createMemoryModel([{
    _id: messageId, serverCode: 'ABC123', username: 'alice', displayName: 'Alice',
    authorKey: 'alice', text: 'delete me', attachment: null, deleted: false,
    timestamp: new Date(), history: [], reactions: {}
  }]);
  const { socket } = registerMessages({
    ChatServerModel,
    MessageModel,
    UserModel: createMemoryModel([{
      username: 'alice', displayName: 'Alice', role: 'user', servers: ['global', 'ABC123']
    }]),
    RoomRestrictionModel: createMemoryModel([])
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  const ack = acknowledge();

  await socket.trigger('delete_message', {
    id: messageId, serverCode: 'ABC123', clientContextId: 1
  }, ack.callback);

  assert.equal(MessageModel.rows[0].deleted, true);
  assert.equal(ChatServerModel.rows[0].pinVersion, 4);
  assert.deepEqual(ChatServerModel.rows[0].pinnedMessages, []);
  assert.deepEqual(ack.value(), {
    success: true, messageId,
    pin: { serverCode: 'ABC123', pinCount: 0, pinVersion: 4, blockVersion: 0 }
  });
  assert.equal(socket.outbound.some(item => item.event === 'message_pin_updated'), false);
});

test('edits preserve pin identity and are reflected by the next pin read', async () => {
  const messageId = '507f1f77bcf86cd799439011';
  const priorPin = { messageId, pinnedAt: new Date('2026-08-10T12:00:00.000Z'), pinnedBy: 'alice' };
  const ChatServerModel = createMemoryModel([{
    code: 'ABC123', owner: 'alice', moderators: [], pinnedMessages: [priorPin], pinVersion: 3,
    autoMod: {
      blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30,
      messageLimit: 5, messageWindowSeconds: 5
    }
  }]);
  const MessageModel = createMemoryModel([{
    _id: messageId, serverCode: 'ABC123', username: 'alice', displayName: 'Alice',
    authorKey: 'alice', role: 'user', roomRole: 'user', text: 'before', attachment: null,
    deleted: false, edited: false, timestamp: new Date('2026-08-10T11:00:00.000Z'),
    history: [], reactions: {}
  }]);
  const { socket } = registerMessages({
    ChatServerModel,
    MessageModel,
    UserModel: createMemoryModel([{
      username: 'alice', displayName: 'Alice', role: 'user', servers: ['global', 'ABC123']
    }]),
    RoomRestrictionModel: createMemoryModel([])
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });

  await socket.trigger('edit_message', { id: messageId, text: 'after' });
  const ack = acknowledge();
  await socket.trigger('list_pinned_messages', {
    serverCode: 'ABC123', clientContextId: 1
  }, ack.callback);

  assert.deepEqual(ChatServerModel.rows[0].pinnedMessages, [priorPin]);
  assert.equal(ChatServerModel.rows[0].pinVersion, 3);
  assert.equal(ack.value().pins[0].messageId, messageId);
  assert.equal(ack.value().pins[0].text, 'after');
  assert.equal(ack.value().pins[0].pinnedAt.getTime(), priorPin.pinnedAt.getTime());
  assert.equal(ack.value().pins[0].pinnedBy, 'alice');
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
  assert.equal(socket.outbound.filter(item => item.event === 'chat_message').length, 2);
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
  assert.equal(socket.outbound.filter(item => item.event === 'chat_message').length, 5);
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
  assert.equal(socket.outbound.at(-1).target, 'self');
  assert.equal(socket.outbound.at(-1).event, 'message_edited');
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
    authorKey: 'bob',
    displayname: 'Bob',
    text: 'trusted stored text'
  });
});

test('new replies persist immutable authorKey from the exact-room source', async () => {
  let created;
  const referenced = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'BoB', authorKey: 'bob',
    displayName: 'Bob', text: 'trusted source', deleted: false
  };
  const { socket } = registerMessages({
    MessageModel: {
      async findById() { return referenced; },
      async create(value) {
        created = value;
        return { ...value, _id: '507f191e810c19729de860ea', timestamp: new Date() };
      }
    }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });

  await socket.trigger('chat_message', {
    text: 'reply', replyTo: {
      id: referenced._id, authorKey: 'attacker', displayname: 'Attacker', text: 'forged'
    }
  });

  assert.deepEqual(created.replyTo, {
    id: referenced._id, authorKey: 'bob', displayname: 'Bob', text: 'trusted source'
  });
});

test('reaction updates remove identities blocked by each recipient', async () => {
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'Carol', authorKey: 'carol',
    deleted: false, reactions: { '👍': ['Bob'] }, markModified() {}, async save() {}
  };
  const sockets = ['alice', 'blocker', 'open'].map(id => {
    const live = new FakeSocket();
    live.id = id;
    return live;
  });
  const ioInstance = new FakeIo(sockets);
  const onlineUsersMap = new Map();
  const users = createMemoryModel([
    { username: 'Alice', role: 'user', servers: ['global', 'ABC123'] },
    { username: 'Blocker', role: 'user', servers: ['global', 'ABC123'] },
    { username: 'Open', role: 'user', servers: ['global', 'ABC123'] }
  ]);
  const deps = {
    ioInstance, onlineUsersMap, UserModel: users,
    ChatServerModel: createMemoryModel([{ code: 'ABC123', moderators: [] }]),
    MessageModel: { async findById() { return message; } },
    RoomRestrictionModel: createMemoryModel([]), UserExperienceStateModel: createMemoryModel([]),
    broadcastOnlineUsersFn: async () => {}, getRoomRoleFn: async () => 'user',
    resolvePingsFn: async text => text
  };
  for (const live of sockets) createConnectionHandler(deps)(live);
  Object.assign(sockets[0], { username: 'Alice', displayName: 'Alice', role: 'user' });
  Object.assign(sockets[1], { username: 'Blocker', displayName: 'Blocker', role: 'user', blockedUserKeys: new Set(['bob']), blockVersion: 2 });
  Object.assign(sockets[2], { username: 'Open', displayName: 'Open', role: 'user', blockedUserKeys: new Set(), blockVersion: 0 });
  for (const live of sockets) {
    live.serverCode = 'ABC123';
    live.joinedServers = ['global', 'ABC123'];
    onlineUsersMap.set(live.id, {
      username: live.username, serverCode: 'ABC123', joinedServers: [...live.joinedServers],
      blockedUsers: [...(live.blockedUserKeys || [])], blockVersion: live.blockVersion || 0
    });
  }

  await sockets[0].trigger('toggle_reaction', { id: message._id, emoji: '👍' });

  assert.deepEqual(sockets[1].outbound.find(item => item.event === 'reaction_updated').payload.reactions, {
    '👍': ['Alice']
  });
  assert.deepEqual(sockets[2].outbound.find(item => item.event === 'reaction_updated').payload.reactions, {
    '👍': ['Bob', 'Alice']
  });
});

test('typing from a blocked author is suppressed only for blocker sessions', async () => {
  const author = new FakeSocket(); author.id = 'author';
  const blocker = new FakeSocket(); blocker.id = 'blocker';
  const open = new FakeSocket(); open.id = 'open';
  const sockets = [author, blocker, open];
  const ioInstance = new FakeIo(sockets);
  const onlineUsersMap = new Map();
  const deps = {
    ioInstance, onlineUsersMap,
    UserModel: createMemoryModel([
      { username: 'Author', role: 'user', servers: ['global', 'ABC123'] },
      { username: 'Blocker', role: 'user', servers: ['global', 'ABC123'] },
      { username: 'Open', role: 'user', servers: ['global', 'ABC123'] }
    ]),
    ChatServerModel: createMemoryModel([{ code: 'ABC123', moderators: [] }]),
    RoomRestrictionModel: createMemoryModel([]), UserExperienceStateModel: createMemoryModel([]),
    broadcastOnlineUsersFn: async () => {}, getRoomRoleFn: async () => 'user',
    resolvePingsFn: async text => text
  };
  for (const live of sockets) createConnectionHandler(deps)(live);
  for (const [live, username] of [[author, 'Author'], [blocker, 'Blocker'], [open, 'Open']]) {
    Object.assign(live, {
      username, displayName: username, role: 'user', serverCode: 'ABC123',
      joinedServers: ['global', 'ABC123'], blockedUserKeys: new Set(username === 'Blocker' ? ['author'] : [])
    });
    onlineUsersMap.set(live.id, {
      username, serverCode: 'ABC123', joinedServers: ['global', 'ABC123'],
      blockedUsers: [...live.blockedUserKeys], blockVersion: 1
    });
  }

  await author.trigger('typing', true);

  assert.equal(blocker.outbound.some(item => item.event === 'typing'), false);
  assert.deepEqual(open.outbound.find(item => item.event === 'typing').payload, {
    username: 'Author', displayName: 'Author', isTyping: true
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

test('chat message stays bound to its stored room without leaking to a newly active room', async () => {
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
  assert.deepEqual(socket.outbound, []);
  assert.deepEqual(ioInstance.outbound, []);
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
    {
      _id: '507f1f77bcf86cd799439011', serverCode: 'global', username: 'Alice', authorKey: 'alice',
      displayName: 'Alice', role: 'user', roomRole: 'user', color: '', avatarUrl: '', text: 'unsafe',
      attachment: 'javascript:alert(1)', replyTo: null, reactions: {}, edited: false, deleted: false,
      timestamp: new Date('2026-08-10T12:01:00.000Z')
    },
    {
      _id: '507f191e810c19729de860ea', serverCode: 'global', username: 'Alice', authorKey: 'alice',
      displayName: 'Alice', role: 'user', roomRole: 'user', color: '', avatarUrl: '', text: 'safe',
      attachment: 'data:image/png;base64,AAAA', replyTo: null, reactions: {}, edited: false, deleted: false,
      timestamp: new Date('2026-08-10T12:00:00.000Z')
    }
  ];
  const { socket, RoomMemberStateModel } = registerMessages({
    MessageModel: {
      find() {
        return {
          sort() { return this; },
          limit() { return this; },
          async select() {
            return history.map(row => ({
              _id: row._id, serverCode: row.serverCode, timestamp: row.timestamp,
              username: row.username, authorKey: row.authorKey,
              notificationMentions: row.notificationMentions, deleted: row.deleted
            }));
          },
          async lean() { return history; },
          then(resolve, reject) { return Promise.resolve(history).then(resolve, reject); }
        };
      }
    }
  });
  authenticate(socket);
  const ack = acknowledge();
  await socket.trigger('switch_server', 'global', ack.callback);
  assert.equal(ack.value().history[0].attachment, 'data:image/png;base64,AAAA');
  assert.equal(ack.value().history[1].attachment, null);
  assert.deepEqual(RoomMemberStateModel.rows.map(row => ({
    usernameKey: row.usernameKey,
    serverCode: row.serverCode,
    lastReadMessageId: row.lastReadMessageId
  })), [{
    usernameKey: 'alice', serverCode: 'global', lastReadMessageId: '507f1f77bcf86cd799439011'
  }]);
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

test('typing validates accessible active rooms and boolean states with a complete personalized payload', async () => {
  const { socket } = registerMessages();
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global'] });
  await socket.trigger('typing', true);
  await socket.trigger('typing', 'true');
  assert.deepEqual(socket.outbound, []);

  socket.joinedServers.push('ABC123');
  await socket.trigger('typing', 'true');
  await socket.trigger('typing', true);
  assert.deepEqual(socket.outbound, [{
    target: 'self', event: 'typing',
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
    _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'alice', authorKey: 'alice',
    deleted: false, reactions: {},
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
  assert.equal(socket.outbound.some(item => item.event === 'reaction_updated'), true);
  assert.equal(ioInstance.outbound.some(item => item.event === 'server_deleted'), true);
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
    assert.equal(socket.outbound.some(item => item.event === action.emittedEvent), true);
    assert.equal(ioInstance.outbound.some(item => item.event === 'server_deleted'), true);
  });
}

for (const mutation of [
  {
    name: 'edit',
    event: 'edit_message',
    payload: { id: '507f1f77bcf86cd799439011', text: 'must not resurrect' },
    emittedEvent: 'message_edited'
  },
  {
    name: 'reaction',
    event: 'toggle_reaction',
    payload: { id: '507f1f77bcf86cd799439011', emoji: '👍' },
    emittedEvent: 'reaction_updated'
  }
]) {
  test(`a committed delete cannot be overwritten by a stale preloaded ${mutation.name}`, async () => {
    const messageId = '507f1f77bcf86cd799439011';
    const deleteSaveStarted = deferred();
    const releaseDeleteSave = deferred();
    const MessageModel = createMemoryModel([{
      _id: messageId, serverCode: 'ABC123', username: 'alice', displayName: 'Alice',
      authorKey: 'alice', role: 'user', roomRole: 'user', text: 'before', attachment: null,
      history: [], reactions: {}, edited: false, deleted: false, timestamp: new Date()
    }]);
    let gatedDelete = false;
    MessageModel.saveHook = async ({ document }) => {
      if (!document.deleted || gatedDelete) return;
      gatedDelete = true;
      deleteSaveStarted.resolve();
      await releaseDeleteSave.promise;
    };
    const ChatServerModel = createMemoryModel([{
      code: 'ABC123', name: 'Room', owner: 'alice', moderators: [],
      pinnedMessages: [], pinVersion: 0,
      autoMod: {
        blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30,
        messageLimit: 20, messageWindowSeconds: 60
      }
    }]);
    const { socket } = registerMessages({
      MessageModel,
      ChatServerModel,
      UserModel: createMemoryModel([{
        username: 'alice', displayName: 'Alice', role: 'user', servers: ['global', 'ABC123']
      }]),
      RoomRestrictionModel: createMemoryModel([])
    });
    authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
    const deleteAck = acknowledge();

    const deletePending = socket.trigger('delete_message', {
      id: messageId, serverCode: 'ABC123', clientContextId: 1
    }, deleteAck.callback);
    await deleteSaveStarted.promise;
    const mutationPending = socket.trigger(mutation.event, {
      ...mutation.payload, serverCode: 'ABC123', clientContextId: 1
    });
    await new Promise(resolve => setImmediate(resolve));
    releaseDeleteSave.resolve();
    await Promise.all([deletePending, mutationPending]);

    assert.equal(deleteAck.value().success, true);
    assert.equal(MessageModel.rows[0].deleted, true);
    assert.equal(MessageModel.rows[0].text, 'before');
    assert.deepEqual(MessageModel.rows[0].reactions, {});
    assert.equal(socket.outbound.some(item => item.event === mutation.emittedEvent), false);
  });
}

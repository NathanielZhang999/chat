const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ChatServer,
  Message,
  RoomMemberState,
  UserExperienceState,
  normalizeRoomText,
  normalizeNotificationLevel,
  authorKeyForMessage,
  extractNotificationMentions,
  roomMessageQuery,
  cursorFromMessage,
  compareCursor,
  safeReplyForViewer,
  safeReactionsForViewer,
  safeMessageForViewer,
  safeBlockedMessageReveal,
  safeRoomDetails,
  safeRoomState,
  safeBlockState,
  createConnectionHandler
} = require('../server');
const { FakeIo, FakeSocket, createMemoryModel } = require('./support/fakes');

test('room experience schemas expose exact defaults bounds and required indexes', () => {
  assert.equal(ChatServer.schema.path('description').options.default, '');
  assert.equal(ChatServer.schema.path('description').options.maxLength, 500);
  assert.equal(ChatServer.schema.path('rules').options.maxLength, 2000);
  assert.equal(ChatServer.schema.path('metadataVersion').options.min, 0);
  assert.equal(ChatServer.schema.path('pinVersion').options.min, 0);
  assert.equal(ChatServer.schema.path('pinnedMessages').options.validate.validator(Array(20).fill({})), true);
  assert.equal(ChatServer.schema.path('pinnedMessages').options.validate.validator(Array(21).fill({})), false);
  assert.ok(Message.schema.indexes().some(([keys]) =>
    keys.serverCode === 1 && keys.timestamp === -1 && keys._id === -1));
  assert.ok(RoomMemberState.schema.indexes().some(([keys, options]) =>
    keys.usernameKey === 1 && keys.serverCode === 1 && options.unique));
  assert.ok(RoomMemberState.schema.indexes().some(([keys]) =>
    keys.serverCode === 1 && keys.usernameKey === 1));
  assert.ok(UserExperienceState.schema.indexes().some(([keys, options]) =>
    keys.usernameKey === 1 && options.unique));
  assert.equal(RoomMemberState.schema.path('notificationLevel').options.default, 'all');
  assert.equal(UserExperienceState.schema.path('blockedUsers').options.validate.validator(Array(500).fill({})), true);
  assert.equal(UserExperienceState.schema.path('blockedUsers').options.validate.validator(Array(501).fill({})), false);
});

test('room text notification mention and cursor helpers enforce canonical values', () => {
  assert.equal(normalizeRoomText('  \uff21  ', 1), 'A');
  assert.equal(normalizeRoomText('abc', 2), null);
  assert.equal(normalizeNotificationLevel('mentions'), 'mentions');
  assert.equal(normalizeNotificationLevel(' Mentions '), null);
  assert.equal(authorKeyForMessage({ authorKey: ' ALICE ' }), 'alice');
  assert.equal(authorKeyForMessage({ username: 'Alice' }), 'alice');
  assert.equal(authorKeyForMessage({ username: 'not valid!' }), null);
  assert.deepEqual(
    extractNotificationMentions('{{PING:Alice|Alice}} {{PING:everyone|everyone}} {{PING:ALICE|Alice}}'),
    ['alice', '*']
  );
  assert.deepEqual(roomMessageQuery('global'), {
    $or: [{ serverCode: 'global' }, { serverCode: { $exists: false } }, { serverCode: null }]
  });
  assert.deepEqual(roomMessageQuery('ABC123'), { serverCode: 'ABC123' });
  const first = cursorFromMessage({ timestamp: new Date('2026-01-01T00:00:00.000Z'), _id: '000000000000000000000001' });
  const second = cursorFromMessage({ timestamp: new Date('2026-01-01T00:00:00.000Z'), _id: '000000000000000000000002' });
  assert.equal(compareCursor(first, second), -1);
  assert.equal(compareCursor(second, first), 1);
  assert.equal(compareCursor(first, { ...first }), 0);
  assert.equal(cursorFromMessage({ timestamp: 'nope', _id: 'bad' }), null);
});

test('safe room message reply reaction and block serializers are explicit allowlists', () => {
  const source = {
    _id: '000000000000000000000001', serverCode: 'ABC123', username: 'Alice', displayName: 'Alice',
    authorKey: 'alice', role: 'user', roomRole: 'user', color: '#ffffff', avatarUrl: 'https://example.test/a',
    text: 'hello', attachment: null, replyTo: { id: 'x', authorKey: 'bob', displayname: 'Bob', text: 'reply' },
    reactions: { '\ud83d\udc4d': ['Bob', 'Alice'] }, edited: false, deleted: false, timestamp: new Date(),
    history: [{ text: 'old' }], __v: 3, autoMod: { blockedKeywords: ['nope'] }
  };
  const blocked = safeMessageForViewer(source, { blockedUserKeys: new Set(['alice']) });
  assert.deepEqual(Object.keys(blocked), ['_id', 'serverCode', 'username', 'authorKey', 'timestamp', 'blocked']);
  const visible = safeMessageForViewer(source, { blockedUserKeys: new Set(['bob']) });
  assert.deepEqual(visible.replyTo, null);
  assert.deepEqual(visible.reactions, { '\ud83d\udc4d': ['Alice'] });
  assert.deepEqual(safeReplyForViewer(source.replyTo, new Set()), source.replyTo);
  assert.deepEqual(safeReactionsForViewer(source.reactions, new Set(['bob'])), { '\ud83d\udc4d': ['Alice'] });
  const reveal = safeBlockedMessageReveal(source);
  assert.deepEqual(Object.keys(reveal), [
    '_id', 'serverCode', 'username', 'displayName', 'authorKey', 'timestamp', 'text', 'attachment', 'edited', 'deleted'
  ]);
  const details = safeRoomDetails({ code: 'ABC123', description: 'about', rules: 'rules', metadataVersion: 2, autoMod: {} }, true);
  assert.deepEqual(details, { serverCode: 'ABC123', description: 'about', rules: 'rules', metadataVersion: 2, canEdit: true });
  assert.deepEqual(safeRoomState({ serverCode: 'ABC123', usernameKey: 'alice', notificationLevel: 'all', lastReadAt: null, lastReadMessageId: null, version: 4 }, { unreadCount: 2, mentionCount: 1, blockVersion: 3 }), {
    serverCode: 'ABC123', usernameKey: 'alice', notificationLevel: 'all', lastReadAt: null, lastReadMessageId: null,
    unreadCount: 2, mentionCount: 1, version: 4, blockVersion: 3
  });
  assert.deepEqual(safeBlockState({ blockedUsers: [{ usernameKey: 'bob', username: 'Bob', createdAt: new Date() }], blockVersion: 5 }), {
    blockedUsers: [{ usernameKey: 'bob', username: 'Bob' }], blockVersion: 5
  });
  for (const value of [visible, reveal, details]) {
    assert.equal(Object.hasOwn(value, 'history'), false);
    assert.equal(Object.hasOwn(value, '__v'), false);
    assert.equal(Object.hasOwn(value, 'autoMod'), false);
  }
});

test('legacy authors and replies fail closed when block filtering cannot prove safety', () => {
  const legacy = { _id: 'x', serverCode: 'global', username: 'not valid!', timestamp: new Date(), text: 'secret' };
  assert.equal(safeMessageForViewer(legacy, { blockedUserKeys: new Set(['bob']) }), null);
  assert.equal(safeReplyForViewer({ id: 'x', displayname: 'Unknown', text: 'secret' }, new Set(['bob'])), null);
  assert.equal(safeReplyForViewer({ id: 'x', authorKey: 'bob', displayname: 'Bob', text: 'secret' }, new Set(['bob'])), null);
});

test('memory model supports atomic versioned array and cursor operations', async () => {
  const model = createMemoryModel([{ _id: 'one', nested: { value: 1 }, values: [{ usernameKey: 'bob' }], version: 0 }]);
  const session = { id: 'session-1' };
  const query = model.find({ 'nested.value': { $gte: 1 }, missing: { $exists: false }, _id: { $ne: 'two' } }).session(session);
  assert.equal(query.sessionValue, session);
  assert.equal((await query.lean()).length, 1);
  const updated = await model.findOneAndUpdate(
    { _id: 'one', $and: [{ version: { $lte: 0 } }] },
    {
      $setOnInsert: { created: true },
      $set: { 'nested.cursor': 'new' },
      $inc: { version: 1 },
      $addToSet: { values: { usernameKey: 'alice' } },
      $push: { events: { $each: [1, 2, 3], $slice: -2 } },
      $pull: { values: { usernameKey: 'bob' } }
    },
    { new: true }
  );
  assert.equal(updated.version, 1);
  assert.equal(updated.nested.cursor, 'new');
  assert.deepEqual(updated.values, [{ usernameKey: 'alice' }]);
  assert.deepEqual(updated.events, [2, 3]);
  const inserted = await model.findOneAndUpdate({ _id: 'two', kind: 'state' }, { $setOnInsert: { version: 0 }, $inc: { version: 1 } }, { upsert: true, new: true });
  assert.equal(inserted.version, 1);
  assert.equal((await model.find({ $or: [{ _id: 'one' }, { _id: 'two' }] }).sort({ _id: -1 }).limit(1).select('_id').lean()).length, 1);
  assert.equal((await model.updateMany({ kind: { $exists: true } }, { $inc: { version: 1 } })).modifiedCount, 1);
  assert.equal((await model.deleteOne({ _id: 'two' })).deletedCount, 1);
  assert.equal((await model.deleteMany({ _id: { $exists: true } })).deletedCount, 1);
  await model.db.transaction(async transactionSession => assert.ok(transactionSession));
});

test('connection handler accepts injected room-state and experience-state models', () => {
  const handler = createConnectionHandler({
    ioInstance: new FakeIo(),
    RoomMemberStateModel: createMemoryModel([]),
    UserExperienceStateModel: createMemoryModel([])
  });
  assert.equal(typeof handler, 'function');
  const socket = new FakeSocket();
  handler(socket);
  assert.ok(socket.handlers.has('connection_status') || socket.handlers.size > 0);
});

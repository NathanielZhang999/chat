const test = require('node:test');
const assert = require('node:assert/strict');
const { createConnectionHandler, isNotificationMention } = require('../server');
const { FakeSocket, FakeIo, createMemoryModel, acknowledge, deferred } = require('./support/fakes');

function objectId(value) {
  return Number(value).toString(16).padStart(24, '0');
}

function user(username, { role = 'user', servers = ['global', 'ABC123'] } = {}) {
  return {
    username, displayName: username, password: 'hash', role, color: '', avatarUrl: '', servers
  };
}

function room(code, overrides = {}) {
  return {
    code,
    name: code === 'global' ? 'Global Chat' : code,
    owner: 'Author',
    moderators: [],
    pinnedMessages: [],
    pinVersion: 0,
    metadataVersion: 0,
    autoMod: {
      blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30,
      messageLimit: 20, messageWindowSeconds: 60
    },
    ...overrides
  };
}

function message(id, overrides = {}) {
  return {
    _id: objectId(id), serverCode: 'ABC123', username: 'Author', displayName: 'Author',
    authorKey: 'author', notificationMentions: [], role: 'user', roomRole: 'user', color: '',
    avatarUrl: '', text: `message-${id}`, attachment: null, replyTo: null, reactions: {},
    edited: false, deleted: false, timestamp: new Date('2026-08-10T12:00:00.000Z'),
    ...overrides
  };
}

function roomState(usernameKey, serverCode, lastReadAt, lastReadMessageId, overrides = {}) {
  return {
    usernameKey, serverCode, notificationLevel: 'all', lastReadAt, lastReadMessageId,
    version: 0, ...overrides
  };
}

function preserveAttentionProjection(MessageModel) {
  const find = MessageModel.find.bind(MessageModel);
  MessageModel.find = (query = {}) => {
    const result = find(query);
    if (!Array.isArray(query.$and)) return result;
    return {
      async select() {
        const rows = await result;
        return rows.map(row => ({
          _id: row._id,
          serverCode: row.serverCode,
          timestamp: row.timestamp,
          username: row.username,
          authorKey: row.authorKey,
          notificationMentions: Array.isArray(row.notificationMentions)
            ? [...row.notificationMentions] : row.notificationMentions,
          deleted: row.deleted
        }));
      }
    };
  };
}

function createFixture({
  users = [user('Author'), user('Reader')],
  rooms = [room('global'), room('ABC123')],
  messages = [],
  restrictions = [],
  roomStates = [],
  experienceStates = [],
  resolvePingsFn = async text => text,
  logger = { error() {} }
} = {}) {
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const UserModel = createMemoryModel(users);
  const ChatServerModel = createMemoryModel(rooms);
  const MessageModel = createMemoryModel(messages);
  preserveAttentionProjection(MessageModel);
  const RoomRestrictionModel = createMemoryModel(restrictions);
  const ModerationAuditModel = createMemoryModel([]);
  const ModerationReportModel = createMemoryModel([]);
  const RoomMemberStateModel = createMemoryModel(roomStates);
  const UserExperienceStateModel = createMemoryModel(experienceStates);
  const createStoredMessage = MessageModel.create.bind(MessageModel);
  let nextMessageId = 500;
  let nextTimestamp = Date.parse('2026-08-10T14:00:00.000Z');
  MessageModel.create = value => createStoredMessage({
    _id: objectId(nextMessageId++),
    timestamp: new Date(nextTimestamp++),
    deleted: false,
    ...value
  });

  const dependencies = {
    ioInstance, onlineUsersMap, UserModel, ChatServerModel, MessageModel,
    RoomRestrictionModel, ModerationAuditModel, ModerationReportModel,
    RoomMemberStateModel, UserExperienceStateModel,
    bcryptImpl: { async compare() { return true; } },
    broadcastOnlineUsersFn: async () => {},
    getRoomRoleFn: async () => 'user',
    resolvePingsFn,
    logger
  };

  function registerSocket(id) {
    const socket = new FakeSocket();
    socket.id = id;
    createConnectionHandler(dependencies)(socket);
    ioInstance.sockets.push(socket);
    return socket;
  }

  function connect({
    id, username, role = 'user', serverCode = 'ABC123', joinedServers = ['global', 'ABC123'],
    blockedUsers = null, blockVersion = null
  }) {
    const socket = registerSocket(id);
    const durable = UserExperienceStateModel.rows.find(row => row.usernameKey === username.toLowerCase());
    const durableBlocked = (durable?.blockedUsers || []).map(entry => entry.usernameKey);
    const currentBlocks = blockedUsers || durableBlocked;
    const currentBlockVersion = blockVersion ?? durable?.blockVersion ?? 0;
    Object.assign(socket, {
      username, displayName: username, role, color: '', avatarUrl: '', serverCode,
      joinedServers: [...joinedServers], bannedRooms: [],
      blockedUserKeys: new Set(currentBlocks), blockVersion: currentBlockVersion
    });
    if (serverCode) socket.joinedRooms.add(serverCode);
    onlineUsersMap.set(id, {
      username, displayName: username, role, color: '', avatarUrl: '', serverCode,
      joinedServers: [...joinedServers], bannedRooms: [],
      blockedUsers: [...currentBlocks], blockVersion: currentBlockVersion
    });
    return socket;
  }

  return {
    ioInstance, onlineUsersMap, UserModel, ChatServerModel, MessageModel,
    RoomRestrictionModel, ModerationAuditModel, ModerationReportModel,
    RoomMemberStateModel, UserExperienceStateModel, registerSocket, connect
  };
}

async function updateNotification(socket, serverCode, level = 'all') {
  const ack = acknowledge();
  await socket.trigger('update_room_notification', { serverCode, level }, ack.callback);
  return ack.value();
}

async function markRead(socket, serverCode, messageId) {
  assert.equal(typeof socket.handlers.get('mark_room_read'), 'function', 'mark_room_read handler is registered');
  const ack = acknowledge();
  await socket.trigger('mark_room_read', { serverCode, messageId }, ack.callback);
  return ack.value();
}

function events(socket, event) {
  return socket.outbound.filter(item => item.event === event).map(item => item.payload);
}

test('exact unread counts include only newer messages from another unblocked author', async () => {
  const cursorAt = new Date('2026-08-10T12:00:00.000Z');
  const cursorId = objectId(10);
  const setup = createFixture({
    users: [user('Reader'), user('Other'), user('Blocked')],
    messages: [
      message(9, { username: 'Other', authorKey: 'other', timestamp: cursorAt }),
      message(10, { username: 'Other', authorKey: 'other', timestamp: cursorAt }),
      message(11, { username: 'Other', authorKey: 'other', timestamp: cursorAt }),
      message(12, { username: 'Reader', authorKey: 'reader', timestamp: cursorAt }),
      message(13, { username: 'Blocked', authorKey: 'blocked', timestamp: cursorAt }),
      message(14, { username: '<invalid>', authorKey: '', timestamp: cursorAt }),
      message(15, {
        username: 'Other', authorKey: 'other', deleted: true,
        timestamp: new Date('2026-08-10T12:01:00.000Z')
      })
    ],
    roomStates: [roomState('reader', 'ABC123', cursorAt, cursorId, { version: 3 })],
    experienceStates: [{
      usernameKey: 'reader', blockedUsers: [{ usernameKey: 'blocked', username: 'Blocked' }], blockVersion: 4
    }]
  });
  const reader = setup.connect({ id: 'reader', username: 'Reader' });

  const snapshot = await updateNotification(reader, 'ABC123');

  assert.equal(snapshot.unreadCount, 2);
  assert.equal(snapshot.mentionCount, 0);
  assert.equal(snapshot.blockVersion, 4);
});

test('exact room attention snapshots identify the newest committed message they already counted through', async () => {
  const cursorAt = new Date('2026-08-10T12:00:00.000Z');
  const countedThroughAt = new Date('2026-08-10T12:02:00.000Z');
  const countedThroughMessageId = objectId(19);
  const setup = createFixture({
    users: [user('Reader'), user('Other')],
    messages: [
      message(17, { username: 'Other', authorKey: 'other', timestamp: cursorAt }),
      message(18, {
        username: 'Other', authorKey: 'other', timestamp: new Date('2026-08-10T12:01:00.000Z')
      }),
      message(19, {
        username: 'Other', authorKey: 'other', timestamp: countedThroughAt
      })
    ],
    roomStates: [roomState('reader', 'ABC123', cursorAt, objectId(17), { version: 2 })]
  });
  const reader = setup.connect({ id: 'reader-counted-through', username: 'Reader' });

  const snapshot = await updateNotification(reader, 'ABC123', 'mentions');

  assert.equal(snapshot.unreadCount, 2);
  assert.equal(snapshot.countedThroughAt instanceof Date, true);
  assert.equal(snapshot.countedThroughAt.getTime(), countedThroughAt.getTime());
  assert.equal(snapshot.countedThroughMessageId, countedThroughMessageId);
  const event = events(reader, 'room_notification_updated').at(-1);
  assert.equal(event.countedThroughAt instanceof Date, true);
  assert.equal(event.countedThroughAt.getTime(), countedThroughAt.getTime());
  assert.equal(event.countedThroughMessageId, countedThroughMessageId);
});

test('exact mention counts use immutable usernames and everyone while deleted rows still count', async () => {
  const cursorAt = new Date('2026-08-10T12:00:00.000Z');
  const setup = createFixture({
    users: [user('Reader', { role: 'admin' }), user('Other')],
    messages: [
      message(21, {
        username: 'RenamedOther', authorKey: 'other', notificationMentions: ['reader'],
        text: 'edited without a mention', timestamp: new Date('2026-08-10T12:01:00.000Z')
      }),
      message(22, {
        username: 'Other', authorKey: 'other', notificationMentions: ['*'],
        timestamp: new Date('2026-08-10T12:02:00.000Z')
      }),
      message(23, {
        username: 'Other', authorKey: 'other', notificationMentions: [],
        text: '{{PING:Reader|Reader}}', timestamp: new Date('2026-08-10T12:03:00.000Z')
      }),
      message(24, {
        username: 'Reader', authorKey: 'reader', notificationMentions: ['reader'],
        timestamp: new Date('2026-08-10T12:04:00.000Z')
      })
    ],
    roomStates: [roomState('reader', 'ABC123', cursorAt, objectId(20))]
  });
  const reader = setup.connect({ id: 'reader', username: 'Reader', role: 'admin' });

  const snapshot = await updateNotification(reader, 'ABC123');
  assert.equal(typeof isNotificationMention, 'function');
  assert.equal(isNotificationMention(setup.MessageModel.rows[0], 'reader'), true);
  assert.equal(isNotificationMention(setup.MessageModel.rows[1], 'reader'), true);
  assert.equal(isNotificationMention(setup.MessageModel.rows[2], 'reader'), false);
  assert.deepEqual({ unreadCount: snapshot.unreadCount, mentionCount: snapshot.mentionCount }, {
    unreadCount: 3, mentionCount: 2
  });
  const deleteAck = acknowledge();
  await reader.trigger('delete_message', {
    id: objectId(21), serverCode: 'ABC123', clientContextId: 1
  }, deleteAck.callback);
  assert.equal(deleteAck.value().success, true);
  assert.equal(setup.MessageModel.rows[0].authorKey, 'other');
  assert.deepEqual(setup.MessageModel.rows[0].notificationMentions, ['reader']);
  assert.equal(setup.MessageModel.rows[0].timestamp.getTime(), Date.parse('2026-08-10T12:01:00.000Z'));
  const afterDelete = await updateNotification(reader, 'ABC123');
  assert.deepEqual({ unreadCount: afterDelete.unreadCount, mentionCount: afterDelete.mentionCount }, {
    unreadCount: 3, mentionCount: 2
  });

  const switchAck = acknowledge();
  reader.serverCode = 'global';
  setup.onlineUsersMap.get(reader.id).serverCode = 'global';
  await reader.trigger('switch_server', 'ABC123', switchAck.callback);
  const deleted = switchAck.value().history.find(row => row._id === objectId(21));
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.text, '');
  assert.equal(deleted.attachment, null);
  assert.equal(deleted.replyTo, null);
  assert.deepEqual(deleted.reactions, {});
  assert.equal(Object.prototype.hasOwnProperty.call(deleted, 'notificationMentions'), false);
});

test('blocked authors own messages system notices reactions pins and moderation never add activity', async () => {
  const setup = createFixture({
    users: [
      user('Author', { role: 'admin' }), user('Recipient'), user('Blocker'), user('Target')
    ],
    experienceStates: [{
      usernameKey: 'blocker', blockedUsers: [{ usernameKey: 'author', username: 'Author' }], blockVersion: 2
    }]
  });
  const author = setup.connect({ id: 'author', username: 'Author', role: 'admin' });
  const recipient = setup.connect({ id: 'recipient', username: 'Recipient', serverCode: 'global' });
  const blocker = setup.connect({ id: 'blocker', username: 'Blocker', serverCode: 'global' });

  await author.trigger('chat_message', { text: 'one durable message' });
  const stored = setup.MessageModel.rows[0];
  assert.equal(events(recipient, 'room_activity').length, 1);
  assert.equal(events(author, 'room_activity').length, 0);
  assert.equal(events(blocker, 'room_activity').length, 0);

  await author.trigger('toggle_reaction', { id: stored._id, emoji: '👍' });
  const pinAck = acknowledge();
  await author.trigger('set_message_pin', { serverCode: 'ABC123', messageId: stored._id, pinned: true }, pinAck.callback);
  await author.trigger('edit_message', { id: stored._id, text: 'edited later' });
  const moderationAck = acknowledge();
  await author.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'Target', action: 'timeout', duration: '10m', reason: 'policy test'
  }, moderationAck.callback);
  const deleteAck = acknowledge();
  await author.trigger('delete_message', { id: stored._id }, deleteAck.callback);

  assert.equal(events(recipient, 'room_activity').length, 1);
  assert.equal(events(blocker, 'room_activity').length, 0);
});

test('mark read rejects wrong-room IDs and monotonically advances timestamp then id', async () => {
  const cursorAt = new Date('2026-08-10T12:00:00.000Z');
  const newerAt = new Date('2026-08-10T12:01:00.000Z');
  const setup = createFixture({
    users: [user('Reader'), user('Other')],
    messages: [
      message(31, { username: 'Other', authorKey: 'other', timestamp: cursorAt }),
      message(32, { username: 'Other', authorKey: 'other', timestamp: cursorAt }),
      message(33, { username: 'Other', authorKey: 'other', timestamp: newerAt }),
      message(34, { serverCode: 'global', username: 'Other', authorKey: 'other', timestamp: newerAt }),
      message(35, { serverCode: '', username: 'Other', authorKey: 'other', timestamp: newerAt }),
      message(36, { serverCode: 'abc123', username: 'Other', authorKey: 'other', timestamp: newerAt })
    ],
    roomStates: [roomState('reader', 'ABC123', cursorAt, objectId(31), { version: 5 })]
  });
  const reader = setup.connect({ id: 'reader', username: 'Reader' });

  assert.deepEqual(await markRead(reader, 'ABC123', objectId(34)), { error: 'Permission denied.' });
  const tied = await markRead(reader, 'ABC123', objectId(32));
  assert.equal(tied.lastReadAt.getTime(), cursorAt.getTime());
  assert.equal(tied.lastReadMessageId, objectId(32));
  assert.equal(tied.version, 6);
  assert.equal(tied.unreadCount, 1);
  const newer = await markRead(reader, 'ABC123', objectId(33));
  assert.equal(newer.lastReadAt.getTime(), newerAt.getTime());
  assert.equal(newer.lastReadMessageId, objectId(33));
  assert.equal(newer.version, 7);
  assert.equal(newer.unreadCount, 0);
  reader.serverCode = 'global';
  setup.onlineUsersMap.get(reader.id).serverCode = 'global';
  assert.deepEqual(await markRead(reader, 'global', objectId(35)), { error: 'Permission denied.' });
  reader.serverCode = 'ABC123';
  setup.onlineUsersMap.get(reader.id).serverCode = 'ABC123';
  assert.deepEqual(await markRead(reader, 'ABC123', objectId(36)), { error: 'Permission denied.' });
});

test('duplicate and older mark-read requests are idempotent without version churn', async () => {
  const cursorAt = new Date('2026-08-10T12:00:00.000Z');
  const setup = createFixture({
    users: [user('Reader'), user('Other')],
    messages: [
      message(41, { username: 'Other', authorKey: 'other', timestamp: cursorAt }),
      message(42, { username: 'Other', authorKey: 'other', timestamp: cursorAt })
    ],
    roomStates: [roomState('reader', 'ABC123', cursorAt, objectId(42), {
      version: 8, notificationLevel: 'mentions'
    })]
  });
  const reader = setup.connect({ id: 'reader', username: 'Reader' });

  const duplicate = await markRead(reader, 'ABC123', objectId(42));
  const older = await markRead(reader, 'ABC123', objectId(41));

  assert.deepEqual(older, duplicate);
  assert.equal(older.version, 8);
  assert.equal(setup.RoomMemberStateModel.rows[0].version, 8);
  assert.equal(events(reader, 'room_read_updated').every(state => state.version === 8), true);
});

test('notification and read updates cannot lose each other under their shared version', async () => {
  const cursorAt = new Date('2026-08-10T12:00:00.000Z');
  const setup = createFixture({
    users: [user('Reader'), user('Other')],
    messages: [
      message(51, { username: 'Other', authorKey: 'other', timestamp: cursorAt }),
      message(52, {
        username: 'Other', authorKey: 'other', timestamp: new Date('2026-08-10T12:01:00.000Z')
      })
    ],
    roomStates: [roomState('reader', 'ABC123', cursorAt, objectId(51))]
  });
  const readerOne = setup.connect({ id: 'reader-one', username: 'Reader' });
  const readerTwo = setup.connect({ id: 'reader-two', username: 'READER' });
  const notificationStarted = deferred();
  const releaseNotification = deferred();
  const baseUpdate = setup.RoomMemberStateModel.findOneAndUpdate.bind(setup.RoomMemberStateModel);
  let held = false;
  setup.RoomMemberStateModel.findOneAndUpdate = (query, update, options) => {
    if (!held && update?.$set?.notificationLevel === 'none') {
      held = true;
      return {
        then(resolve, reject) {
          notificationStarted.resolve();
          return releaseNotification.promise
            .then(() => baseUpdate(query, update, options))
            .then(resolve, reject);
        }
      };
    }
    return baseUpdate(query, update, options);
  };

  const notificationAck = acknowledge();
  const notificationPending = readerOne.trigger(
    'update_room_notification', { serverCode: 'ABC123', level: 'none' }, notificationAck.callback
  );
  await notificationStarted.promise;
  assert.equal(typeof readerTwo.handlers.get('mark_room_read'), 'function', 'mark_room_read handler is registered');
  const readAck = acknowledge();
  const readPending = readerTwo.trigger(
    'mark_room_read', { serverCode: 'ABC123', messageId: objectId(52) }, readAck.callback
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readAck.value(), undefined);
  releaseNotification.resolve();
  await Promise.all([notificationPending, readPending]);

  assert.equal(notificationAck.value().version, 1);
  assert.equal(readAck.value().version, 2);
  assert.equal(readAck.value().notificationLevel, 'none');
  assert.equal(readAck.value().lastReadMessageId, objectId(52));
  assert.equal(events(readerOne, 'room_read_updated').at(-1).version, 2);
  assert.equal(events(readerTwo, 'room_notification_updated').at(-1).version, 1);
});

test('Global counts include legacy room rows only after a feature cursor and new sends remain canonical', async () => {
  const cursorAt = new Date('2026-08-10T12:00:00.000Z');
  const setup = createFixture({
    users: [user('Reader', { servers: ['global'] }), user('Author', { servers: ['global'] })],
    rooms: [room('global')],
    messages: [message(61, {
      serverCode: 'global', username: 'Author', authorKey: 'author', timestamp: cursorAt
    })],
    roomStates: [roomState('reader', 'global', cursorAt, objectId(61))]
  });
  setup.MessageModel.rows.push(
    message(62, {
      serverCode: undefined, username: 'Author', authorKey: 'author', notificationMentions: ['reader'],
      timestamp: new Date('2026-08-10T12:01:00.000Z')
    }),
    message(63, {
      serverCode: null, username: 'Author', authorKey: 'author', notificationMentions: [],
      timestamp: new Date('2026-08-10T12:02:00.000Z')
    }),
    message(64, {
      serverCode: 'global', username: 'Author', authorKey: 'author', notificationMentions: ['*'],
      timestamp: new Date('2026-08-10T12:03:00.000Z')
    })
  );
  const reader = setup.connect({
    id: 'reader', username: 'Reader', serverCode: 'global', joinedServers: ['global']
  });
  const author = setup.connect({
    id: 'author', username: 'Author', serverCode: 'global', joinedServers: ['global']
  });

  const snapshot = await updateNotification(reader, 'global');
  assert.deepEqual({ unreadCount: snapshot.unreadCount, mentionCount: snapshot.mentionCount }, {
    unreadCount: 3, mentionCount: 2
  });
  await author.trigger('chat_message', { text: 'new canonical Global message' });
  assert.equal(setup.MessageModel.rows.at(-1).serverCode, 'global');
  assert.equal(setup.MessageModel.rows.at(-1).authorKey, 'author');
});

test('out-of-order read and activity operations converge on the newest cursor and exact counts', async () => {
  const cursorAt = new Date('2026-08-10T12:00:00.000Z');
  const setup = createFixture({
    users: [user('Reader'), user('Author')],
    messages: [
      message(71, { timestamp: cursorAt }),
      message(72, { timestamp: new Date('2026-08-10T12:01:00.000Z') }),
      message(73, { timestamp: new Date('2026-08-10T12:02:00.000Z') })
    ],
    roomStates: [roomState('reader', 'ABC123', cursorAt, objectId(71), { version: 4 })]
  });
  const readerOne = setup.connect({ id: 'reader-one', username: 'Reader' });
  const readerTwo = setup.connect({ id: 'reader-two', username: 'READER' });
  const author = setup.connect({ id: 'author', username: 'Author' });
  await author.trigger('chat_message', { text: 'newest live activity' });
  const newestMessageId = setup.MessageModel.rows.at(-1)._id;
  assert.equal(events(readerOne, 'room_activity').at(-1).messageId, newestMessageId);

  const newestPending = markRead(readerOne, 'ABC123', newestMessageId);
  const olderPending = markRead(readerTwo, 'ABC123', objectId(72));
  const [newest, older] = await Promise.all([newestPending, olderPending]);

  assert.equal(newest.lastReadMessageId, newestMessageId);
  assert.equal(older.lastReadMessageId, newestMessageId);
  assert.equal(older.version, 5);
  assert.equal(older.unreadCount, 0);
  for (const live of [readerOne, readerTwo]) {
    assert.equal(events(live, 'room_read_updated').at(-1).lastReadMessageId, newestMessageId);
  }
});

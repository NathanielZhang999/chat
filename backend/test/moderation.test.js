const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MODERATION_DURATIONS,
  normalizeModerationAction,
  normalizeModerationReason,
  normalizeAutoModSettings,
  normalizeStoredAutoModSettings,
  normalizeAccountKey,
  createAutoModTracker,
  evaluateAutoMod,
  evaluateMessageRate,
  findUserByUsername,
  withAccountTransitionLocks,
  withAccountTransitionLock,
  canModerateTarget,
  canEditRoomDetails,
  canManagePins,
  safeMessageForViewer,
  activeRestrictionState,
  applySessionAccessSnapshot,
  rejectAuditMutation,
  ModerationReport,
  createConnectionHandler
} = require('../server');
const { FakeSocket, FakeIo, createMemoryModel, acknowledge, deferred } = require('./support/fakes');

const VALID_MESSAGE_ID = '507f1f77bcf86cd799439011';

test('complete pin permission matrix respects bans timeouts exact-room roles and Global policy', () => {
  function access({
    username = 'Actor', role = 'user', allowed = true, banned = false, timedOut = false,
    owner = 'Owner', moderators = []
  } = {}) {
    return {
      allowed,
      user: { username, role },
      room: { code: 'ABC123', owner, moderators },
      restriction: { banned, timedOut }
    };
  }
  const cases = [
    ['private owner', 'ABC123', access({ username: 'Owner' }), true],
    ['exact moderator', 'ABC123', access({ username: 'ExactMod', moderators: ['ExactMod'] }), true],
    ['global admin in private room', 'ABC123', access({ role: 'admin' }), true],
    ['ordinary member', 'ABC123', access(), false],
    ['other-room moderator', 'ABC123', access({ username: 'OtherMod', moderators: ['ExactMod'] }), false],
    ['banned admin', 'ABC123', access({ role: 'admin', banned: true }), false],
    ['timed-out owner', 'ABC123', access({ username: 'Owner', timedOut: true }), false],
    ['nonaccess admin', 'ABC123', access({ role: 'admin', allowed: false }), false],
    ['Global admin', 'global', access({ role: 'admin' }), true],
    ['Global owner-shaped user', 'global', access({ username: 'Owner' }), false],
    ['Global moderator-shaped user', 'global', access({ username: 'ExactMod', moderators: ['ExactMod'] }), false]
  ];
  for (const [label, serverCode, candidate, expected] of cases) {
    const exactRoomAccess = { ...candidate, room: { ...candidate.room, code: serverCode } };
    assert.equal(canManagePins({ serverCode, access: exactRoomAccess }), expected, label);
  }
});

function saveableDocument(value) {
  const document = { ...value };
  Object.defineProperties(document, {
    markModified: { value: () => {}, enumerable: false },
    save: { value: async () => document, enumerable: false }
  });
  return document;
}

function preserveAttentionProjection(MessageModel) {
  const find = MessageModel.find.bind(MessageModel);
  MessageModel.find = (query = {}) => {
    const result = find(query);
    if (!Array.isArray(query.$and)) return result;
    return {
      async select() {
        return (await result).map(row => ({
          _id: row._id, serverCode: row.serverCode, timestamp: row.timestamp,
          username: row.username, authorKey: row.authorKey,
          notificationMentions: Array.isArray(row.notificationMentions)
            ? [...row.notificationMentions] : row.notificationMentions,
          deleted: row.deleted
        }));
      }
    };
  };
}

function userDocument(overrides = {}) {
  return saveableDocument({
    username: 'Alice', displayName: 'Alice', password: 'hash', role: 'user', servers: ['global'],
    ...overrides
  });
}

function roomDocument(code, overrides = {}) {
  return saveableDocument({
    code, name: code === 'global' ? 'Global Chat' : code, owner: 'Owner', moderators: [],
    autoMod: { blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30 },
    ...overrides
  });
}

function restrictionDocument(serverCode, username, overrides = {}) {
  return saveableDocument({
    serverCode, username: username.normalize('NFKC').trim().toLowerCase(), bannedAt: null, timeoutUntil: null, ...overrides
  });
}

let nextModerationFixtureId = 100;

function createModerationApiModel(initialRows = [], { defaults = {} } = {}) {
  const rows = initialRows.map(row => ({ ...defaults, ...row }));

  function valueTime(value) {
    return value instanceof Date ? value.getTime() : value;
  }

  function valuesMatch(value, expected) {
    if (expected === null) return value === null || value === undefined;
    if (expected instanceof RegExp) return expected.test(String(value || ''));
    if (expected instanceof Date) return value instanceof Date && value.getTime() === expected.getTime();
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$in' in expected) return expected.$in.some(candidate => valuesMatch(value, candidate));
      if ('$lt' in expected && !(valueTime(value) < valueTime(expected.$lt))) return false;
      if ('$gt' in expected && !(valueTime(value) > valueTime(expected.$gt))) return false;
      if ('$ne' in expected && valuesMatch(value, expected.$ne)) return false;
      if ('$regex' in expected && !valuesMatch(value, expected.$regex)) return false;
      return true;
    }
    return value === expected;
  }

  function matches(row, query = {}) {
    return Object.entries(query).every(([key, expected]) => {
      if (key === '$or') return Array.isArray(expected) && expected.some(clause => matches(row, clause));
      if (key === '$and') return Array.isArray(expected) && expected.every(clause => matches(row, clause));
      return valuesMatch(row[key], expected);
    });
  }

  function documentFor(row) {
    if (!row) return null;
    const document = { ...row };
    Object.defineProperties(document, {
      markModified: { value: () => {}, enumerable: false },
      save: {
        value: async () => {
          Object.assign(row, document, { updatedAt: new Date() });
          return documentFor(row);
        },
        enumerable: false
      }
    });
    return document;
  }

  function queryResult(values) {
    let current = values;
    const query = {
      sort(spec = {}) {
        const entries = Object.entries(spec);
        current = [...current].sort((left, right) => {
          for (const [key, direction] of entries) {
            const leftValue = valueTime(left[key]);
            const rightValue = valueTime(right[key]);
            if (leftValue < rightValue) return -1 * direction;
            if (leftValue > rightValue) return 1 * direction;
          }
          return 0;
        });
        return query;
      },
      limit(value) { current = current.slice(0, value); return query; },
      select() { return query; },
      lean: async () => current.map(row => ({ ...row })),
      then(resolve, reject) {
        return Promise.resolve(current.map(documentFor)).then(resolve, reject);
      }
    };
    return query;
  }

  return {
    rows,
    find(query = {}) { return queryResult(rows.filter(row => matches(row, query))); },
    findOne(query = {}) { return Promise.resolve(documentFor(rows.find(row => matches(row, query)))); },
    findById(id) { return Promise.resolve(documentFor(rows.find(row => String(row._id) === String(id)))); },
    async create(value) {
      const now = new Date();
      const row = {
        ...defaults,
        _id: (++nextModerationFixtureId).toString(16).padStart(24, '0'),
        createdAt: now,
        updatedAt: now,
        ...value
      };
      rows.push(row);
      return documentFor(row);
    },
    async countDocuments(query = {}) { return rows.filter(row => matches(row, query)).length; },
    async findOneAndUpdate(query, update, options = {}) {
      let row = rows.find(candidate => matches(candidate, query));
      if (!row && options.upsert) {
        row = { ...defaults, ...query };
        rows.push(row);
      }
      if (!row) return null;
      Object.assign(row, update.$set || update, { updatedAt: new Date() });
      return documentFor(row);
    },
    async updateOne(query, update) {
      const row = rows.find(candidate => matches(candidate, query));
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(row, update.$set || update, { updatedAt: new Date() });
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async updateMany(_query, update) {
      for (const row of rows) {
        if (update.$pull?.servers) {
          row.servers = (Array.isArray(row.servers) ? row.servers : [])
            .filter(code => code !== update.$pull.servers);
        }
      }
    },
    async deleteOne(query) {
      const index = rows.findIndex(row => matches(row, query));
      if (index >= 0) rows.splice(index, 1);
    },
    async deleteMany(query) {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (matches(rows[index], query)) rows.splice(index, 1);
      }
    }
  };
}

function registerWithModels(seed = {}) {
  const socket = new FakeSocket();
  const ioInstance = new FakeIo();
  const MessageModel = seed.MessageModel || createMemoryModel(seed.messages || []);
  MessageModel.created = [];
  const createMessage = MessageModel.create.bind(MessageModel);
  MessageModel.create = async value => {
    const created = await createMessage(value);
    MessageModel.created.push(created);
    return created;
  };
  const setup = {
    socket,
    ioInstance,
    onlineUsersMap: seed.onlineUsersMap || new Map(),
    UserModel: seed.UserModel || createMemoryModel(seed.users || (seed.user ? [seed.user] : [])),
    ChatServerModel: seed.ChatServerModel || createMemoryModel(seed.rooms || []),
    MessageModel,
    RoomRestrictionModel: seed.RoomRestrictionModel || createMemoryModel(seed.restrictions || []),
    ModerationAuditModel: seed.ModerationAuditModel || createMemoryModel(seed.audits || []),
    ModerationReportModel: seed.ModerationReportModel || createMemoryModel(seed.reports || []),
    RoomMemberStateModel: seed.RoomMemberStateModel || createMemoryModel(seed.roomStates || []),
    UserExperienceStateModel: seed.UserExperienceStateModel || createMemoryModel(seed.experienceStates || []),
    autoModTracker: seed.autoModTracker || createAutoModTracker()
  };
  for (const model of [setup.RoomRestrictionModel, setup.ModerationReportModel]) {
    if (typeof model.deleteMany === 'function' || !Array.isArray(model.rows)) continue;
    model.deleteMany = async query => {
      for (let index = model.rows.length - 1; index >= 0; index -= 1) {
        if (Object.entries(query).every(([key, value]) => model.rows[index][key] === value)) {
          model.rows.splice(index, 1);
        }
      }
    };
  }
  createConnectionHandler({
    ...setup,
    bcryptImpl: { async compare() { return true; }, async hash(value) { return value; } },
    broadcastOnlineUsersFn: seed.broadcastOnlineUsersFn || (async () => {}),
    getRoomRoleFn: seed.getRoomRoleFn || (async () => 'user'),
    resolvePingsFn: seed.resolvePingsFn || (async text => text),
    logger: seed.logger || { error() {} }
  })(socket);
  ioInstance.sockets.push(socket);
  return setup;
}

function connectAdditionalSocket(setup, {
  id,
  username,
  serverCode,
  joinedServers,
  role = 'user',
  bannedRooms = []
}) {
  const live = new FakeSocket();
  live.id = id;
  Object.assign(live, {
    username,
    displayName: username,
    role,
    serverCode,
    joinedServers: [...joinedServers],
    bannedRooms: [...bannedRooms]
  });
  if (serverCode) live.joinedRooms.add(serverCode);
  setup.onlineUsersMap.set(id, {
    username,
    displayName: username,
    role,
    serverCode,
    joinedServers: [...joinedServers],
    bannedRooms: [...bannedRooms]
  });
  createConnectionHandler({
    ...setup,
    bcryptImpl: { async compare() { return true; }, async hash(value) { return value; } },
    broadcastOnlineUsersFn: async () => {},
    getRoomRoleFn: async () => 'user',
    resolvePingsFn: async text => text,
    logger: { error() {} }
  })(live);
  Object.assign(live, {
    username,
    displayName: username,
    role,
    serverCode,
    joinedServers: [...joinedServers],
    bannedRooms: [...bannedRooms]
  });
  if (serverCode) live.joinedRooms.add(serverCode);
  setup.ioInstance.sockets.push(live);
  return live;
}

function reportingScenario({ reporter = 'Alice', room = 'ABC123', target = 'Bob' } = {}) {
  const users = [
    userDocument({ username: reporter, displayName: reporter, servers: ['global', 'ABC123', 'XYZ789'] }),
    userDocument({ username: target, displayName: target, servers: ['global', 'ABC123', 'XYZ789'] }),
    userDocument({ username: 'ExactMod', displayName: 'ExactMod', servers: ['global', 'ABC123', 'XYZ789'] }),
    userDocument({ username: 'OtherMod', displayName: 'OtherMod', servers: ['global', 'ABC123', 'XYZ789'] }),
    userDocument({ username: 'OrdinaryMember', displayName: 'OrdinaryMember', servers: ['global', 'ABC123', 'XYZ789'] })
  ];
  const rooms = [
    roomDocument('global', { owner: 'System' }),
    roomDocument('ABC123', { moderators: ['ExactMod'] }),
    roomDocument('XYZ789', { moderators: ['OtherMod'] })
  ];
  const UserModel = createModerationApiModel(users);
  const ChatServerModel = createModerationApiModel(rooms);
  const MessageModel = createModerationApiModel([{
    _id: VALID_MESSAGE_ID,
    serverCode: room,
    username: target,
    displayName: target,
    text: 'room-scoped evidence',
    timestamp: new Date('2026-08-08T12:00:00.000Z')
  }]);
  const RoomRestrictionModel = createModerationApiModel([]);
  const ModerationAuditModel = createModerationApiModel([]);
  const ModerationReportModel = createModerationApiModel([], { defaults: { status: 'open' } });
  const setup = registerWithModels({
    UserModel,
    ChatServerModel,
    MessageModel,
    RoomRestrictionModel,
    ModerationAuditModel,
    ModerationReportModel
  });
  Object.assign(setup.socket, {
    username: reporter,
    displayName: reporter,
    role: 'user',
    roomRole: 'user',
    serverCode: room,
    joinedServers: ['global', 'ABC123', 'XYZ789'],
    bannedRooms: []
  });
  setup.socket.joinedRooms.add(room);
  setup.onlineUsersMap.set(setup.socket.id, {
    username: reporter,
    displayName: reporter,
    role: 'user',
    serverCode: room,
    joinedServers: ['global', 'ABC123', 'XYZ789'],
    bannedRooms: []
  });
  const modSocket = connectAdditionalSocket(setup, {
    id: 'exact-mod', username: 'ExactMod', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  modSocket.roomRole = 'mod';
  const otherModSocket = connectAdditionalSocket(setup, {
    id: 'other-mod', username: 'OtherMod', serverCode: 'XYZ789',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  otherModSocket.roomRole = 'mod';
  const memberSocket = connectAdditionalSocket(setup, {
    id: 'ordinary-member', username: 'OrdinaryMember', serverCode: room,
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const models = {
    UserModel,
    ChatServerModel,
    MessageModel,
    RoomRestrictionModel,
    ModerationAuditModel,
    ModerationReportModel
  };
  return { ...setup, modSocket, otherModSocket, memberSocket, models };
}

function moderationScenario({
  room = 'ABC123', actor = 'admin', action = 'kick', logger,
  ModerationAuditModel, RoomRestrictionModel, broadcastOnlineUsersFn
} = {}) {
  const actorProfiles = {
    admin: { username: 'Admin', role: 'admin' },
    mod: { username: 'RoomMod', role: 'user' },
    'mod-from-ABC123': { username: 'ABCMod', role: 'user' }
  };
  const actorProfile = actorProfiles[actor] || actorProfiles.admin;
  const target = userDocument({
    username: 'TargetUser', displayName: 'Target User',
    servers: ['global', 'ABC123', 'XYZ789']
  });
  const abcModerators = ['RoomMod', 'ABCMod'];
  if (actor === 'mod' && action === 'timeout') abcModerators.push(target.username);
  const restrictions = [];
  if (action === 'unban') restrictions.push(restrictionDocument(room, target.username, {
    bannedAt: new Date('2026-08-08T12:00:00.000Z'),
    bannedBy: 'Admin',
    banReason: 'existing ban'
  }));
  if (action === 'clear_timeout') restrictions.push(restrictionDocument(room, target.username, {
    timeoutUntil: new Date(Date.now() + 60_000),
    timeoutBy: 'Admin',
    timeoutReason: 'existing timeout'
  }));
  const setup = registerWithModels({
    users: [
      userDocument({ username: actorProfile.username, displayName: actorProfile.username, role: actorProfile.role, servers: ['global', 'ABC123', 'XYZ789'] }),
      target
    ],
    rooms: [
      roomDocument('global', { owner: 'System' }),
      roomDocument('ABC123', { moderators: abcModerators }),
      roomDocument('XYZ789')
    ],
    restrictions,
    logger,
    ModerationAuditModel,
    RoomRestrictionModel,
    broadcastOnlineUsersFn
  });
  Object.assign(setup.socket, {
    username: actorProfile.username,
    displayName: actorProfile.username,
    role: actorProfile.role,
    serverCode: room,
    joinedServers: ['global', 'ABC123', 'XYZ789'],
    bannedRooms: []
  });
  setup.socket.joinedRooms.add(room);
  setup.onlineUsersMap.set(setup.socket.id, {
    username: actorProfile.username,
    displayName: actorProfile.username,
    role: actorProfile.role,
    serverCode: room,
    joinedServers: ['global', 'ABC123', 'XYZ789'],
    bannedRooms: []
  });
  const models = {
    UserModel: setup.UserModel,
    ChatServerModel: setup.ChatServerModel,
    MessageModel: setup.MessageModel,
    RoomRestrictionModel: setup.RoomRestrictionModel,
    ModerationAuditModel: setup.ModerationAuditModel,
    ModerationReportModel: setup.ModerationReportModel
  };
  return { ...setup, target, models };
}

function authenticatedRoomSocket({ joinedServers = ['global', 'ABC123'], serverCode = 'global', username = 'Alice' } = {}) {
  const setup = registerWithModels({
    user: userDocument({ username, servers: joinedServers }),
    rooms: joinedServers.map(code => roomDocument(code))
  });
  setup.socket.username = username;
  setup.socket.displayName = username;
  setup.socket.role = 'user';
  setup.socket.serverCode = serverCode;
  setup.socket.joinedServers = [...joinedServers];
  setup.socket.joinedRooms.add(serverCode);
  setup.onlineUsersMap.set(setup.socket.id, {
    username,
    displayName: username,
    role: 'user',
    serverCode,
    joinedServers: [...joinedServers],
    bannedRooms: []
  });
  return setup;
}

function authenticatedLobbySocket({ username = 'Alice', bannedRooms = [] } = {}) {
  const setup = registerWithModels({
    user: userDocument({ username, servers: ['global'] }),
    rooms: [roomDocument('global'), roomDocument('ABC123')],
    restrictions: bannedRooms.map(code => restrictionDocument(code, username, { bannedAt: new Date() }))
  });
  setup.socket.username = username;
  setup.socket.displayName = username;
  setup.socket.role = 'user';
  setup.socket.serverCode = null;
  setup.socket.joinedServers = [];
  setup.socket.bannedRooms = [...bannedRooms];
  setup.onlineUsersMap.set(setup.socket.id, {
    username,
    displayName: username,
    role: 'user',
    serverCode: null,
    joinedServers: [],
    bannedRooms: [...bannedRooms]
  });
  return setup;
}

function timedOutAuthenticatedSocket(serverCode, username) {
  const message = saveableDocument({
    _id: VALID_MESSAGE_ID,
    serverCode,
    username,
    displayName: username,
    role: 'user',
    roomRole: 'user',
    text: 'original',
    history: [],
    reactions: {},
    deleted: false
  });
  const setup = authenticatedRoomSocket({ joinedServers: ['global', serverCode], serverCode, username });
  setup.RoomRestrictionModel.rows.push(restrictionDocument(serverCode, username, {
    timeoutUntil: new Date(Date.now() + 60_000)
  }));
  setup.MessageModel.findById = async () => message;
  return { ...setup, message };
}

test('ordinary member can report only a target or message in an accessible room', async () => {
  const setup = reportingScenario({ reporter: 'Alice', room: 'ABC123', target: 'Bob' });
  const ack = acknowledge();
  await setup.socket.trigger('report_moderation_target', {
    serverCode: 'ABC123', targetUser: 'Bob', messageId: VALID_MESSAGE_ID,
    reason: 'repeated personal attacks'
  }, ack.callback);

  assert.equal(ack.value().success, true);
  assert.equal(setup.ModerationReportModel.rows.length, 1);
  assert.deepEqual({
    serverCode: setup.ModerationReportModel.rows[0].serverCode,
    reporterUsername: setup.ModerationReportModel.rows[0].reporterUsername,
    targetUsername: setup.ModerationReportModel.rows[0].targetUsername,
    messageId: setup.ModerationReportModel.rows[0].messageId,
    reason: setup.ModerationReportModel.rows[0].reason,
    status: setup.ModerationReportModel.rows[0].status
  }, {
    serverCode: 'ABC123', reporterUsername: 'Alice', targetUsername: 'Bob',
    messageId: VALID_MESSAGE_ID, reason: 'repeated personal attacks', status: 'open'
  });
  assert.equal(setup.ioInstance.outbound.some(item => item.room === 'ABC123' && item.event === 'moderation_queue_updated'), false);
  assert.equal(setup.memberSocket.outbound.some(item => item.event === 'moderation_queue_updated'), false);
  assert.equal(setup.otherModSocket.outbound.some(item => item.event === 'moderation_queue_updated'), false);
  assert.equal(setup.modSocket.outbound.some(item => item.event === 'moderation_queue_updated'), true);
  assert.deepEqual(
    setup.modSocket.outbound.find(item => item.event === 'moderation_queue_updated').payload,
    { serverCode: 'ABC123' }
  );
});

test('report validation resolves canonical users and rejects missing or mismatched message evidence', async () => {
  const canonical = reportingScenario();
  const canonicalAck = acknowledge();
  await canonical.socket.trigger('report_moderation_target', {
    serverCode: 'abc123', targetUser: 'bOb', reason: '  Ｆｕｌｌ width abuse  '
  }, canonicalAck.callback);
  assert.equal(canonicalAck.value().success, true);
  assert.equal(canonical.ModerationReportModel.rows[0].targetUsername, 'Bob');
  assert.equal(canonical.ModerationReportModel.rows[0].reason, 'Full width abuse');
  assert.equal(canonical.ModerationReportModel.rows[0].messageId, null);

  for (const scenario of [
    { name: 'missing target', mutate() {}, request: { targetUser: 'MissingUser' } },
    {
      name: 'missing message',
      mutate() {},
      request: { targetUser: 'Bob', messageId: '507f1f77bcf86cd799439012' }
    },
    {
      name: 'other-room message',
      mutate(setup) {
        setup.MessageModel.rows.push({
          _id: '507f1f77bcf86cd799439013', serverCode: 'XYZ789', username: 'Bob'
        });
      },
      request: { targetUser: 'Bob', messageId: '507f1f77bcf86cd799439013' }
    },
    {
      name: 'other-author message',
      mutate(setup) {
        setup.MessageModel.rows.push({
          _id: '507f1f77bcf86cd799439014', serverCode: 'ABC123', username: 'OrdinaryMember'
        });
      },
      request: { targetUser: 'Bob', messageId: '507f1f77bcf86cd799439014' }
    }
  ]) {
    const setup = reportingScenario();
    scenario.mutate(setup);
    const ack = acknowledge();
    await setup.socket.trigger('report_moderation_target', {
      serverCode: 'ABC123', reason: scenario.name, ...scenario.request
    }, ack.callback);
    assert.equal(Boolean(ack.value().error), true, scenario.name);
    assert.equal(setup.ModerationReportModel.rows.length, 0, scenario.name);
  }
});

test('report reason is 1-300 characters after NFKC normalization', async () => {
  for (const [reason, accepted] of [
    [' ', false],
    ['x'.repeat(300), true],
    ['x'.repeat(301), false],
    ['  valid normalized reason  ', true]
  ]) {
    const setup = reportingScenario();
    const ack = acknowledge();
    await setup.socket.trigger('report_moderation_target', {
      serverCode: 'ABC123', targetUser: 'Bob', reason
    }, ack.callback);
    assert.equal(Boolean(ack.value().success), accepted, `reason length ${reason.trim().length}`);
    assert.equal(setup.ModerationReportModel.rows.length, accepted ? 1 : 0);
  }
});

test('report schema enforces one canonical open report across MongoDB processes', () => {
  const duplicateIndex = ModerationReport.schema.indexes().find(([, options]) =>
    options.unique === true && options.partialFilterExpression?.status === 'open'
  );
  assert.deepEqual(duplicateIndex, [
    { reporterUsername: 1, serverCode: 1, targetUsername: 1, messageId: 1, status: 1 },
    { unique: true, partialFilterExpression: { status: 'open' }, background: true }
  ]);
});

test('report account lock serializes duplicate detection and the rolling daily limit', async () => {
  const duplicateSetup = reportingScenario();
  const firstAck = acknowledge();
  const secondAck = acknowledge();
  const request = {
    serverCode: 'ABC123', targetUser: 'Bob', messageId: VALID_MESSAGE_ID,
    reason: 'same open report'
  };
  await Promise.all([
    duplicateSetup.socket.trigger('report_moderation_target', request, firstAck.callback),
    duplicateSetup.socket.trigger('report_moderation_target', request, secondAck.callback)
  ]);
  assert.equal([firstAck.value(), secondAck.value()].filter(result => result.success).length, 1);
  assert.equal([firstAck.value(), secondAck.value()].filter(result => result.error).length, 1);
  assert.equal(duplicateSetup.ModerationReportModel.rows.length, 1);

  const limitedSetup = reportingScenario();
  const now = Date.now();
  for (let index = 0; index < 10; index += 1) {
    limitedSetup.ModerationReportModel.rows.push({
      _id: (index + 1).toString(16).padStart(24, '0'),
      serverCode: 'XYZ789', reporterUsername: 'Alice', targetUsername: `Prior${index}`,
      messageId: null, reason: 'prior report', status: 'open', createdAt: new Date(now - index * 1000)
    });
  }
  const limitedAck = acknowledge();
  await limitedSetup.socket.trigger('report_moderation_target', {
    serverCode: 'ABC123', targetUser: 'Bob', reason: 'eleventh rolling report'
  }, limitedAck.callback);
  assert.equal(Boolean(limitedAck.value().error), true);
  assert.equal(limitedSetup.ModerationReportModel.rows.length, 10);
});

test('report account lock makes the rolling cap atomic across concurrent submissions in different rooms', async () => {
  const setup = reportingScenario();
  const otherRoomMessageId = '507f1f77bcf86cd799439012';
  setup.MessageModel.rows.push({
    _id: otherRoomMessageId,
    serverCode: 'XYZ789',
    username: 'Bob',
    displayName: 'Bob',
    text: 'other-room evidence',
    timestamp: new Date('2026-08-08T12:01:00.000Z')
  });
  const now = Date.now();
  for (let index = 0; index < 9; index += 1) {
    setup.ModerationReportModel.rows.push({
      _id: (index + 20).toString(16).padStart(24, '0'),
      serverCode: 'XYZ789', reporterUsername: 'Alice', targetUsername: `Prior${index}`,
      messageId: null, reason: 'prior report', status: 'open', createdAt: new Date(now - index * 1000)
    });
  }

  const firstCountStarted = deferred();
  const releaseFirstCount = deferred();
  const baseCountDocuments = setup.ModerationReportModel.countDocuments.bind(setup.ModerationReportModel);
  let gateFirstRollingCount = true;
  setup.ModerationReportModel.countDocuments = async query => {
    const snapshot = await baseCountDocuments(query);
    if (gateFirstRollingCount && query.reporterUsername === 'Alice') {
      gateFirstRollingCount = false;
      firstCountStarted.resolve();
      await releaseFirstCount.promise;
    }
    return snapshot;
  };

  const firstAck = acknowledge();
  const secondAck = acknowledge();
  const firstPending = setup.socket.trigger('report_moderation_target', {
    serverCode: 'ABC123', targetUser: 'Bob', messageId: VALID_MESSAGE_ID,
    reason: 'first distinct report at the cap'
  }, firstAck.callback);
  await firstCountStarted.promise;
  const secondPending = setup.socket.trigger('report_moderation_target', {
    serverCode: 'XYZ789', targetUser: 'bOb', messageId: otherRoomMessageId,
    reason: 'second distinct room report at the cap'
  }, secondAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  releaseFirstCount.resolve();
  await Promise.all([firstPending, secondPending]);

  const results = [firstAck.value(), secondAck.value()];
  assert.deepEqual({
    successes: results.filter(result => result.success).length,
    limitErrors: results.filter(result => result.error === 'Too many reports.').length,
    totalRows: setup.ModerationReportModel.rows.length
  }, { successes: 1, limitErrors: 1, totalRows: 10 });
});

test('report and moderation reads deny ordinary and wrong-room moderators without leaking counts', async () => {
  const setup = reportingScenario();
  const reportId = '507f1f77bcf86cd799439021';
  setup.ModerationReportModel.rows.push({
    _id: reportId, serverCode: 'ABC123', reporterUsername: 'Alice', targetUsername: 'Bob',
    messageId: null, reason: 'private report reason', status: 'open',
    createdAt: new Date('2026-08-08T12:00:00.000Z')
  });
  setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'bob', {
    bannedAt: new Date('2026-08-08T12:00:00.000Z'), banReason: 'private ban reason',
    createdAt: new Date('2026-08-08T12:00:00.000Z')
  }));
  setup.ModerationAuditModel.rows.push({
    _id: '507f1f77bcf86cd799439022', correlationId: 'audit-private', action: 'ban',
    serverCode: 'ABC123', actorUsername: 'ExactMod', reason: 'private audit reason',
    createdAt: new Date('2026-08-08T12:00:00.000Z')
  });
  const requests = [
    ['list_moderation_reports', { serverCode: 'ABC123', status: 'open' }],
    ['resolve_moderation_report', { serverCode: 'ABC123', reportId, status: 'resolved', resolution: 'handled privately' }],
    ['list_room_restrictions', { serverCode: 'ABC123' }],
    ['get_moderation_audit', { serverCode: 'ABC123' }],
    ['get_automod', { serverCode: 'ABC123' }]
  ];
  for (const [event, payload] of requests) {
    const ack = acknowledge();
    await setup.memberSocket.trigger(event, payload, ack.callback);
    assert.deepEqual(ack.value(), { error: 'Permission denied.' }, event);
    assert.equal(JSON.stringify(ack.value()).includes('count'), false, event);
    assert.equal(JSON.stringify(ack.value()).includes('private'), false, event);
  }

  const wrongRoomAck = acknowledge();
  await setup.modSocket.trigger('list_moderation_reports', {
    serverCode: 'XYZ789', status: 'open'
  }, wrongRoomAck.callback);
  assert.deepEqual(wrongRoomAck.value(), { error: 'Permission denied.' });
  assert.equal(JSON.stringify(wrongRoomAck.value()).includes('items'), false);
});

test('exact-room moderator and global admin can read private report and AutoMod state', async () => {
  const setup = reportingScenario();
  const room = setup.ChatServerModel.rows.find(candidate => candidate.code === 'ABC123');
  room.autoMod = {
    blockedKeywords: ['  SPAM  ', 'ＳＰＡＭ'], mentionLimit: 5, repeatLimit: 4, repeatWindowSeconds: 45
  };
  setup.ModerationReportModel.rows.push({
    _id: '507f1f77bcf86cd799439023', serverCode: 'ABC123', reporterUsername: 'Alice',
    targetUsername: 'Bob', messageId: VALID_MESSAGE_ID, reason: 'private report', status: 'open',
    createdAt: new Date('2026-08-08T12:00:00.000Z'), internalSecret: 'never expose'
  });

  const modListAck = acknowledge();
  await setup.modSocket.trigger('list_moderation_reports', {
    serverCode: 'ABC123', status: 'open', limit: 10
  }, modListAck.callback);
  assert.equal(modListAck.value().items.length, 1);
  assert.equal(modListAck.value().items[0].reason, 'private report');
  assert.equal(Object.prototype.hasOwnProperty.call(modListAck.value().items[0], 'internalSecret'), false);

  const autoModAck = acknowledge();
  await setup.modSocket.trigger('get_automod', { serverCode: 'ABC123' }, autoModAck.callback);
  assert.deepEqual(autoModAck.value(), {
    autoMod: {
      blockedKeywords: ['spam'], mentionLimit: 5, repeatLimit: 4, repeatWindowSeconds: 45,
      messageLimit: 5, messageWindowSeconds: 5
    }
  });

  setup.UserModel.rows.push(userDocument({
    username: 'GlobalAdmin', displayName: 'GlobalAdmin', role: 'admin', servers: ['global']
  }));
  const adminSocket = connectAdditionalSocket(setup, {
    id: 'global-admin', username: 'GlobalAdmin', serverCode: 'global', role: 'admin', joinedServers: ['global']
  });
  const adminAck = acknowledge();
  await adminSocket.trigger('list_moderation_reports', {
    serverCode: 'ABC123', status: 'open', limit: 10
  }, adminAck.callback);
  assert.equal(adminAck.value().items.length, 1);
  assert.equal(adminAck.value().items[0].targetUsername, 'Bob');
});

test('legacy AutoMod rooms return message-rate defaults and socket writes require both fields', async () => {
  const setup = reportingScenario();
  const room = setup.ChatServerModel.rows.find(candidate => candidate.code === 'ABC123');
  room.autoMod = { blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30 };

  const legacyAck = acknowledge();
  await setup.modSocket.trigger('get_automod', { serverCode: 'ABC123' }, legacyAck.callback);
  assert.deepEqual(legacyAck.value(), {
    autoMod: {
      blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30,
      messageLimit: 5, messageWindowSeconds: 5
    }
  });

  const original = structuredClone(room.autoMod);
  for (const omission of ['messageLimit', 'messageWindowSeconds']) {
    const request = {
      serverCode: 'ABC123', blockedKeywords: [], mentionLimit: 8, repeatLimit: 3,
      repeatWindowSeconds: 30, messageLimit: 5, messageWindowSeconds: 5
    };
    delete request[omission];
    const ack = acknowledge();
    await setup.modSocket.trigger('update_automod', request, ack.callback);
    assert.deepEqual(ack.value(), { error: 'Invalid input format.' });
    assert.deepEqual(room.autoMod, original);
    assert.equal(setup.ModerationAuditModel.rows.length, 0);
  }
});

test('exact-room moderator and global admin can update room AutoMod settings without auditing keywords', async () => {
  const setup = reportingScenario();
  const moderatorSettings = {
    blockedKeywords: ['  ＳＰＡＭ  ', 'spam', 'Spoilers'],
    mentionLimit: 4,
    repeatLimit: 5,
    repeatWindowSeconds: 60,
    messageLimit: 6,
    messageWindowSeconds: 20
  };
  const moderatorAck = acknowledge();
  await setup.modSocket.trigger('update_automod', {
    serverCode: 'ABC123',
    ...moderatorSettings
  }, moderatorAck.callback);

  const normalizedModeratorSettings = {
    blockedKeywords: ['spam', 'spoilers'],
    mentionLimit: 4,
    repeatLimit: 5,
    repeatWindowSeconds: 60,
    messageLimit: 6,
    messageWindowSeconds: 20
  };
  assert.deepEqual(moderatorAck.value(), { success: true, autoMod: normalizedModeratorSettings });
  assert.deepEqual(
    setup.ChatServerModel.rows.find(room => room.code === 'ABC123').autoMod,
    normalizedModeratorSettings
  );
  assert.equal(setup.ModerationAuditModel.rows.length, 1);
  assert.equal(setup.ModerationAuditModel.rows[0].action, 'update_automod');
  assert.deepEqual(setup.ModerationAuditModel.rows[0].metadata, {
    keywordCount: 2,
    mentionLimit: 4,
    repeatLimit: 5,
    repeatWindowSeconds: 60,
    messageLimit: 6,
    messageWindowSeconds: 20
  });
  assert.equal(JSON.stringify(setup.ModerationAuditModel.rows).includes('spam'), false);
  assert.equal(JSON.stringify(setup.ModerationAuditModel.rows).includes('spoilers'), false);

  setup.UserModel.rows.push(userDocument({
    username: 'GlobalAdmin', displayName: 'GlobalAdmin', role: 'admin', servers: ['global']
  }));
  const adminSocket = connectAdditionalSocket(setup, {
    id: 'automod-admin', username: 'GlobalAdmin', serverCode: 'global', role: 'admin', joinedServers: ['global']
  });
  const adminAck = acknowledge();
  await adminSocket.trigger('update_automod', {
    serverCode: 'ABC123',
    blockedKeywords: ['AdminRule'],
    mentionLimit: 3,
    repeatLimit: 4,
    repeatWindowSeconds: 45,
    messageLimit: 7,
    messageWindowSeconds: 15
  }, adminAck.callback);
  assert.deepEqual(adminAck.value(), {
    success: true,
    autoMod: {
      blockedKeywords: ['adminrule'], mentionLimit: 3, repeatLimit: 4, repeatWindowSeconds: 45,
      messageLimit: 7, messageWindowSeconds: 15
    }
  });

  const globalAck = acknowledge();
  await adminSocket.trigger('update_automod', {
    serverCode: 'global',
    blockedKeywords: ['LobbyRule'],
    mentionLimit: 2,
    repeatLimit: 3,
    repeatWindowSeconds: 30,
    messageLimit: 8,
    messageWindowSeconds: 10
  }, globalAck.callback);
  assert.deepEqual(globalAck.value(), {
    success: true,
    autoMod: {
      blockedKeywords: ['lobbyrule'], mentionLimit: 2, repeatLimit: 3, repeatWindowSeconds: 30,
      messageLimit: 8, messageWindowSeconds: 10
    }
  });
  assert.deepEqual(setup.ChatServerModel.rows.find(room => room.code === 'global').autoMod, {
    blockedKeywords: ['lobbyrule'], mentionLimit: 2, repeatLimit: 3, repeatWindowSeconds: 30,
    messageLimit: 8, messageWindowSeconds: 10
  });
});

test('update AutoMod settings denies other-room, stale, banned, and non-admin Global moderators', async () => {
  const setup = reportingScenario();
  const requestedSettings = {
    blockedKeywords: ['private'], mentionLimit: 4, repeatLimit: 4, repeatWindowSeconds: 40,
    messageLimit: 5, messageWindowSeconds: 5
  };
  const originalPrivateSettings = structuredClone(
    setup.ChatServerModel.rows.find(room => room.code === 'ABC123').autoMod
  );
  const originalGlobalSettings = structuredClone(
    setup.ChatServerModel.rows.find(room => room.code === 'global').autoMod
  );

  const otherRoomAck = acknowledge();
  await setup.otherModSocket.trigger('update_automod', {
    serverCode: 'ABC123', ...requestedSettings
  }, otherRoomAck.callback);
  assert.deepEqual(otherRoomAck.value(), { error: 'Permission denied.' });

  const privateRoom = setup.ChatServerModel.rows.find(room => room.code === 'ABC123');
  privateRoom.moderators = [];
  const staleAck = acknowledge();
  await setup.modSocket.trigger('update_automod', {
    serverCode: 'ABC123', ...requestedSettings
  }, staleAck.callback);
  assert.deepEqual(staleAck.value(), { error: 'Permission denied.' });

  privateRoom.moderators = ['ExactMod'];
  setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'ExactMod', {
    bannedAt: new Date('2026-08-08T12:00:00.000Z')
  }));
  const bannedAck = acknowledge();
  await setup.modSocket.trigger('update_automod', {
    serverCode: 'ABC123', ...requestedSettings
  }, bannedAck.callback);
  assert.deepEqual(bannedAck.value(), { error: 'Permission denied.' });

  const globalAck = acknowledge();
  await setup.modSocket.trigger('update_automod', {
    serverCode: 'global', ...requestedSettings
  }, globalAck.callback);
  assert.deepEqual(globalAck.value(), { error: 'Permission denied.' });

  assert.deepEqual(privateRoom.autoMod, originalPrivateSettings);
  assert.deepEqual(setup.ChatServerModel.rows.find(room => room.code === 'global').autoMod, originalGlobalSettings);
  assert.deepEqual(setup.ModerationAuditModel.rows, []);
});

test('report pagination uses descending createdAt and id keysets with an opaque cursor', async () => {
  const setup = reportingScenario();
  const reportRows = [
    ['507f1f77bcf86cd799439031', '2026-08-08T12:03:00.000Z'],
    ['507f1f77bcf86cd799439033', '2026-08-08T12:02:00.000Z'],
    ['507f1f77bcf86cd799439032', '2026-08-08T12:02:00.000Z'],
    ['507f1f77bcf86cd799439034', '2026-08-08T12:01:00.000Z']
  ].map(([_id, createdAt]) => ({
    _id, createdAt: new Date(createdAt), serverCode: 'ABC123', reporterUsername: 'Alice',
    targetUsername: 'Bob', messageId: null, reason: _id, status: 'open'
  }));
  setup.ModerationReportModel.rows.push(...reportRows);

  const firstAck = acknowledge();
  await setup.modSocket.trigger('list_moderation_reports', {
    serverCode: 'ABC123', status: 'open', limit: 2
  }, firstAck.callback);
  assert.deepEqual(firstAck.value().items.map(item => item._id), [
    '507f1f77bcf86cd799439031', '507f1f77bcf86cd799439033'
  ]);
  assert.equal(typeof firstAck.value().nextCursor, 'string');
  assert.equal(firstAck.value().nextCursor.includes('2026-08-08'), false);

  const secondAck = acknowledge();
  await setup.modSocket.trigger('list_moderation_reports', {
    serverCode: 'ABC123', status: 'open', limit: 2, before: firstAck.value().nextCursor
  }, secondAck.callback);
  assert.deepEqual(secondAck.value().items.map(item => item._id), [
    '507f1f77bcf86cd799439032', '507f1f77bcf86cd799439034'
  ]);
  assert.equal(secondAck.value().nextCursor, null);

  const invalidAck = acknowledge();
  await setup.modSocket.trigger('list_moderation_reports', {
    serverCode: 'ABC123', status: 'open', before: 'not-a-valid-cursor'
  }, invalidAck.callback);
  assert.equal(Boolean(invalidAck.value().error), true);
});

test('audit pagination clamps the limit to fifty and projects explicit safe fields', async () => {
  const setup = reportingScenario();
  for (let index = 0; index < 52; index += 1) {
    setup.ModerationAuditModel.rows.push({
      _id: (500 + index).toString(16).padStart(24, '0'),
      correlationId: `audit-${index}`, action: 'timeout', serverCode: 'ABC123',
      actorUsername: 'ExactMod', actorRole: 'user', actorRoomRole: 'mod',
      targetUsername: 'Bob', targetRole: 'user', targetRoomRole: 'user',
      reason: `reason-${index}`, duration: '10m', expiresAt: null,
      messageId: null, reportId: null, metadata: { sequence: index },
      createdAt: new Date(Date.UTC(2026, 7, 8, 12, 0, index)), privateStorageField: 'never expose'
    });
  }
  const ack = acknowledge();
  await setup.modSocket.trigger('get_moderation_audit', {
    serverCode: 'ABC123', limit: 999
  }, ack.callback);
  assert.equal(ack.value().items.length, 50);
  assert.equal(typeof ack.value().nextCursor, 'string');
  assert.equal(ack.value().items[0].correlationId, 'audit-51');
  assert.equal(Object.prototype.hasOwnProperty.call(ack.value().items[0], 'privateStorageField'), false);
});

test('report resolution validates status and resolution then appends immutable audit history', async () => {
  const setup = reportingScenario();
  const reportId = '507f1f77bcf86cd799439041';
  setup.ModerationReportModel.rows.push({
    _id: reportId, serverCode: 'ABC123', reporterUsername: 'Alice', targetUsername: 'Bob',
    messageId: VALID_MESSAGE_ID, reason: 'private report', status: 'open',
    resolvedBy: null, resolution: null, resolvedAt: null,
    createdAt: new Date('2026-08-08T12:00:00.000Z')
  });
  setup.ModerationAuditModel.rows.push({
    _id: '507f1f77bcf86cd799439042', correlationId: 'existing-audit', action: 'ban',
    serverCode: 'ABC123', actorUsername: 'ExactMod', reason: 'existing immutable audit',
    createdAt: new Date('2026-08-08T11:00:00.000Z')
  });
  const originalAudit = structuredClone(setup.ModerationAuditModel.rows[0]);

  for (const payload of [
    { status: 'open', resolution: 'not a terminal status' },
    { status: 'resolved', resolution: ' ' },
    { status: 'dismissed', resolution: 'x'.repeat(301) }
  ]) {
    const ack = acknowledge();
    await setup.modSocket.trigger('resolve_moderation_report', {
      serverCode: 'ABC123', reportId, ...payload
    }, ack.callback);
    assert.equal(Boolean(ack.value().error), true);
    assert.equal(setup.ModerationReportModel.rows[0].status, 'open');
    assert.equal(setup.ModerationAuditModel.rows.length, 1);
  }

  const resolvedAck = acknowledge();
  await setup.modSocket.trigger('resolve_moderation_report', {
    serverCode: 'ABC123', reportId, status: 'resolved', resolution: '  Ｒｅｖｉｅｗｅｄ and handled  '
  }, resolvedAck.callback);
  assert.deepEqual(resolvedAck.value(), { success: true });
  assert.equal(setup.ModerationReportModel.rows[0].status, 'resolved');
  assert.equal(setup.ModerationReportModel.rows[0].resolvedBy, 'ExactMod');
  assert.equal(setup.ModerationReportModel.rows[0].resolution, 'Reviewed and handled');
  assert.equal(setup.ModerationReportModel.rows[0].resolvedAt instanceof Date, true);
  assert.deepEqual(setup.ModerationAuditModel.rows[0], originalAudit);
  assert.equal(setup.ModerationAuditModel.rows.length, 2);
  assert.equal(setup.ModerationAuditModel.rows[1].action, 'resolve_report');
  assert.equal(setup.ModerationAuditModel.rows[1].reportId, reportId);
  assert.equal(setup.ModerationAuditModel.rows[1].reason, 'Reviewed and handled');
  assert.equal(setup.ioInstance.outbound.some(item => item.event === 'moderation_queue_updated'), false);
  assert.equal(setup.memberSocket.outbound.some(item => item.event === 'moderation_queue_updated'), false);
  assert.equal(setup.otherModSocket.outbound.some(item => item.event === 'moderation_queue_updated'), false);
  assert.equal(setup.modSocket.outbound.some(item => item.event === 'moderation_queue_updated'), true);

  const secondAck = acknowledge();
  await setup.modSocket.trigger('resolve_moderation_report', {
    serverCode: 'ABC123', reportId, status: 'dismissed', resolution: 'second resolution'
  }, secondAck.callback);
  assert.equal(Boolean(secondAck.value().error), true);
  assert.equal(setup.ModerationAuditModel.rows.length, 2);
});

test('restriction list returns active room rows and honors normalized target pagination', async () => {
  const setup = reportingScenario();
  setup.RoomRestrictionModel.rows.push(
    restrictionDocument('ABC123', 'bob', {
      _id: '507f1f77bcf86cd799439051', bannedAt: new Date('2026-08-08T12:03:00.000Z'),
      bannedBy: 'ExactMod', banReason: 'private ban reason',
      createdAt: new Date('2026-08-08T12:03:00.000Z'), storageSecret: 'never expose'
    }),
    restrictionDocument('ABC123', 'ordinarymember', {
      _id: '507f1f77bcf86cd799439052', timeoutUntil: new Date(Date.now() + 60_000),
      timeoutBy: 'ExactMod', timeoutReason: 'private timeout reason',
      createdAt: new Date('2026-08-08T12:02:00.000Z')
    }),
    restrictionDocument('ABC123', 'othermod', {
      _id: '507f1f77bcf86cd799439053', timeoutUntil: new Date(Date.now() - 60_000),
      timeoutReason: 'expired', createdAt: new Date('2026-08-08T12:01:00.000Z')
    }),
    restrictionDocument('XYZ789', 'bob', {
      _id: '507f1f77bcf86cd799439054', bannedAt: new Date(), banReason: 'other room',
      createdAt: new Date('2026-08-08T12:04:00.000Z')
    })
  );

  const targetAck = acknowledge();
  await setup.modSocket.trigger('list_room_restrictions', {
    serverCode: 'ABC123', targetUser: 'BoB', limit: 1
  }, targetAck.callback);
  assert.equal(targetAck.value().items.length, 1);
  assert.deepEqual(targetAck.value().items[0], {
    _id: '507f1f77bcf86cd799439051', targetUsername: 'bob', banned: true,
    bannedAt: new Date('2026-08-08T12:03:00.000Z'), bannedBy: 'ExactMod',
    banReason: 'private ban reason', timedOut: false, timeoutUntil: null,
    timeoutBy: null, timeoutReason: null, createdAt: new Date('2026-08-08T12:03:00.000Z')
  });

  const firstAck = acknowledge();
  await setup.modSocket.trigger('list_room_restrictions', {
    serverCode: 'ABC123', limit: 1
  }, firstAck.callback);
  assert.equal(firstAck.value().items[0].targetUsername, 'bob');
  assert.equal(typeof firstAck.value().nextCursor, 'string');
  const secondAck = acknowledge();
  await setup.modSocket.trigger('list_room_restrictions', {
    serverCode: 'ABC123', limit: 1, before: firstAck.value().nextCursor
  }, secondAck.callback);
  assert.equal(secondAck.value().items[0].targetUsername, 'ordinarymember');
  assert.equal(secondAck.value().nextCursor, null);
});

test('stale banned sockets cannot report or read private moderation data', async () => {
  const reporterSetup = reportingScenario();
  reporterSetup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'alice', {
    bannedAt: new Date(), banReason: 'fresh persisted ban'
  }));
  reporterSetup.socket.roomRole = 'mod';
  const reportAck = acknowledge();
  await reporterSetup.socket.trigger('report_moderation_target', {
    serverCode: 'ABC123', targetUser: 'Bob', reason: 'stale socket report'
  }, reportAck.callback);
  assert.deepEqual(reportAck.value(), { error: 'Permission denied.' });
  assert.equal(reporterSetup.ModerationReportModel.rows.length, 0);

  const modSetup = reportingScenario();
  modSetup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'exactmod', {
    bannedAt: new Date(), banReason: 'fresh persisted moderator ban'
  }));
  modSetup.ModerationReportModel.rows.push({
    _id: '507f1f77bcf86cd799439061', serverCode: 'ABC123', reporterUsername: 'Alice',
    targetUsername: 'Bob', reason: 'must remain private', status: 'open', createdAt: new Date()
  });
  modSetup.ModerationAuditModel.rows.push({
    _id: '507f1f77bcf86cd799439062', correlationId: 'private', action: 'ban',
    serverCode: 'ABC123', reason: 'must remain private', createdAt: new Date()
  });
  for (const [event, payload] of [
    ['list_moderation_reports', { serverCode: 'ABC123', status: 'open' }],
    ['resolve_moderation_report', {
      serverCode: 'ABC123', reportId: '507f1f77bcf86cd799439061',
      status: 'resolved', resolution: 'stale moderator cannot resolve'
    }],
    ['list_room_restrictions', { serverCode: 'ABC123' }],
    ['get_moderation_audit', { serverCode: 'ABC123' }],
    ['get_automod', { serverCode: 'ABC123' }]
  ]) {
    const ack = acknowledge();
    await modSetup.modSocket.trigger(event, payload, ack.callback);
    assert.deepEqual(ack.value(), { error: 'Permission denied.' }, event);
    assert.deepEqual(Object.keys(ack.value()), ['error'], event);
  }
  assert.equal(modSetup.ModerationReportModel.rows[0].status, 'open');
  assert.equal(modSetup.ModerationAuditModel.rows.length, 1);
});

test('room deletion removes private report and restriction rows but retains append-only audit rows', async () => {
  const setup = reportingScenario();
  setup.UserModel.rows.find(user => user.username === 'Alice').role = 'admin';
  setup.socket.role = 'admin';
  setup.RoomRestrictionModel.rows.push(
    restrictionDocument('ABC123', 'bob', { bannedAt: new Date() }),
    restrictionDocument('XYZ789', 'bob', { bannedAt: new Date() })
  );
  setup.ModerationReportModel.rows.push(
    { _id: '507f1f77bcf86cd799439071', serverCode: 'ABC123', status: 'open', createdAt: new Date() },
    { _id: '507f1f77bcf86cd799439072', serverCode: 'XYZ789', status: 'open', createdAt: new Date() }
  );
  setup.ModerationAuditModel.rows.push(
    { _id: '507f1f77bcf86cd799439073', serverCode: 'ABC123', action: 'ban', createdAt: new Date() },
    { _id: '507f1f77bcf86cd799439074', serverCode: 'XYZ789', action: 'ban', createdAt: new Date() }
  );
  const ack = acknowledge();
  await setup.socket.trigger('delete_server', 'ABC123', ack.callback);
  assert.deepEqual(ack.value(), { success: true });
  assert.deepEqual(setup.RoomRestrictionModel.rows.map(row => row.serverCode), ['XYZ789']);
  assert.deepEqual(setup.ModerationReportModel.rows.map(row => row.serverCode), ['XYZ789']);
  assert.deepEqual(setup.ModerationAuditModel.rows.map(row => row.serverCode), ['ABC123', 'XYZ789']);
});

test('restriction cleanup failure follows the generic room deletion failure path', async () => {
  const setup = reportingScenario();
  setup.UserModel.rows.find(user => user.username === 'Alice').role = 'admin';
  setup.socket.role = 'admin';
  setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'bob', { bannedAt: new Date() }));
  setup.ModerationReportModel.rows.push({
    _id: '507f1f77bcf86cd799439075', serverCode: 'ABC123', status: 'open', createdAt: new Date()
  });
  setup.RoomRestrictionModel.deleteMany = async () => { throw new Error('secret restriction outage'); };
  const ack = acknowledge();
  await setup.socket.trigger('delete_server', 'ABC123', ack.callback);
  assert.deepEqual(ack.value(), { error: 'Deletion failed.' });
  assert.equal(setup.ChatServerModel.rows.some(room => room.code === 'ABC123'), false);
  assert.equal(setup.ModerationReportModel.rows.some(report => report.serverCode === 'ABC123'), false);
});

test('moderation inputs accept only the supported actions, durations, reasons, and AutoMod bounds', () => {
  assert.equal(normalizeModerationAction(' Ban '), 'ban');
  assert.equal(normalizeModerationAction('kick'), 'kick');
  assert.equal(normalizeModerationAction('suspend'), null);
  assert.equal(normalizeModerationReason('  repeated harassment  '), 'repeated harassment');
  assert.equal(normalizeModerationReason(' '.repeat(3)), null);
  assert.equal(normalizeModerationReason('x'.repeat(201)), null);
  assert.deepEqual(Object.keys(MODERATION_DURATIONS).sort(), ['10m', '1h', '24h', '7d'].sort());
  assert.equal(normalizeAutoModSettings({
    blockedKeywords: ['spam'], mentionLimit: 5, repeatLimit: 3, repeatWindowSeconds: 30
  }), null);
  assert.deepEqual(normalizeStoredAutoModSettings({
    blockedKeywords: ['spam'], mentionLimit: 5, repeatLimit: 3, repeatWindowSeconds: 30
  }), {
    blockedKeywords: ['spam'], mentionLimit: 5, repeatLimit: 3, repeatWindowSeconds: 30,
    messageLimit: 5, messageWindowSeconds: 5
  });
  assert.deepEqual(normalizeStoredAutoModSettings({
    blockedKeywords: ['spam'], mentionLimit: 5, repeatLimit: 3, repeatWindowSeconds: 30,
    messageLimit: undefined, messageWindowSeconds: undefined
  }), {
    blockedKeywords: ['spam'], mentionLimit: 5, repeatLimit: 3, repeatWindowSeconds: 30,
    messageLimit: 5, messageWindowSeconds: 5
  });
  for (const invalid of [
    { messageLimit: null, messageWindowSeconds: 5 },
    { messageLimit: '5', messageWindowSeconds: 5 },
    { messageLimit: 1.5, messageWindowSeconds: 5 },
    { messageLimit: 5, messageWindowSeconds: null },
    { messageLimit: 5, messageWindowSeconds: '5' },
    { messageLimit: 5, messageWindowSeconds: 1.5 }
  ]) {
    assert.equal(normalizeAutoModSettings({
      blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30,
      ...invalid
    }), null);
    assert.equal(normalizeStoredAutoModSettings({
      blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30,
      ...invalid
    }), null);
  }
  assert.deepEqual(normalizeAutoModSettings({
    blockedKeywords: ['  SPAM  ', 'spam', 'ＢＡＤ'],
    mentionLimit: 5,
    repeatLimit: 3,
    repeatWindowSeconds: 30,
    messageLimit: 5,
    messageWindowSeconds: 5
  }), {
    blockedKeywords: ['spam', 'bad'], mentionLimit: 5, repeatLimit: 3, repeatWindowSeconds: 30,
    messageLimit: 5, messageWindowSeconds: 5
  });
  for (const invalid of [
    { messageLimit: 0, messageWindowSeconds: 5 },
    { messageLimit: 21, messageWindowSeconds: 5 },
    { messageLimit: 5, messageWindowSeconds: 0 },
    { messageLimit: 5, messageWindowSeconds: 61 },
    { messageLimit: 1.5, messageWindowSeconds: 5 }
  ]) {
    assert.equal(normalizeAutoModSettings({
      blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30,
      ...invalid
    }), null);
  }
});

test('moderation authority is exact-room and respects the global/private action matrix', () => {
  const admin = { username: 'Admin', role: 'admin' };
  const mod = { username: 'Mod', role: 'user' };
  const member = { username: 'Member', role: 'user' };
  const otherMod = { username: 'OtherMod', role: 'user' };
  const room = { code: 'ABC123', moderators: ['Mod', 'OtherMod'] };
  const otherRoom = { code: 'XYZ789', owner: 'Owner', moderators: [] };

  assert.equal(canModerateTarget({ serverCode: 'global', action: 'kick', actorUser: admin, targetUser: member, room: { code: 'global', moderators: [] } }), false);
  assert.equal(canModerateTarget({ serverCode: 'global', action: 'ban', actorUser: admin, targetUser: member, room: { code: 'global', moderators: [] } }), true);
  assert.equal(canModerateTarget({ serverCode: 'global', action: 'timeout', actorUser: mod, targetUser: member, room: { code: 'global', moderators: [] } }), false);
  assert.equal(canModerateTarget({ serverCode: room.code, action: 'kick', actorUser: mod, targetUser: member, room }), true);
  assert.equal(canModerateTarget({ serverCode: otherRoom.code, action: 'kick', actorUser: mod, targetUser: member, room: otherRoom }), false);
  assert.equal(canModerateTarget({ serverCode: otherRoom.code, action: 'kick', actorUser: { username: otherRoom.owner, role: 'user' }, targetUser: member, room: otherRoom }), false);
  assert.equal(canModerateTarget({ serverCode: room.code, action: 'ban', actorUser: mod, targetUser: otherMod, room }), false);
  assert.equal(canModerateTarget({ serverCode: room.code, action: 'ban', actorUser: mod, targetUser: admin, room }), false);
  assert.equal(canModerateTarget({ serverCode: room.code, action: 'ban', actorUser: admin, targetUser: { username: 'SecondAdmin', role: 'admin' }, room }), false);
  assert.equal(canModerateTarget({ serverCode: room.code, action: 'ban', actorUser: admin, targetUser: { username: 'NYZhang1', role: 'user' }, room }), false);
});

test('moderation authority rejects missing and unsupported actions', () => {
  const context = {
    serverCode: 'ABC123',
    actorUser: { username: 'Admin', role: 'admin' },
    targetUser: { username: 'Member', role: 'user' },
    room: { code: 'ABC123', moderators: [] }
  };

  for (const action of [null, undefined, '', 'suspend', 'erase']) {
    assert.equal(canModerateTarget({ ...context, action }), false);
  }
});

test('moderation fixture documents can be marked and saved directly', async () => {
  const fixtures = [
    userDocument(),
    roomDocument('ABC123'),
    restrictionDocument('ABC123', 'Alice')
  ];

  for (const fixture of fixtures) {
    fixture.label = 'changed';
    assert.doesNotThrow(() => fixture.markModified('label'));
    assert.equal(await fixture.save(), fixture);
    assert.equal(fixture.label, 'changed');
  }
});

test('memory model save persists data without storing helper methods', async () => {
  const UserModel = createMemoryModel([{ username: 'Alice', displayName: 'Alice' }]);
  const user = await UserModel.findOne({ username: 'Alice' });
  user.displayName = 'Updated';
  user.markModified('displayName');
  await user.save();

  assert.deepEqual(UserModel.rows, [{ username: 'Alice', displayName: 'Updated' }]);
});

test('AutoMod normalizes Unicode keywords and never returns blocked content', () => {
  const tracker = createAutoModTracker({ maxKeys: 100, now: () => 1_000 });
  assert.deepEqual(evaluateAutoMod({
    text: 'That is ＢＡＤ',
    resolvedText: 'That is ＢＡＤ',
    username: 'Alice',
    serverCode: 'ABC123',
    role: 'user',
    settings: {
      blockedKeywords: ['bad'], mentionLimit: 5, repeatLimit: 3, repeatWindowSeconds: 30
    },
    tracker,
    now: new Date(1_000)
  }), { allowed: false, rule: 'blocked_keyword' });
});

test('AutoMod mention limit applies to admins while keyword and repeat rules exempt admins', () => {
  const tracker = createAutoModTracker({ maxKeys: 100, now: () => 1_000 });
  const settings = {
    blockedKeywords: ['bad'], mentionLimit: 1, repeatLimit: 2, repeatWindowSeconds: 30
  };
  assert.equal(evaluateAutoMod({
    text: 'bad', resolvedText: 'bad', username: 'Admin', serverCode: 'global', role: 'admin',
    settings, tracker, now: new Date(1_000)
  }).allowed, true);
  assert.equal(evaluateAutoMod({
    text: 'bad', resolvedText: 'bad', username: 'Admin', serverCode: 'global', role: 'admin',
    settings, tracker, now: new Date(1_000)
  }).allowed, true);
  assert.deepEqual(evaluateAutoMod({
    text: '@a @b',
    resolvedText: '{{PING:a|A}} {{PING:b|B}}',
    username: 'Admin',
    serverCode: 'global',
    role: 'admin',
    settings,
    tracker,
    now: new Date(1_000)
  }), { allowed: false, rule: 'mention_limit' });
});

test('AutoMod keeps raw keyword checks separate from resolved display names and mention syntax', () => {
  const settings = {
    blockedKeywords: ['bad'], mentionLimit: 5, repeatLimit: 3, repeatWindowSeconds: 30
  };
  const displayNameTracker = createAutoModTracker({ maxKeys: 100, now: () => 1_000 });
  assert.deepEqual(evaluateAutoMod({
    text: '@alice',
    resolvedText: '{{PING:alice|Bad Actor}}',
    username: 'Bob',
    serverCode: 'ABC123',
    role: 'user',
    settings,
    tracker: displayNameTracker,
    now: new Date(1_000)
  }), { allowed: true });

  const adjacentKeywordTracker = createAutoModTracker({ maxKeys: 100, now: () => 1_000 });
  assert.deepEqual(evaluateAutoMod({
    text: 'ＢＡＤ@alice',
    resolvedText: '{{PING:alice|Alice}}',
    username: 'Bob',
    serverCode: 'ABC123',
    role: 'user',
    settings,
    tracker: adjacentKeywordTracker,
    now: new Date(1_000)
  }), { allowed: false, rule: 'blocked_keyword' });
});

test('AutoMod repeat tracker expires entries and remains bounded to ten thousand account-room keys', () => {
  let currentTime = 1_000;
  const tracker = createAutoModTracker({ maxKeys: 10_000, now: () => currentTime });
  assert.equal(tracker.recordAndCheck('ABC123\0alice', 'same', 2, 5_000), false);
  currentTime = 2_000;
  assert.equal(tracker.recordAndCheck('ABC123\0alice', 'same', 2, 5_000), true);
  currentTime = 7_001;
  assert.equal(tracker.recordAndCheck('ABC123\0alice', 'same', 2, 5_000), false);

  for (let index = 0; index <= 10_000; index += 1) {
    tracker.recordAndCheck(`ROOM${index}\0user${index}`, `message-${index}`, 3, 5_000);
  }
  assert.equal(tracker.size(), 10_000);

  currentTime = 20_000;
  tracker.prune(5_000);
  assert.equal(tracker.size(), 0);
});

test('message-rate tracker uses accepted attempts, exact rolling boundaries, and bounded shared keys', () => {
  let currentTime = 0;
  const tracker = createAutoModTracker({ maxKeys: 10_000, now: () => currentTime });
  assert.deepEqual(tracker.recordMessageAttempt('ABC123\0admin', 2, 1_000), { allowed: true, shouldAudit: false });
  currentTime = 100;
  assert.deepEqual(tracker.recordMessageAttempt('ABC123\0admin', 2, 1_000), { allowed: true, shouldAudit: false });
  currentTime = 200;
  assert.deepEqual(tracker.recordMessageAttempt('ABC123\0admin', 2, 1_000), { allowed: false, shouldAudit: true });
  currentTime = 300;
  assert.deepEqual(tracker.recordMessageAttempt('ABC123\0admin', 2, 1_000), { allowed: false, shouldAudit: false });
  currentTime = 1_000;
  assert.deepEqual(tracker.recordMessageAttempt('ABC123\0admin', 2, 1_000), { allowed: true, shouldAudit: false });
  assert.equal(tracker.messageAttemptCount('ABC123\0admin'), 2);

  assert.deepEqual(tracker.recordMessageAttempt('ABC123\0alice', 1, 1_000), { allowed: true, shouldAudit: false });
  assert.deepEqual(tracker.recordMessageAttempt('XYZ789\0admin', 1, 1_000), { allowed: true, shouldAudit: false });
  assert.equal(tracker.messageAttemptCount('ABC123\0alice'), 1);
  assert.equal(tracker.messageAttemptCount('XYZ789\0admin'), 1);
  for (let index = 0; index <= 10_000; index += 1) {
    tracker.recordMessageAttempt(`ROOM${index}\0user${index}`, 20, 1_000);
  }
  assert.equal(tracker.size(), 10_000);
  assert.equal(tracker.hasKey('ABC123\0admin'), false);
  assert.equal(tracker.hasKey('ROOM10000\0user10000'), true);
  assert.ok(tracker.messageAttemptCount('ROOM10000\0user10000') <= 20);
});

test('message-rate tracker trims immediately when a room lowers its configured limit', () => {
  let currentTime = 0;
  const tracker = createAutoModTracker({ now: () => currentTime });
  for (let index = 0; index < 20; index += 1) {
    currentTime = index;
    assert.equal(tracker.recordMessageAttempt('ABC123\0alice', 20, 1_000).allowed, true);
  }
  currentTime = 20;
  assert.deepEqual(tracker.recordMessageAttempt('ABC123\0alice', 1, 1_000), { allowed: false, shouldAudit: true });
  assert.ok(tracker.messageAttemptCount('ABC123\0alice') <= 1);
  currentTime = 1_000;
  assert.deepEqual(tracker.recordMessageAttempt('ABC123\0alice', 1, 1_000), { allowed: false, shouldAudit: false });
  currentTime = 1_019;
  assert.deepEqual(tracker.recordMessageAttempt('ABC123\0alice', 1, 1_000), { allowed: true, shouldAudit: false });
});

test('message-rate tracker shares one bounded map with repeat tracker state', () => {
  let currentTime = 0;
  const tracker = createAutoModTracker({ maxKeys: 10_000, now: () => currentTime });
  for (let index = 0; index < 5_000; index += 1) {
    tracker.recordAndCheck(`REPEAT${index}\0user${index}`, 'same', 3, 1_000);
  }
  for (let index = 0; index < 5_001; index += 1) {
    tracker.recordMessageAttempt(`RATE${index}\0user${index}`, 1, 1_000);
  }
  assert.equal(tracker.size(), 10_000);
  assert.equal(tracker.hasKey('REPEAT0\0user0'), false);
  assert.equal(tracker.hasKey('RATE5000\0user5000'), true);
});

test('AutoMod tracker global pruning uses each key stored repeat and rate windows', () => {
  let currentTime = 0;
  const tracker = createAutoModTracker({ now: () => currentTime });
  tracker.recordAndCheck('SHORT_REPEAT\0alice', 'same', 3, 100);
  tracker.recordAndCheck('LONG_REPEAT\0bob', 'same', 3, 1_000);
  tracker.recordMessageAttempt('SHORT_RATE\0carol', 1, 100);
  tracker.recordMessageAttempt('LONG_RATE\0dave', 1, 1_000);

  currentTime = 200;
  tracker.prune(100);

  assert.equal(tracker.hasKey('SHORT_REPEAT\0alice'), false);
  assert.equal(tracker.hasKey('SHORT_RATE\0carol'), false);
  assert.equal(tracker.hasKey('LONG_REPEAT\0bob'), true);
  assert.equal(tracker.hasKey('LONG_RATE\0dave'), true);
});

test('AutoMod message-rate policy is role agnostic and canonical-account scoped', () => {
  let currentTime = 0;
  const tracker = createAutoModTracker({ now: () => currentTime });
  const settings = {
    blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30,
    messageLimit: 1, messageWindowSeconds: 1
  };
  assert.deepEqual(evaluateMessageRate({ username: 'Alice', serverCode: 'ABC123', settings, tracker }), { allowed: true });
  assert.deepEqual(evaluateMessageRate({ username: 'aLiCe', serverCode: 'ABC123', settings, tracker }), {
    allowed: false, rule: 'message_rate', shouldAudit: true
  });
  assert.deepEqual(evaluateMessageRate({ username: 'Alice', serverCode: 'XYZ789', settings, tracker }), { allowed: true });
  currentTime = 1_000;
  assert.deepEqual(evaluateMessageRate({ username: 'Alice', serverCode: 'ABC123', settings, tracker }), { allowed: true });
});

test('AutoMod message-rate handler shares canonical account state but isolates accounts, rooms, and current roles', async () => {
  let currentTime = 0;
  const tracker = createAutoModTracker({ now: () => currentTime });
  const settings = {
    blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30,
    messageLimit: 2, messageWindowSeconds: 5
  };
  const setup = registerWithModels({
    autoModTracker: tracker,
    users: [
      userDocument({ username: 'Alice', servers: ['global', 'ABC123', 'XYZ789'] }),
      userDocument({ username: 'Bob', servers: ['global', 'ABC123'] }),
      userDocument({ username: 'GlobalAdmin', role: 'admin', servers: ['global'] }),
      userDocument({ username: 'RoomMod', servers: ['global', 'ABC123'] })
    ],
    rooms: [
      roomDocument('global'),
      roomDocument('ABC123', { moderators: ['RoomMod'], autoMod: settings }),
      roomDocument('XYZ789', { autoMod: settings })
    ]
  });
  Object.assign(setup.socket, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789'], bannedRooms: []
  });
  const sameAccount = connectAdditionalSocket(setup, {
    id: 'alice-case-variant', username: 'aLiCe', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const otherAccount = connectAdditionalSocket(setup, {
    id: 'bob-rate', username: 'Bob', serverCode: 'ABC123', joinedServers: ['global', 'ABC123']
  });
  const otherRoom = connectAdditionalSocket(setup, {
    id: 'alice-other-rate-room', username: 'Alice', serverCode: 'XYZ789',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const admin = connectAdditionalSocket(setup, {
    id: 'global-admin-rate', username: 'GlobalAdmin', serverCode: 'ABC123', role: 'admin', joinedServers: ['global']
  });
  const roomMod = connectAdditionalSocket(setup, {
    id: 'room-mod-rate', username: 'RoomMod', serverCode: 'ABC123', role: 'user', joinedServers: ['global', 'ABC123']
  });

  await setup.socket.trigger('chat_message', { text: 'alice one' });
  await setup.socket.trigger('chat_message', { text: 'alice two' });
  await sameAccount.trigger('chat_message', { text: 'alice third' });
  await otherAccount.trigger('chat_message', { text: 'bob independent' });
  await otherRoom.trigger('chat_message', { text: 'alice other room' });
  for (const live of [admin, roomMod]) {
    await live.trigger('chat_message', { text: `${live.username} one` });
    await live.trigger('chat_message', { text: `${live.username} two` });
    await live.trigger('chat_message', { text: `${live.username} third` });
    assert.equal(live.outbound.filter(item => item.event === 'message_blocked').length, 1);
  }

  assert.equal(sameAccount.outbound.filter(item => item.event === 'message_blocked').length, 1);
  assert.equal(setup.MessageModel.rows.length, 8);
  assert.equal(tracker.messageAttemptCount('ABC123\0alice'), 2);
  assert.equal(tracker.messageAttemptCount('ABC123\0bob'), 1);
  assert.equal(tracker.messageAttemptCount('XYZ789\0alice'), 1);
});

test('AutoMod message-rate state survives a same-account reconnect in the running backend', async () => {
  const tracker = createAutoModTracker({ now: () => 0 });
  const settings = {
    blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30,
    messageLimit: 1, messageWindowSeconds: 5
  };
  const setup = registerWithModels({
    autoModTracker: tracker,
    users: [userDocument({ username: 'Alice', servers: ['global', 'ABC123'] })],
    rooms: [roomDocument('global'), roomDocument('ABC123', { autoMod: settings })]
  });
  Object.assign(setup.socket, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123'], bannedRooms: []
  });
  await setup.socket.trigger('chat_message', { text: 'before reconnect' });
  await setup.socket.trigger('disconnect');
  const reconnect = connectAdditionalSocket(setup, {
    id: 'alice-reconnected', username: 'aLiCe', serverCode: 'ABC123', joinedServers: ['global', 'ABC123']
  });
  await reconnect.trigger('chat_message', { text: 'after reconnect' });
  assert.equal(setup.MessageModel.rows.length, 1);
  assert.equal(reconnect.outbound.filter(item => item.event === 'message_blocked').length, 1);
});

test('identical normalized messages share repeat state across same-account sockets but not rooms or accounts', async () => {
  const repeatText = '  Same\tＲＥＰＥＡＴ  ';
  const setup = registerWithModels({
    users: [
      userDocument({ username: 'Alice', servers: ['global', 'ABC123', 'XYZ789'] }),
      userDocument({ username: 'Bob', servers: ['global', 'ABC123'] })
    ],
    rooms: [
      roomDocument('global'),
      roomDocument('ABC123', {
        autoMod: { blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30 }
      }),
      roomDocument('XYZ789', {
        autoMod: { blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30 }
      })
    ]
  });
  Object.assign(setup.socket, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789'], bannedRooms: []
  });
  const secondAlice = connectAdditionalSocket(setup, {
    id: 'alice-second', username: 'aLiCe', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const otherRoomAlice = connectAdditionalSocket(setup, {
    id: 'alice-other-room', username: 'Alice', serverCode: 'XYZ789',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const bob = connectAdditionalSocket(setup, {
    id: 'bob-repeat', username: 'Bob', serverCode: 'ABC123', joinedServers: ['global', 'ABC123']
  });

  await setup.socket.trigger('chat_message', { text: repeatText });
  await bob.trigger('chat_message', { text: 'same repeat' });
  await otherRoomAlice.trigger('chat_message', { text: 'same repeat' });
  await secondAlice.trigger('chat_message', { text: 'same  repeat' });

  assert.equal(setup.MessageModel.rows.length, 4);
  assert.deepEqual(setup.MessageModel.rows.map(item => item.text), [
    repeatText.trim(), 'same repeat', 'same repeat', 'same  repeat'
  ]);
  assert.equal(setup.ioInstance.outbound.some(item => item.event === 'chat_message'), false);

  await new Promise(resolve => setTimeout(resolve, 510));
  await setup.socket.trigger('chat_message', { text: 'same repeat' });

  assert.equal(setup.MessageModel.rows.length, 4);
  assert.equal(setup.ioInstance.outbound.some(item => item.event === 'chat_message'), false);
  assert.deepEqual(setup.socket.outbound.filter(item => item.event === 'message_blocked'), [{
    target: 'self', event: 'message_blocked',
    payload: { rule: 'content_policy', serverCode: 'ABC123', clientContextId: 1 }
  }]);
});

test('Blocked send never persists, broadcasts, logs, or audits raw text', async () => {
  const blockedText = 'Never Leak ＳＥＣＲＥＴ Payload';
  const logged = [];
  const setup = registerWithModels({
    user: userDocument({ username: 'Alice', servers: ['global', 'ABC123'] }),
    rooms: [roomDocument('global'), roomDocument('ABC123', {
      autoMod: {
        blockedKeywords: ['secret'], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30
      }
    })],
    logger: { error(...args) { logged.push(args); } }
  });
  Object.assign(setup.socket, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123'], bannedRooms: []
  });

  await setup.socket.trigger('chat_message', { text: blockedText });

  assert.deepEqual(setup.MessageModel.rows, []);
  assert.deepEqual(setup.ioInstance.outbound, []);
  assert.deepEqual(setup.socket.outbound, [{
    target: 'self', event: 'message_blocked',
    payload: { rule: 'content_policy', serverCode: 'ABC123', clientContextId: 1 }
  }]);
  assert.deepEqual(logged, []);
  assert.equal(setup.ModerationAuditModel.rows.length, 1);
  assert.equal(setup.ModerationAuditModel.rows[0].action, 'automod_block');
  assert.equal(setup.ModerationAuditModel.rows[0].metadata.rule, 'blocked_keyword');
  assert.match(setup.ModerationAuditModel.rows[0].metadata.contentDigest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(setup.ModerationAuditModel.rows).includes(blockedText), false);
  assert.equal(JSON.stringify(setup.ModerationAuditModel.rows).includes('Never Leak'), false);
});

test('multiple account locks normalize, de-duplicate, sort, serialize overlap, and release after rejection', async () => {
  const gate = deferred();
  const order = [];
  const first = withAccountTransitionLocks(['Target', 'actor', 'target'], async () => {
    order.push('first:start');
    await gate.promise;
    order.push('first:end');
  });
  const second = withAccountTransitionLocks(['ACTOR'], async () => order.push('second'));
  await Promise.resolve();
  assert.deepEqual(order, ['first:start']);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second']);
  await assert.rejects(withAccountTransitionLocks(['actor', 'target'], async () => { throw new Error('expected'); }));
  await assert.doesNotReject(withAccountTransitionLocks(['TARGET'], async () => {}));
});

test('restriction state expires timeouts without treating an expired timeout as active', () => {
  const now = new Date('2026-08-08T12:00:00.000Z');
  assert.deepEqual(activeRestrictionState({ bannedAt: now, timeoutUntil: new Date('2026-08-08T11:59:00.000Z') }, now), { banned: true, timedOut: false, timeoutUntil: null });
  assert.deepEqual(activeRestrictionState({ timeoutUntil: new Date('2026-08-08T12:10:00.000Z') }, now), { banned: false, timedOut: true, timeoutUntil: new Date('2026-08-08T12:10:00.000Z') });
});

test('canonical user lookup is case-insensitive while restriction keys stay normalized', async () => {
  const UserModel = createMemoryModel([userDocument({ username: 'Alice' })]);
  const user = await findUserByUsername(UserModel, 'aLiCe');
  assert.equal(user.username, 'Alice');
  assert.equal(normalizeAccountKey(user.username), 'alice');
});

test('audit mutation hook rejects updates and deletes', () => {
  assert.throws(() => rejectAuditMutation(), /append-only/);
});

test('audit schema registers every supported prohibited mutation operation', () => {
  const source = require('node:fs').readFileSync(require.resolve('../server'), 'utf8');
  for (const operation of [
    'updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne',
    'deleteOne', 'deleteMany', 'findOneAndDelete', 'bulkWrite'
  ]) {
    assert.match(source, new RegExp(`pre\\(['\"]${operation}['\"]`));
  }
});

test('global-banned login chooses the first accessible joined private room', async () => {
  const { socket } = registerWithModels({
    user: userDocument({ username: 'Alice', servers: ['global', 'ABC123', 'XYZ789'] }),
    rooms: [roomDocument('global'), roomDocument('ABC123'), roomDocument('XYZ789')],
    restrictions: [restrictionDocument('global', 'alice', { bannedAt: new Date() })]
  });
  const ack = acknowledge();
  await socket.trigger('login', { username: 'Alice', password: '123456' }, ack.callback);
  assert.equal(ack.value().defaultServerCode, 'ABC123');
  assert.equal(socket.serverCode, 'ABC123');
  assert.equal(socket.joinedRooms.has('global'), false);
  assert.equal(socket.joinedRooms.has('ABC123'), true);
});

test('global-banned login with no accessible private room enters authenticated lobby', async () => {
  const setup = registerWithModels({
    user: userDocument({ username: 'Alice', servers: ['global'] }),
    rooms: [roomDocument('global')],
    restrictions: [restrictionDocument('global', 'alice', { bannedAt: new Date() })]
  });
  const ack = acknowledge();
  await setup.socket.trigger('login', { username: 'Alice', password: '123456' }, ack.callback);
  assert.equal(ack.value().defaultServerCode, null);
  assert.equal(setup.socket.serverCode, null);
  assert.equal(setup.onlineUsersMap.get(setup.socket.id).serverCode, null);
  assert.deepEqual([...setup.socket.joinedRooms], []);
});

test('global-banned login never publishes Global presence or a Global join notice', async () => {
  const broadcasts = [];
  const setup = registerWithModels({
    user: userDocument({ username: 'Alice', servers: ['global'] }),
    rooms: [roomDocument('global')],
    restrictions: [restrictionDocument('global', 'alice', { bannedAt: new Date() })],
    broadcastOnlineUsersFn: code => broadcasts.push(code)
  });
  const ack = acknowledge();
  await setup.socket.trigger('login', { username: 'alice', password: '123456' }, ack.callback);
  assert.deepEqual(broadcasts, []);
  assert.equal(setup.socket.outbound.some(item => item.target === 'global' && item.event === 'system_message'), false);
  assert.deepEqual(ack.value().bannedRooms, ['global']);
});

test('room ban blocks join and switch even when socket membership is stale', async () => {
  const setup = authenticatedRoomSocket({ joinedServers: ['global', 'ABC123'] });
  setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'alice', { bannedAt: new Date() }));
  const joinAck = acknowledge();
  const switchAck = acknowledge();
  await setup.socket.trigger('join_server', 'ABC123', joinAck.callback);
  await setup.socket.trigger('switch_server', 'ABC123', switchAck.callback);
  assert.deepEqual(joinAck.value(), { error: 'Permission denied.' });
  assert.deepEqual(switchAck.value(), { error: 'Permission denied.' });
});

test('mixed-case ban lookup denies the canonical user', async () => {
  const setup = authenticatedRoomSocket({ joinedServers: ['global', 'ABC123'], username: 'Alice' });
  setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'alice', { bannedAt: new Date() }));
  const ack = acknowledge();
  await setup.socket.trigger('switch_server', 'ABC123', ack.callback);
  assert.deepEqual(ack.value(), { error: 'Permission denied.' });
});

test('global-banned lobby user can join an unbanned private room without joining Global', async () => {
  const setup = authenticatedLobbySocket({ username: 'Alice', bannedRooms: ['global'] });
  const ack = acknowledge();
  await setup.socket.trigger('join_server', 'ABC123', ack.callback);
  assert.equal(ack.value().success, true);
  assert.equal(setup.socket.joinedRooms.has('global'), false);
  assert.deepEqual(setup.onlineUsersMap.get(setup.socket.id).bannedRooms, ['global']);
});

test('timeout blocks send edit reaction and typing but allows own delete', async () => {
  const setup = timedOutAuthenticatedSocket('ABC123', 'Alice');
  const metadataAck = acknowledge();
  await setup.socket.trigger('update_room_details', {
    serverCode: 'ABC123', description: 'timeout metadata', rules: ''
  }, metadataAck.callback);
  await setup.socket.trigger('chat_message', { text: 'blocked message' });
  await setup.socket.trigger('edit_message', { id: VALID_MESSAGE_ID, text: 'blocked edit' });
  await setup.socket.trigger('toggle_reaction', { id: VALID_MESSAGE_ID, emoji: '👍' });
  await setup.socket.trigger('typing', true);
  await setup.socket.trigger('delete_message', VALID_MESSAGE_ID);
  assert.equal(setup.MessageModel.created.length, 0);
  assert.equal(setup.message.text, 'original');
  assert.deepEqual(setup.message.reactions, {});
  assert.equal(setup.socket.outbound.some(item => item.event === 'typing'), false);
  assert.equal(setup.message.deleted, true);
  assert.deepEqual(metadataAck.value(), { error: 'Permission denied.' });
});

test('timed-out room moderator cannot delete another user message', async () => {
  const message = saveableDocument({
    _id: VALID_MESSAGE_ID,
    serverCode: 'ABC123',
    username: 'Bob',
    displayName: 'Bob',
    role: 'user',
    roomRole: 'user',
    text: 'belongs to Bob',
    history: [],
    reactions: {},
    deleted: false
  });
  const setup = registerWithModels({
    user: userDocument({ username: 'Alice', servers: ['global', 'ABC123'] }),
    rooms: [roomDocument('global'), roomDocument('ABC123', { moderators: ['Alice'] })],
    restrictions: [restrictionDocument('ABC123', 'alice', {
      timeoutUntil: new Date(Date.now() + 60_000)
    })],
    getRoomRoleFn: async () => 'mod'
  });
  Object.assign(setup.socket, {
    username: 'Alice',
    displayName: 'Alice',
    role: 'user',
    serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123']
  });
  setup.socket.joinedRooms.add('ABC123');
  setup.MessageModel.findById = async () => message;

  await setup.socket.trigger('delete_message', VALID_MESSAGE_ID);

  assert.equal(message.deleted, false);
  assert.equal(setup.ioInstance.outbound.some(item => item.event === 'message_deleted'), false);
});

test('join_server rejects a ban committed before its account and room critical section', async () => {
  const setup = authenticatedRoomSocket({ joinedServers: ['global'] });
  setup.ChatServerModel.rows.push(roomDocument('ABC123'));
  const releaseAccount = deferred();
  const accountHeld = deferred();
  const holder = withAccountTransitionLock('alice', async () => {
    accountHeld.resolve();
    await releaseAccount.promise;
  });
  await accountHeld.promise;

  const ack = acknowledge();
  const pending = setup.socket.trigger('join_server', 'ABC123', ack.callback);
  setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'alice', { bannedAt: new Date() }));
  releaseAccount.resolve();
  await Promise.all([holder, pending]);

  assert.deepEqual(ack.value(), { error: 'Permission denied.' });
  assert.deepEqual(setup.UserModel.rows[0].servers, ['global']);
  assert.equal(setup.socket.outbound.some(item => item.event === 'room_access_updated'), false);
});

test('chat_message rejects a timeout committed before its room critical section', async () => {
  const setup = authenticatedRoomSocket({ joinedServers: ['global', 'ABC123'], serverCode: 'ABC123' });
  const saveStarted = deferred();
  const releaseSave = deferred();
  const holderMessage = {
    _id: VALID_MESSAGE_ID,
    serverCode: 'ABC123',
    username: 'Bob',
    deleted: false,
    reactions: {},
    markModified() {},
    async save() {
      saveStarted.resolve();
      await releaseSave.promise;
    }
  };
  setup.MessageModel.findById = async () => holderMessage;

  const holdingMutation = setup.socket.trigger('toggle_reaction', { id: VALID_MESSAGE_ID, emoji: '👍' });
  await saveStarted.promise;
  const pendingMessage = setup.socket.trigger('chat_message', { text: 'blocked after commit' });
  await new Promise(resolve => setImmediate(resolve));
  setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'alice', {
    timeoutUntil: new Date(Date.now() + 60_000)
  }));
  releaseSave.resolve();
  await Promise.all([holdingMutation, pendingMessage]);

  assert.equal(setup.MessageModel.created.length, 0);
  assert.equal(setup.ioInstance.outbound.some(item => item.event === 'chat_message'), false);
});

test('successful login and switch expose only active timeout state', async () => {
  const loginTimeoutUntil = new Date(Date.now() + 120_000);
  const loginSetup = registerWithModels({
    user: userDocument({ username: 'Alice', servers: ['global'] }),
    rooms: [roomDocument('global')],
    restrictions: [restrictionDocument('global', 'alice', {
      timeoutUntil: loginTimeoutUntil,
      timeoutBy: 'Admin',
      timeoutReason: 'sensitive'
    })]
  });
  const loginAck = acknowledge();
  await loginSetup.socket.trigger('login', { username: 'Alice', password: '123456' }, loginAck.callback);
  assert.deepEqual(loginAck.value().restriction, {
    banned: false,
    timedOut: true,
    timeoutUntil: loginTimeoutUntil
  });

  const switchTimeoutUntil = new Date(Date.now() + 180_000);
  const switchSetup = authenticatedRoomSocket({ joinedServers: ['global', 'ABC123'] });
  switchSetup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'alice', {
    timeoutUntil: switchTimeoutUntil,
    timeoutBy: 'Admin',
    timeoutReason: 'sensitive'
  }));
  const switchAck = acknowledge();
  await switchSetup.socket.trigger('switch_server', 'ABC123', switchAck.callback);
  assert.deepEqual(switchAck.value().restriction, {
    banned: false,
    timedOut: true,
    timeoutUntil: switchTimeoutUntil
  });
});

for (const row of [
  { name: 'admin may timeout global member', room: 'global', actor: 'admin', action: 'timeout', ok: true },
  { name: 'admin may ban global member', room: 'global', actor: 'admin', action: 'ban', ok: true },
  { name: 'admin may not kick global member', room: 'global', actor: 'admin', action: 'kick', ok: false },
  { name: 'room mod may kick exact-room member', room: 'ABC123', actor: 'mod', action: 'kick', ok: true },
  { name: 'room mod may not kick other-room member', room: 'XYZ789', actor: 'mod', action: 'kick', ok: false },
  { name: 'room mod may not timeout current room mod', room: 'ABC123', actor: 'mod', action: 'timeout', ok: false },
  { name: 'admin may not ban another admin', room: 'ABC123', actor: 'admin', action: 'ban', ok: false }
]) {
  test(row.name, async () => {
    const setup = moderationScenario(row);
    if (row.name.includes('another admin')) setup.UserModel.rows[1].role = 'admin';
    const ack = acknowledge();
    await setup.socket.trigger('moderate_user', {
      serverCode: row.room,
      targetUser: setup.target.username,
      action: row.action,
      duration: row.action === 'timeout' ? '10m' : undefined,
      reason: 'documented test reason'
    }, ack.callback);
    assert.equal(Boolean(ack.value().success), row.ok);
    assert.equal(Boolean(ack.value().error), !row.ok);
  });
}

test('complete moderation policy matrix uses real handlers and preserves private outcomes', async () => {
  const cases = [
    ['global', 'admin', 'user', 'timeout', true],
    ['global', 'admin', 'timed-out-user', 'clear_timeout', true],
    ['global', 'admin', 'user', 'ban', true],
    ['global', 'admin', 'user', 'unban', true],
    ['global', 'admin', 'user', 'kick', false],
    ['global', 'mod', 'user', 'timeout', false],
    ['ABC123', 'mod', 'user', 'kick', true],
    ['ABC123', 'mod', 'user', 'timeout', true],
    ['ABC123', 'mod', 'timed-out-user', 'clear_timeout', true],
    ['ABC123', 'mod', 'user', 'ban', true],
    ['ABC123', 'mod', 'user', 'unban', true],
    ['XYZ789', 'mod-from-ABC123', 'user', 'ban', false],
    ['ABC123', 'mod', 'mod', 'ban', false],
    ['ABC123', 'admin', 'admin', 'ban', false],
    ['ABC123', 'admin', 'NYZhang1', 'ban', false],
    ['ABC123', 'admin', 'System', 'timeout', false]
  ];

  for (const [index, [serverCode, actor, targetKind, action, allowed]] of cases.entries()) {
    const setup = moderationScenario({ room: serverCode, actor, action });
    const actorUser = setup.UserModel.rows[0];
    const targetUser = setup.UserModel.rows[1];
    const room = setup.ChatServerModel.rows.find(candidate => candidate.code === serverCode);
    const reason = `matrix private reason ${index}`;

    room.moderators = room.moderators.filter(username =>
      normalizeAccountKey(username) !== normalizeAccountKey(targetUser.username)
    );
    if (targetKind === 'mod') room.moderators.push(targetUser.username);
    if (targetKind === 'admin') targetUser.role = 'admin';
    if (targetKind === 'NYZhang1' || targetKind === 'System') {
      targetUser.username = targetKind;
      targetUser.displayName = targetKind;
    }
    if (action === 'unban' && serverCode !== 'global') {
      targetUser.servers = targetUser.servers.filter(code => code !== serverCode);
    }

    const targetIsBanned = action === 'unban';
    const targetJoinedServers = targetIsBanned
      ? targetUser.servers.filter(code => code !== serverCode)
      : [...targetUser.servers];
    const targetServerCode = targetIsBanned
      ? (serverCode === 'global' ? 'ABC123' : 'global')
      : serverCode;
    const targetSocket = connectAdditionalSocket(setup, {
      id: `matrix-target-${index}`,
      username: targetUser.username,
      serverCode: targetServerCode,
      joinedServers: targetJoinedServers,
      role: targetUser.role,
      bannedRooms: targetIsBanned ? [serverCode] : []
    });
    setup.UserModel.rows.push(userDocument({
      username: `Observer${index}`,
      displayName: `Observer ${index}`,
      servers: ['global', 'ABC123', 'XYZ789']
    }));
    const observerSocket = connectAdditionalSocket(setup, {
      id: `matrix-observer-${index}`,
      username: `Observer${index}`,
      serverCode,
      joinedServers: ['global', 'ABC123', 'XYZ789']
    });
    const before = structuredClone({
      target: targetUser,
      room,
      restrictions: setup.RoomRestrictionModel.rows
    });

    const ack = acknowledge();
    await setup.socket.trigger('moderate_user', {
      serverCode,
      targetUser: targetUser.username,
      action,
      duration: action === 'timeout' ? '10m' : undefined,
      reason
    }, ack.callback);

    assert.deepEqual(
      ack.value(),
      allowed ? { success: true } : { error: 'Permission denied.' },
      `callback: ${serverCode}/${actor}/${targetKind}/${action}`
    );
    assert.equal(
      setup.ModerationAuditModel.rows.length,
      allowed ? 1 : 0,
      `audit count: ${serverCode}/${actor}/${targetKind}/${action}`
    );

    if (!allowed) {
      assert.deepEqual(structuredClone({
        target: targetUser,
        room,
        restrictions: setup.RoomRestrictionModel.rows
      }), before, `persistence unchanged: ${serverCode}/${actor}/${targetKind}/${action}`);
    } else {
      const audit = setup.ModerationAuditModel.rows[0];
      assert.deepEqual({
        action: audit.action,
        serverCode: audit.serverCode,
        actorUsername: audit.actorUsername,
        targetUsername: audit.targetUsername,
        reason: audit.reason
      }, {
        action,
        serverCode,
        actorUsername: actorUser.username,
        targetUsername: targetUser.username,
        reason
      }, `audit contents: ${serverCode}/${actor}/${targetKind}/${action}`);

      const persistedTarget = setup.UserModel.rows.find(user =>
        normalizeAccountKey(user.username) === normalizeAccountKey(targetUser.username)
      );
      const expectedMemberships = serverCode !== 'global' && (action === 'kick' || action === 'ban')
        ? before.target.servers.filter(code => code !== serverCode)
        : before.target.servers;
      assert.deepEqual(
        structuredClone(persistedTarget),
        { ...before.target, servers: expectedMemberships },
        `target persistence mutation: ${serverCode}/${actor}/${targetKind}/${action}`
      );
      assert.deepEqual(
        structuredClone(room),
        before.room,
        `room persistence mutation: ${serverCode}/${actor}/${targetKind}/${action}`
      );

      const restriction = setup.RoomRestrictionModel.rows.find(row =>
        row.serverCode === serverCode &&
        row.username === normalizeAccountKey(targetUser.username)
      );
      if (action === 'kick') {
        assert.deepEqual(setup.RoomRestrictionModel.rows, before.restrictions);
      } else {
        assert.ok(restriction, `restriction exists: ${serverCode}/${actor}/${targetKind}/${action}`);
      }
      if (action === 'timeout') {
        assert.equal(restriction.timeoutUntil instanceof Date, true);
        assert.equal(restriction.timeoutBy, actorUser.username);
        assert.equal(restriction.timeoutReason, reason);
        assert.equal(Boolean(restriction.bannedAt), false);
      }
      if (action === 'clear_timeout') {
        assert.deepEqual({
          timeoutUntil: restriction.timeoutUntil,
          timeoutBy: restriction.timeoutBy,
          timeoutReason: restriction.timeoutReason
        }, { timeoutUntil: null, timeoutBy: null, timeoutReason: null });
      }
      if (action === 'ban') {
        assert.equal(restriction.bannedAt instanceof Date, true);
        assert.equal(restriction.bannedBy, actorUser.username);
        assert.equal(restriction.banReason, reason);
        assert.deepEqual({
          timeoutUntil: restriction.timeoutUntil,
          timeoutBy: restriction.timeoutBy,
          timeoutReason: restriction.timeoutReason
        }, { timeoutUntil: null, timeoutBy: null, timeoutReason: null });
      }
      if (action === 'unban') {
        assert.deepEqual({
          bannedAt: restriction.bannedAt,
          bannedBy: restriction.bannedBy,
          banReason: restriction.banReason
        }, { bannedAt: null, bannedBy: null, banReason: null });
      }
    }

    const fixtureSockets = [setup.socket, ...setup.ioInstance.sockets];
    const targetUpdates = targetSocket.outbound.filter(item =>
      item.event === 'room_access_updated' || item.event === 'room_restriction_updated'
    );
    assert.deepEqual(
      targetUpdates.map(item => ({ target: item.target, event: item.event })),
      allowed ? [
        { target: 'self', event: 'room_access_updated' },
        { target: 'self', event: 'room_restriction_updated' }
      ] : [],
      `target-only events: ${serverCode}/${actor}/${targetKind}/${action}`
    );
    if (allowed) {
      assert.equal(targetUpdates[0].payload.username, targetUser.username);
      assert.deepEqual({
        serverCode: targetUpdates[1].payload.serverCode,
        banned: targetUpdates[1].payload.banned,
        timedOut: targetUpdates[1].payload.timedOut
      }, {
        serverCode,
        banned: action === 'ban',
        timedOut: action === 'timeout'
      });
    }
    assert.equal(setup.socket.outbound.some(item =>
      item.event === 'room_access_updated' || item.event === 'room_restriction_updated'
    ), false);
    assert.equal(observerSocket.outbound.some(item =>
      item.event === 'room_access_updated' || item.event === 'room_restriction_updated'
    ), false);
    const roomWideEvents = [
      ...setup.ioInstance.outbound,
      ...fixtureSockets.flatMap(live =>
        live.outbound.filter(item => item.target !== 'self')
      )
    ];
    assert.equal(roomWideEvents.some(item =>
      item.event === 'room_access_updated' || item.event === 'room_restriction_updated'
    ), false);

    const roomNotices = roomWideEvents.filter(item =>
      (item.room === serverCode || item.target === serverCode) && item.event === 'system_message'
    );
    assert.deepEqual(
      roomNotices.map(item => item.payload),
      allowed && (action === 'kick' || action === 'ban')
        ? ['A member was removed by moderation.']
        : [],
      `generic room notice: ${serverCode}/${actor}/${targetKind}/${action}`
    );
    const roomWidePayloads = JSON.stringify(roomWideEvents);
    assert.equal(roomWidePayloads.includes(reason), false);
    assert.equal(roomWidePayloads.includes(actorUser.username), false);
    assert.equal(roomWidePayloads.includes(targetUser.username), false);
    for (const privateField of ['banReason', 'bannedBy', 'timeoutReason', 'timeoutBy']) {
      assert.equal(roomWidePayloads.includes(privateField), false);
    }
  }
});

test('moderationScenario exposes the documented aggregate and individual model handles', () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'kick' });
  assert.deepEqual(setup.models, {
    UserModel: setup.UserModel,
    ChatServerModel: setup.ChatServerModel,
    MessageModel: setup.MessageModel,
    RoomRestrictionModel: setup.RoomRestrictionModel,
    ModerationAuditModel: setup.ModerationAuditModel,
    ModerationReportModel: setup.ModerationReportModel
  });
});

test('forced migration rejects a private-room draft instead of publishing it in fallback Global', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'kick' });
  const leaveStarted = deferred();
  const releaseLeave = deferred();
  const targetSocket = connectAdditionalSocket(setup, {
    id: 'target-private-draft', username: 'TargetUser', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  targetSocket.leave = async code => {
    leaveStarted.resolve();
    await releaseLeave.promise;
    FakeSocket.prototype.leave.call(targetSocket, code);
  };

  const moderationAck = acknowledge();
  const moderationPending = setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'kick',
    reason: 'remove access before the draft can publish'
  }, moderationAck.callback);
  await leaveStarted.promise;

  assert.equal(targetSocket.serverCode, 'global', 'server stages the fallback before transport settles');
  await targetSocket.trigger('chat_message', {
    serverCode: 'ABC123', clientContextId: 17, text: 'private draft must stay private'
  });
  const savedCount = setup.MessageModel.created.length;
  const publishedInGlobal = setup.ioInstance.outbound.some(item =>
    item.room === 'global' && item.event === 'chat_message'
  );
  releaseLeave.resolve();
  await moderationPending;
  assert.equal(savedCount, 0);
  assert.equal(publishedInGlobal, false);
  assert.deepEqual(moderationAck.value(), { success: true });
});

test('partial private ban persistence repairs removal invariants and quarantines target sessions', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'ban' });
  setup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators.push('TargetUser');
  const targetSocket = connectAdditionalSocket(setup, {
    id: 'target-partial-ban', username: 'TargetUser', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const baseFindOne = setup.UserModel.findOne.bind(setup.UserModel);
  let targetReads = 0;
  setup.UserModel.findOne = async query => {
    const document = await baseFindOne(query);
    if (document?.username !== 'TargetUser' || ++targetReads !== 2) return document;
    return {
      ...document,
      markModified() {},
      async save() { throw new Error('simulated membership save failure'); }
    };
  };

  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'ban',
    reason: 'durable partial failure regression'
  }, ack.callback);

  assert.deepEqual(ack.value(), { error: 'Moderation failed.' });
  assert.equal(Boolean(setup.RoomRestrictionModel.rows[0]?.bannedAt), true);
  assert.equal(setup.UserModel.rows.find(user => user.username === 'TargetUser').servers.includes('ABC123'), false);
  assert.equal(setup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators.includes('TargetUser'), false);
  assert.equal(targetSocket.username, null);
  assert.equal(targetSocket.joinedRooms.has('ABC123'), false);
  assert.equal(targetSocket.disconnected, true);
  assert.equal(setup.onlineUsersMap.has(targetSocket.id), false);
});

test('private unban removes stale membership and moderator authority before clearing the ban', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'unban' });
  setup.UserModel.rows.find(user => user.username === 'TargetUser').servers = ['global', 'ABC123', 'XYZ789'];
  setup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators.push('tArGeTuSeR');
  const targetSocket = connectAdditionalSocket(setup, {
    id: 'target-stale-unban', username: 'TargetUser', serverCode: 'XYZ789',
    joinedServers: ['global', 'ABC123', 'XYZ789'], bannedRooms: ['ABC123']
  });

  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'unban',
    reason: 'unban without restoring old authority'
  }, ack.callback);

  assert.deepEqual(ack.value(), { success: true });
  assert.equal(setup.UserModel.rows.find(user => user.username === 'TargetUser').servers.includes('ABC123'), false);
  assert.equal(setup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators.some(
    username => normalizeAccountKey(username) === 'targetuser'
  ), false);
  assert.equal(targetSocket.joinedServers.includes('ABC123'), false);
  assert.equal(setup.onlineUsersMap.get(targetSocket.id).joinedServers.includes('ABC123'), false);
  assert.equal(setup.RoomRestrictionModel.rows[0].bannedAt, null);
});

test('moderation persistence uses one shared database transaction when the models support it', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'ban' });
  let transactionCalls = 0;
  const sharedConnection = {
    async transaction(operation) {
      transactionCalls += 1;
      return operation({ id: 'test-transaction-session' });
    }
  };
  setup.UserModel.db = sharedConnection;
  setup.ChatServerModel.db = sharedConnection;
  setup.RoomRestrictionModel.db = sharedConnection;

  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'ban',
    reason: 'atomic persistence regression'
  }, ack.callback);

  assert.deepEqual(ack.value(), { success: true });
  assert.equal(transactionCalls, 1);
  assert.equal(Boolean(setup.RoomRestrictionModel.rows[0]?.bannedAt), true);
  assert.equal(setup.UserModel.rows.find(user => user.username === 'TargetUser').servers.includes('ABC123'), false);
});

test('failed transaction does not decompose an atomic kick into partial compensating writes', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'kick' });
  setup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators.push('TargetUser');
  const targetSocket = connectAdditionalSocket(setup, {
    id: 'failed-transaction-target', username: 'TargetUser', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const baseRoomFind = setup.ChatServerModel.findOne.bind(setup.ChatServerModel);
  setup.ChatServerModel.findOne = async query => {
    const room = await baseRoomFind(query);
    if (!room || room.code !== 'ABC123') return room;
    return {
      ...room,
      markModified() {},
      async save() { throw new Error('simulated permanent room save failure'); }
    };
  };
  const sharedConnection = {
    async transaction() { throw new Error('simulated transaction start failure'); }
  };
  setup.UserModel.db = sharedConnection;
  setup.ChatServerModel.db = sharedConnection;
  setup.RoomRestrictionModel.db = sharedConnection;

  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'kick',
    reason: 'transaction failure must stay atomic'
  }, ack.callback);

  assert.deepEqual(ack.value(), { error: 'Moderation failed.' });
  assert.equal(setup.UserModel.rows.find(user => user.username === 'TargetUser').servers.includes('ABC123'), true);
  assert.equal(setup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators.includes('TargetUser'), true);
  assert.equal(targetSocket.username, null, 'uncertain sessions are still quarantined');
});

test('failed fallback kick restores its prior membership when removal repair cannot complete', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'kick' });
  setup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators.push('TargetUser');
  const targetSocket = connectAdditionalSocket(setup, {
    id: 'failed-fallback-target', username: 'TargetUser', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const baseRoomFind = setup.ChatServerModel.findOne.bind(setup.ChatServerModel);
  setup.ChatServerModel.findOne = async query => {
    const room = await baseRoomFind(query);
    if (!room || room.code !== 'ABC123') return room;
    return {
      ...room,
      markModified() {},
      async save() { throw new Error('simulated permanent room save failure'); }
    };
  };

  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'kick',
    reason: 'failed fallback removal must restore a consistent prior state'
  }, ack.callback);

  assert.deepEqual(ack.value(), { error: 'Moderation failed.' });
  assert.equal(setup.UserModel.rows.find(user => user.username === 'TargetUser').servers.includes('ABC123'), true);
  assert.equal(setup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators.includes('TargetUser'), true);
  assert.equal(targetSocket.username, null, 'uncertain sessions are still quarantined');
});

test('failed fallback ban restores prior access when neither its ban nor removal can be made durable', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'ban' });
  setup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators.push('TargetUser');
  setup.RoomRestrictionModel.findOneAndUpdate = async () => {
    throw new Error('simulated permanent restriction failure');
  };
  const targetSocket = connectAdditionalSocket(setup, {
    id: 'failed-fallback-ban-target', username: 'TargetUser', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const baseRoomFind = setup.ChatServerModel.findOne.bind(setup.ChatServerModel);
  setup.ChatServerModel.findOne = async query => {
    const room = await baseRoomFind(query);
    if (!room || room.code !== 'ABC123') return room;
    return {
      ...room,
      markModified() {},
      async save() { throw new Error('simulated permanent room save failure'); }
    };
  };

  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'ban',
    reason: 'failed ban must not create revivable stale moderation authority'
  }, ack.callback);

  assert.deepEqual(ack.value(), { error: 'Moderation failed.' });
  assert.equal(setup.RoomRestrictionModel.rows.some(row => Boolean(row.bannedAt)), false);
  assert.equal(setup.UserModel.rows.find(user => user.username === 'TargetUser').servers.includes('ABC123'), true);
  assert.equal(setup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators.includes('TargetUser'), true);
  assert.equal(targetSocket.username, null, 'uncertain sessions are still quarantined');
});

test('failed fallback snapshot restore establishes a durable ban before releasing quarantine', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'kick' });
  setup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators.push('TargetUser');
  const targetSocket = connectAdditionalSocket(setup, {
    id: 'failed-snapshot-restore-target', username: 'TargetUser', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const baseUserFind = setup.UserModel.findOne.bind(setup.UserModel);
  setup.UserModel.findOne = async query => {
    const user = await baseUserFind(query);
    if (!user || user.username !== 'TargetUser') return user;
    return {
      ...user,
      markModified() {},
      async save() {
        if (this.servers.includes('ABC123')) {
          throw new Error('simulated permanent membership restore failure');
        }
        user.servers = [...this.servers];
        return user.save();
      }
    };
  };
  const baseRoomFind = setup.ChatServerModel.findOne.bind(setup.ChatServerModel);
  setup.ChatServerModel.findOne = async query => {
    const room = await baseRoomFind(query);
    if (!room || room.code !== 'ABC123') return room;
    return {
      ...room,
      markModified() {},
      async save() { throw new Error('simulated permanent room save failure'); }
    };
  };

  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'kick',
    reason: 'failed rollback requires a durable access gate'
  }, ack.callback);

  assert.deepEqual(ack.value(), { error: 'Moderation failed.' });
  assert.equal(Boolean(setup.RoomRestrictionModel.rows[0]?.bannedAt), true);
  assert.equal(setup.UserModel.rows.find(user => user.username === 'TargetUser').servers.includes('ABC123'), false);
  assert.equal(setup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators.includes('TargetUser'), true);
  assert.equal(targetSocket.username, null, 'uncertain sessions are still quarantined');
});

test('committed Global ban response loss quarantines every preflighted target session', async () => {
  const restrictions = createMemoryModel([]);
  const baseUpsert = restrictions.findOneAndUpdate.bind(restrictions);
  let writes = 0;
  restrictions.findOneAndUpdate = async (...args) => {
    const result = await baseUpsert(...args);
    if (++writes === 1) throw new Error('simulated committed response loss');
    return result;
  };
  const setup = moderationScenario({
    room: 'global', actor: 'admin', action: 'ban', RoomRestrictionModel: restrictions
  });
  const firstLeaveStarted = deferred();
  const releaseFirstLeave = deferred();
  const first = connectAdditionalSocket(setup, {
    id: 'uncertain-global-ban-1', username: 'TargetUser', serverCode: 'global',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  first.leave = async code => {
    firstLeaveStarted.resolve();
    await releaseFirstLeave.promise;
    FakeSocket.prototype.leave.call(first, code);
  };
  const second = connectAdditionalSocket(setup, {
    id: 'uncertain-global-ban-2', username: 'targetuser', serverCode: 'global',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  first.joinedRooms.add('ABC123');
  second.joinedRooms.add('ABC123');
  second.joinedRooms.add('XYZ789');
  second.disconnect = async () => { throw new Error('simulated disconnect failure'); };
  setup.onlineUsersMap.set('uncertain-global-ban-map-only', {
    username: 'TARGETUSER', serverCode: 'global',
    joinedServers: ['global', 'ABC123', 'XYZ789'], bannedRooms: []
  });

  const ack = acknowledge();
  const pending = setup.socket.trigger('moderate_user', {
    serverCode: 'global', targetUser: 'TargetUser', action: 'ban',
    reason: 'uncertain Global ban persistence'
  }, ack.callback);
  await Promise.race([firstLeaveStarted.promise, pending]);

  assert.equal(second.username, null, 'later live sessions are staged before the first transport await');
  assert.equal(setup.onlineUsersMap.has(second.id), false);
  assert.equal(setup.onlineUsersMap.has('uncertain-global-ban-map-only'), false);
  releaseFirstLeave.resolve();
  await pending;

  assert.deepEqual(ack.value(), { error: 'Moderation failed.' });
  assert.equal(Boolean(restrictions.rows[0]?.bannedAt), true);
  assert.equal(first.disconnected, true);
  assert.equal(second.username, null);
  assert.equal(second.joinedRooms.has('global'), false);
  assert.equal(second.joinedRooms.has('ABC123'), false);
  assert.equal(second.joinedRooms.has('XYZ789'), false);
});

test('active private-room bans deny admins moderation and room-role mutations', async () => {
  const moderationSetup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'timeout' });
  moderationSetup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'Admin', {
    bannedAt: new Date(), bannedBy: 'SecondAdmin', banReason: 'active actor ban'
  }));
  const moderationAck = acknowledge();
  await moderationSetup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'timeout', duration: '10m',
    reason: 'must be denied while banned'
  }, moderationAck.callback);
  assert.deepEqual(moderationAck.value(), { error: 'Permission denied.' });

  const roleSetup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'kick' });
  roleSetup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'Admin', {
    bannedAt: new Date(), bannedBy: 'SecondAdmin', banReason: 'active actor ban'
  }));
  const roleAck = acknowledge();
  await roleSetup.socket.trigger('manage_role', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'promote_mod'
  }, roleAck.callback);
  assert.deepEqual(roleAck.value(), { error: 'Permission denied.' });
  assert.equal(roleSetup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators.includes('TargetUser'), false);
});

test('banned non-admin owner cannot delete a private room from a fallback session', async () => {
  const setup = registerWithModels({
    users: [userDocument({ username: 'Owner', displayName: 'Owner', servers: ['global'] })],
    rooms: [
      roomDocument('global', { owner: 'System' }),
      roomDocument('ABC123', { owner: 'Owner', moderators: [] })
    ],
    restrictions: [restrictionDocument('ABC123', 'Owner', { bannedAt: new Date() })]
  });
  Object.assign(setup.socket, {
    username: 'Owner', displayName: 'Owner', role: 'user', serverCode: 'global',
    joinedServers: ['global'], bannedRooms: ['ABC123']
  });
  setup.onlineUsersMap.set(setup.socket.id, {
    username: 'Owner', displayName: 'Owner', role: 'user', serverCode: 'global',
    joinedServers: ['global'], bannedRooms: ['ABC123']
  });
  setup.ioInstance.sockets.push(setup.socket);

  const ack = acknowledge();
  await setup.socket.trigger('delete_server', 'ABC123', ack.callback);
  assert.deepEqual(ack.value(), { error: 'Permission denied.' });
  assert.equal(setup.ChatServerModel.rows.some(room => room.code === 'ABC123'), true);
});

test('sensitive report reads do not disclose after a completed moderator demotion', async () => {
  const setup = reportingScenario();
  setup.ModerationReportModel.rows.push({
    _id: '507f1f77bcf86cd799439099', serverCode: 'ABC123', reporterUsername: 'Alice',
    targetUsername: 'Bob', messageId: null, reason: 'private interleaving reason', status: 'open',
    createdAt: new Date('2026-08-08T12:00:00.000Z')
  });
  setup.UserModel.rows.push(userDocument({
    username: 'SecondAdmin', displayName: 'SecondAdmin', role: 'admin',
    servers: ['global', 'ABC123']
  }));
  const administrator = connectAdditionalSocket(setup, {
    id: 'sensitive-read-demoter', username: 'SecondAdmin', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123'], role: 'admin'
  });

  const queryStarted = deferred();
  const releaseQuery = deferred();
  const baseFind = setup.ModerationReportModel.find.bind(setup.ModerationReportModel);
  setup.ModerationReportModel.find = query => {
    const result = baseFind(query);
    const baseThen = result.then.bind(result);
    result.then = (resolve, reject) => {
      queryStarted.resolve();
      return releaseQuery.promise.then(() => baseThen(resolve, reject), reject);
    };
    return result;
  };

  let revocationCompleted = false;
  let disclosedAfterRevocation = false;
  const readPending = setup.modSocket.trigger('list_moderation_reports', {
    serverCode: 'ABC123', status: 'open'
  }, result => {
    if (revocationCompleted && Array.isArray(result?.items) && result.items.length > 0) {
      disclosedAfterRevocation = true;
    }
  });
  await queryStarted.promise;
  const demotionPending = administrator.trigger('manage_role', {
    serverCode: 'ABC123', targetUser: 'ExactMod', action: 'demote_mod'
  }, result => { revocationCompleted = Boolean(result?.success); });
  await new Promise(resolve => setImmediate(resolve));
  releaseQuery.resolve();
  await Promise.all([readPending, demotionPending]);

  assert.equal(revocationCompleted, true);
  assert.equal(disclosedAfterRevocation, false);
});

test('supplied malformed report status is rejected instead of defaulting to open', async () => {
  const setup = reportingScenario();
  for (const status of [{}, undefined, null, 12]) {
    const ack = acknowledge();
    await setup.modSocket.trigger('list_moderation_reports', {
      serverCode: 'ABC123', status
    }, ack.callback);
    assert.deepEqual(ack.value(), { error: 'Invalid input format.' });
  }
});

test('blocked message response is scoped to its room and client send context', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'mod', action: 'kick' });
  const room = setup.ChatServerModel.rows.find(candidate => candidate.code === 'ABC123');
  room.autoMod = {
    blockedKeywords: ['blocked'], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30
  };
  await setup.socket.trigger('chat_message', {
    serverCode: 'ABC123', clientContextId: 41, text: 'blocked content'
  });
  assert.deepEqual(
    setup.socket.outbound.find(item => item.event === 'message_blocked')?.payload,
    { rule: 'content_policy', serverCode: 'ABC123', clientContextId: 41 }
  );
});

for (const action of ['timeout', 'ban']) {
  test(`admin may ${action} a Global account whose private-only legacy membership omits Global`, async () => {
    const setup = moderationScenario({ room: 'global', actor: 'admin', action });
    setup.UserModel.rows.find(user => user.username === 'TargetUser').servers = ['ABC123', 'XYZ789'];
    const ack = acknowledge();
    await setup.socket.trigger('moderate_user', {
      serverCode: 'global', targetUser: 'TargetUser', action,
      duration: action === 'timeout' ? '10m' : undefined,
      reason: 'documented legacy Global moderation'
    }, ack.callback);
    assert.deepEqual(ack.value(), { success: true });
  });
}

test('Private kick removes membership and moderator authority before awaiting every-session eviction', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'kick' });
  setup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators.push('TargetUser');
  const firstLeaveStarted = deferred();
  const releaseFirstLeave = deferred();
  const first = connectAdditionalSocket(setup, {
    id: 'target-1', username: 'TargetUser', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  first.leave = async code => {
    firstLeaveStarted.resolve();
    await releaseFirstLeave.promise;
    FakeSocket.prototype.leave.call(first, code);
  };
  const second = connectAdditionalSocket(setup, {
    id: 'target-2', username: 'targetuser', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  setup.onlineUsersMap.set('target-map-only', {
    username: 'TARGETUSER', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789'], bannedRooms: []
  });

  const ack = acknowledge();
  const pending = setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'targetuser', action: 'kick',
    reason: 'documented test reason'
  }, ack.callback);
  await Promise.race([firstLeaveStarted.promise, pending]);

  assert.deepEqual(setup.UserModel.rows.find(user => user.username === 'TargetUser').servers, ['global', 'XYZ789']);
  assert.deepEqual(setup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators, ['RoomMod', 'ABCMod']);
  for (const live of [first, second]) {
    assert.deepEqual(live.joinedServers, ['global', 'XYZ789']);
    assert.equal(live.serverCode, 'global');
    assert.deepEqual(setup.onlineUsersMap.get(live.id).joinedServers, ['global', 'XYZ789']);
    assert.equal(setup.onlineUsersMap.get(live.id).serverCode, 'global');
  }
  assert.deepEqual(setup.onlineUsersMap.get('target-map-only').joinedServers, ['global', 'XYZ789']);
  assert.equal(setup.onlineUsersMap.get('target-map-only').serverCode, 'global');

  releaseFirstLeave.resolve();
  await pending;
  assert.deepEqual(ack.value(), { success: true });
  assert.equal(setup.RoomRestrictionModel.rows.length, 0);
  assert.equal(setup.ModerationAuditModel.rows.length, 1);
  for (const live of [first, second]) {
    assert.equal(live.joinedRooms.has('ABC123'), false);
    assert.equal(live.joinedRooms.has('global'), true);
    assert.equal(live.outbound.some(item => item.event === 'room_access_updated'), true);
  }
});

test('Private ban removes access and upserts normalized ban fields while clearing timeout fields', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'ban' });
  setup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators.push('TARGETUSER');
  setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'targetuser', {
    timeoutUntil: new Date(Date.now() + 60_000),
    timeoutBy: 'RoomMod',
    timeoutReason: 'superseded timeout'
  }));
  const targetSocket = connectAdditionalSocket(setup, {
    id: 'target-ban', username: 'TargetUser', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'abc123', targetUser: 'TARGETUSER', action: 'BAN',
    reason: 'documented ban reason'
  }, ack.callback);

  assert.deepEqual(ack.value(), { success: true });
  assert.deepEqual(setup.UserModel.rows.find(user => user.username === 'TargetUser').servers, ['global', 'XYZ789']);
  assert.deepEqual(setup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators, ['RoomMod', 'ABCMod']);
  assert.equal(targetSocket.serverCode, 'global');
  const restriction = setup.RoomRestrictionModel.rows[0];
  assert.equal(restriction.serverCode, 'ABC123');
  assert.equal(restriction.username, 'targetuser');
  assert.equal(restriction.bannedAt instanceof Date, true);
  assert.equal(restriction.bannedBy, 'Admin');
  assert.equal(restriction.banReason, 'documented ban reason');
  assert.equal(restriction.timeoutUntil, null);
  assert.equal(restriction.timeoutBy, null);
  assert.equal(restriction.timeoutReason, null);
});

test('Global ban preserves private memberships and moves all Global sessions to one accessible private fallback', async () => {
  const setup = moderationScenario({ room: 'global', actor: 'admin', action: 'ban' });
  setup.UserModel.rows.find(user => user.username === 'TargetUser').servers.push('OLD123');
  const first = connectAdditionalSocket(setup, {
    id: 'target-global-1', username: 'TargetUser', serverCode: 'global',
    joinedServers: ['global', 'ABC123', 'XYZ789', 'OLD123']
  });
  const second = connectAdditionalSocket(setup, {
    id: 'target-global-2', username: 'targetuser', serverCode: 'global',
    joinedServers: ['global', 'ABC123', 'XYZ789', 'OLD123']
  });
  setup.onlineUsersMap.set('target-global-map', {
    username: 'TARGETUSER', serverCode: 'global',
    joinedServers: ['global', 'ABC123', 'XYZ789', 'OLD123'], bannedRooms: []
  });
  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'GLOBAL', targetUser: 'targetuser', action: 'ban',
    reason: 'documented global ban'
  }, ack.callback);

  assert.deepEqual(ack.value(), { success: true });
  assert.deepEqual(setup.UserModel.rows.find(user => user.username === 'TargetUser').servers, ['global', 'ABC123', 'XYZ789', 'OLD123']);
  for (const live of [first, second]) {
    assert.deepEqual(live.joinedServers, ['ABC123', 'XYZ789']);
    assert.deepEqual(live.bannedRooms, ['global']);
    assert.equal(live.serverCode, 'ABC123');
    assert.equal(live.joinedRooms.has('global'), false);
    assert.equal(live.joinedRooms.has('ABC123'), true);
  }
  assert.equal(setup.onlineUsersMap.get('target-global-map').serverCode, 'ABC123');
  assert.deepEqual(setup.onlineUsersMap.get('target-global-map').bannedRooms, ['global']);
});

test('Global ban socket-discovery failure makes no durable or published change', async () => {
  const setup = moderationScenario({ room: 'global', actor: 'admin', action: 'ban' });
  const targetSocket = connectAdditionalSocket(setup, {
    id: 'target-discovery-failure', username: 'TargetUser', serverCode: 'global',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  targetSocket.joinedRooms.add('global');
  const beforeUser = structuredClone(setup.UserModel.rows.find(user => user.username === 'TargetUser'));
  const beforeSession = structuredClone(setup.onlineUsersMap.get(targetSocket.id));
  const beforeTargetEvents = [...targetSocket.outbound];
  const beforeIoEvents = [...setup.ioInstance.outbound];
  setup.ioInstance.fetchSockets = async () => { throw new Error('adapter unavailable'); };

  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'global', targetUser: 'TargetUser', action: 'ban',
    reason: 'discovery must preflight durable mutation'
  }, ack.callback);

  assert.deepEqual(ack.value(), { error: 'Moderation failed.' });
  assert.deepEqual(setup.UserModel.rows.find(user => user.username === 'TargetUser'), beforeUser);
  assert.deepEqual(setup.RoomRestrictionModel.rows, []);
  assert.deepEqual(setup.ModerationAuditModel.rows, []);
  assert.deepEqual(setup.onlineUsersMap.get(targetSocket.id), beforeSession);
  assert.equal(targetSocket.serverCode, 'global');
  assert.deepEqual(targetSocket.joinedServers, ['global', 'ABC123', 'XYZ789']);
  assert.deepEqual(targetSocket.bannedRooms, []);
  assert.equal(targetSocket.joinedRooms.has('global'), true);
  assert.deepEqual(targetSocket.outbound, beforeTargetEvents);
  assert.deepEqual(setup.ioInstance.outbound, beforeIoEvents);
});

test('room deletion serializes a concurrent Global ban and cannot restore stale Global access', async () => {
  const setup = moderationScenario({ room: 'global', actor: 'admin', action: 'ban' });
  const deleteStarted = deferred();
  const releaseDelete = deferred();
  const banWriteStarted = deferred();
  const originalRestrictionUpdate = setup.RoomRestrictionModel.findOneAndUpdate.bind(setup.RoomRestrictionModel);
  setup.RoomRestrictionModel.findOneAndUpdate = async (query, update, options) => {
    if (query.serverCode === 'global' && update?.$set?.bannedAt) banWriteStarted.resolve();
    return originalRestrictionUpdate(query, update, options);
  };
  setup.ChatServerModel.deleteOne = async query => {
    deleteStarted.resolve();
    await releaseDelete.promise;
    const index = setup.ChatServerModel.rows.findIndex(room => room.code === query.code);
    if (index >= 0) setup.ChatServerModel.rows.splice(index, 1);
  };
  setup.UserModel.updateMany = async (_query, update) => {
    const removedRoom = update?.$pull?.servers;
    for (const user of setup.UserModel.rows) {
      user.servers = (Array.isArray(user.servers) ? user.servers : []).filter(code => code !== removedRoom);
    }
  };
  setup.MessageModel.deleteMany = async () => {};

  const targetSocket = connectAdditionalSocket(setup, {
    id: 'target-delete-global-ban', username: 'TargetUser', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  targetSocket.joinedRooms.add('global');
  setup.onlineUsersMap.set('target-delete-global-ban-map', {
    username: 'targetuser', role: 'user', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789'], bannedRooms: []
  });

  const deleteAck = acknowledge();
  const deletePending = setup.socket.trigger('delete_server', 'ABC123', deleteAck.callback);
  await deleteStarted.promise;

  const banAck = acknowledge();
  const banPending = setup.socket.trigger('moderate_user', {
    serverCode: 'global', targetUser: 'TargetUser', action: 'ban',
    reason: 'concurrent deletion cannot restore access'
  }, banAck.callback);
  const banWroteBeforeDeleteReleased = await Promise.race([
    banWriteStarted.promise.then(() => true),
    new Promise(resolve => setImmediate(() => resolve(false)))
  ]);
  releaseDelete.resolve();
  await Promise.all([deletePending, banPending]);

  assert.equal(banWroteBeforeDeleteReleased, false);
  assert.deepEqual(deleteAck.value(), { success: true });
  assert.deepEqual(banAck.value(), { success: true });
  assert.deepEqual(setup.UserModel.rows.find(user => user.username === 'TargetUser').servers, ['global', 'XYZ789']);
  assert.equal(setup.RoomRestrictionModel.rows.some(row => row.serverCode === 'global' && row.bannedAt), true);
  assert.equal(targetSocket.serverCode, 'XYZ789');
  assert.deepEqual(targetSocket.joinedServers, ['XYZ789']);
  assert.deepEqual(targetSocket.bannedRooms, ['global']);
  assert.equal(targetSocket.joinedRooms.has('ABC123'), false);
  assert.equal(targetSocket.joinedRooms.has('global'), false);
  assert.equal(targetSocket.joinedRooms.has('XYZ789'), true);
  assert.equal(setup.onlineUsersMap.get('target-delete-global-ban-map').serverCode, 'XYZ789');
  assert.deepEqual(setup.onlineUsersMap.get('target-delete-global-ban-map').joinedServers, ['XYZ789']);
  assert.deepEqual(setup.onlineUsersMap.get('target-delete-global-ban-map').bannedRooms, ['global']);
});

test('Global ban reconciliation never inserts Global implicitly for private or null fallback', () => {
  const live = {
    serverCode: 'global', joinedServers: ['global', 'ABC123'], bannedRooms: [],
    username: 'TargetUser'
  };
  const session = {
    serverCode: 'global', joinedServers: ['global', 'ABC123'], bannedRooms: [],
    username: 'TargetUser'
  };
  applySessionAccessSnapshot({
    live, session, joinedServers: ['ABC123'], bannedRooms: ['global'],
    removedRoom: 'global', fallbackCode: 'ABC123'
  });
  assert.deepEqual(live.joinedServers, ['ABC123']);
  assert.equal(live.serverCode, 'ABC123');
  assert.equal(live.joinedServers.includes('global'), false);
  applySessionAccessSnapshot({
    live, session, joinedServers: [], bannedRooms: ['global'],
    removedRoom: 'ABC123', fallbackCode: null
  });
  assert.deepEqual(live.joinedServers, []);
  assert.equal(live.serverCode, null);
  assert.equal(session.serverCode, null);
  assert.equal(session.joinedServers.includes('global'), false);
});

test('Global ban real reconciliation moves live and map-only Global sessions to lobby when no fallback exists', async () => {
  const setup = moderationScenario({ room: 'global', actor: 'admin', action: 'ban' });
  setup.UserModel.rows.find(user => user.username === 'TargetUser').servers = ['global'];
  const targetSocket = connectAdditionalSocket(setup, {
    id: 'target-global-lobby', username: 'TargetUser', serverCode: 'global',
    joinedServers: ['global']
  });
  setup.onlineUsersMap.set('target-global-lobby-map', {
    username: 'targetuser', serverCode: 'global', joinedServers: ['global'], bannedRooms: []
  });
  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'global', targetUser: 'TargetUser', action: 'ban',
    reason: 'documented no-fallback Global ban'
  }, ack.callback);

  assert.deepEqual(ack.value(), { success: true });
  assert.equal(targetSocket.serverCode, null);
  assert.deepEqual(targetSocket.joinedServers, []);
  assert.deepEqual(targetSocket.bannedRooms, ['global']);
  assert.equal(targetSocket.joinedRooms.has('global'), false);
  assert.equal(setup.onlineUsersMap.get('target-global-lobby-map').serverCode, null);
  assert.deepEqual(setup.onlineUsersMap.get('target-global-lobby-map').joinedServers, []);
  assert.deepEqual(setup.onlineUsersMap.get('target-global-lobby-map').bannedRooms, ['global']);
});

test('globally banned lobby creation preserves the Global ban and never publishes Global presence', async () => {
  const broadcasts = [];
  const setup = registerWithModels({
    user: userDocument({ username: 'Alice', servers: ['global'] }),
    rooms: [roomDocument('global')],
    restrictions: [restrictionDocument('global', 'alice', { bannedAt: new Date() })],
    broadcastOnlineUsersFn: code => broadcasts.push(code)
  });
  Object.assign(setup.socket, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: null,
    joinedServers: [], bannedRooms: ['global']
  });
  setup.onlineUsersMap.set(setup.socket.id, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: null,
    joinedServers: [], bannedRooms: ['global']
  });
  const ack = acknowledge();
  await setup.socket.trigger('create_server', 'Private Team', ack.callback);
  assert.equal(ack.value().success, true);
  assert.equal(setup.socket.joinedServers.includes('global'), false);
  assert.deepEqual(setup.socket.bannedRooms, ['global']);
  assert.equal(setup.onlineUsersMap.get(setup.socket.id).joinedServers.includes('global'), false);
  assert.deepEqual(setup.onlineUsersMap.get(setup.socket.id).bannedRooms, ['global']);
  assert.equal(setup.socket.joinedRooms.has('global'), false);
  assert.equal(broadcasts.includes('global'), false);
});

test('Timeout stores the exact configured expiry, keeps transport access, and notifies only target sessions', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'timeout' });
  const targetSocket = connectAdditionalSocket(setup, {
    id: 'target-timeout', username: 'TargetUser', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const before = Date.now();
  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'targetuser', action: 'timeout', duration: '10m',
    reason: 'documented timeout reason'
  }, ack.callback);
  const after = Date.now();

  assert.deepEqual(ack.value(), { success: true });
  const restriction = setup.RoomRestrictionModel.rows[0];
  assert.equal(restriction.timeoutUntil.getTime() >= before + MODERATION_DURATIONS['10m'], true);
  assert.equal(restriction.timeoutUntil.getTime() <= after + MODERATION_DURATIONS['10m'], true);
  assert.equal(restriction.timeoutBy, 'Admin');
  assert.equal(restriction.timeoutReason, 'documented timeout reason');
  assert.equal(targetSocket.serverCode, 'ABC123');
  assert.equal(targetSocket.joinedRooms.has('ABC123'), true);
  assert.equal(targetSocket.outbound.filter(item => item.event === 'room_restriction_updated').length, 1);
  assert.equal(setup.socket.outbound.some(item => item.event === 'room_restriction_updated'), false);
});

test('clear_timeout and unban clear only their own fields and never restore membership or moderation', async () => {
  const clearSetup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'clear_timeout' });
  Object.assign(clearSetup.RoomRestrictionModel.rows[0], {
    bannedAt: new Date('2026-08-08T12:00:00.000Z'),
    bannedBy: 'Admin',
    banReason: 'preserve this ban'
  });
  const clearAck = acknowledge();
  await clearSetup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'clear_timeout',
    reason: 'documented clear reason'
  }, clearAck.callback);
  assert.deepEqual(clearAck.value(), { success: true });
  assert.deepEqual({
    timeoutUntil: clearSetup.RoomRestrictionModel.rows[0].timeoutUntil,
    timeoutBy: clearSetup.RoomRestrictionModel.rows[0].timeoutBy,
    timeoutReason: clearSetup.RoomRestrictionModel.rows[0].timeoutReason
  }, { timeoutUntil: null, timeoutBy: null, timeoutReason: null });
  assert.equal(clearSetup.RoomRestrictionModel.rows[0].banReason, 'preserve this ban');

  const unbanSetup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'unban' });
  Object.assign(unbanSetup.RoomRestrictionModel.rows[0], {
    timeoutUntil: new Date(Date.now() + 60_000),
    timeoutBy: 'Admin',
    timeoutReason: 'preserve this timeout'
  });
  unbanSetup.UserModel.rows[1].servers = ['global', 'XYZ789'];
  unbanSetup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators = ['RoomMod', 'ABCMod'];
  const unbanAck = acknowledge();
  await unbanSetup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'targetuser', action: 'unban',
    reason: 'documented unban reason'
  }, unbanAck.callback);
  assert.deepEqual(unbanAck.value(), { success: true });
  assert.deepEqual({
    bannedAt: unbanSetup.RoomRestrictionModel.rows[0].bannedAt,
    bannedBy: unbanSetup.RoomRestrictionModel.rows[0].bannedBy,
    banReason: unbanSetup.RoomRestrictionModel.rows[0].banReason
  }, { bannedAt: null, bannedBy: null, banReason: null });
  assert.equal(unbanSetup.RoomRestrictionModel.rows[0].timeoutReason, 'preserve this timeout');
  assert.deepEqual(unbanSetup.UserModel.rows[1].servers, ['global', 'XYZ789']);
  assert.deepEqual(unbanSetup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators, ['RoomMod', 'ABCMod']);
});

test('ban then unban cannot revive a superseded timeout or restore membership', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'ban' });
  setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'targetuser', {
    timeoutUntil: new Date(Date.now() + 60_000),
    timeoutBy: 'RoomMod',
    timeoutReason: 'must stay cleared'
  }));
  const banAck = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'ban', reason: 'documented ban'
  }, banAck.callback);
  const unbanAck = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'targetuser', action: 'unban', reason: 'documented unban'
  }, unbanAck.callback);

  assert.deepEqual(banAck.value(), { success: true });
  assert.deepEqual(unbanAck.value(), { success: true });
  assert.equal(setup.RoomRestrictionModel.rows[0].bannedAt, null);
  assert.equal(setup.RoomRestrictionModel.rows[0].timeoutUntil, null);
  assert.equal(activeRestrictionState(setup.RoomRestrictionModel.rows[0]).timedOut, false);
  assert.deepEqual(setup.UserModel.rows[1].servers, ['global', 'XYZ789']);
});

for (const scenario of [
  { name: 'private kick requires current membership', action: 'kick', mutate(setup) { setup.UserModel.rows[1].servers = ['global', 'XYZ789']; } },
  { name: 'timeout requires current membership', action: 'timeout', mutate(setup) { setup.UserModel.rows[1].servers = ['global', 'XYZ789']; } },
  { name: 'first-time ban requires current membership', action: 'ban', mutate(setup) { setup.UserModel.rows[1].servers = ['global', 'XYZ789']; } },
  { name: 'timeout rejects an active ban', action: 'timeout', mutate(setup) { setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'targetuser', { bannedAt: new Date() })); } },
  { name: 'ban rejects an already-active ban', action: 'ban', mutate(setup) { setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'targetuser', { bannedAt: new Date() })); } },
  { name: 'clear_timeout requires an active timeout', action: 'clear_timeout', mutate(setup) { setup.RoomRestrictionModel.rows.length = 0; } },
  { name: 'unban requires an active ban', action: 'unban', mutate(setup) { setup.RoomRestrictionModel.rows.length = 0; } }
]) {
  test(`${scenario.name} and returns a generic state error`, async () => {
    const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: scenario.action });
    scenario.mutate(setup);
    const before = JSON.parse(JSON.stringify({
      user: setup.UserModel.rows[1],
      room: setup.ChatServerModel.rows.find(room => room.code === 'ABC123'),
      restrictions: setup.RoomRestrictionModel.rows
    }));
    const ack = acknowledge();
    await setup.socket.trigger('moderate_user', {
      serverCode: 'ABC123', targetUser: 'TargetUser', action: scenario.action,
      duration: scenario.action === 'timeout' ? '10m' : undefined,
      reason: 'documented invalid-state reason'
    }, ack.callback);
    assert.deepEqual(ack.value(), { error: 'Permission denied.' });
    assert.deepEqual(JSON.parse(JSON.stringify({
      user: setup.UserModel.rows[1],
      room: setup.ChatServerModel.rows.find(room => room.code === 'ABC123'),
      restrictions: setup.RoomRestrictionModel.rows
    })), before);
    assert.equal(setup.ModerationAuditModel.rows.length, 0);
  });
}

for (const actorState of ['nonmember', 'banned', 'timed out']) {
  test(`room moderator cannot moderate after becoming a current ${actorState}`, async () => {
    const setup = moderationScenario({ room: 'ABC123', actor: 'mod', action: 'kick' });
    const actor = setup.UserModel.rows.find(user => user.username === 'RoomMod');
    if (actorState === 'nonmember') actor.servers = ['global', 'XYZ789'];
    if (actorState === 'banned') {
      setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'roommod', {
        bannedAt: new Date(), bannedBy: 'Admin', banReason: 'active actor ban'
      }));
    }
    if (actorState === 'timed out') {
      setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'roommod', {
        timeoutUntil: new Date(Date.now() + 60_000),
        timeoutBy: 'Admin', timeoutReason: 'active actor timeout'
      }));
    }
    const ack = acknowledge();
    await setup.socket.trigger('moderate_user', {
      serverCode: 'ABC123', targetUser: 'TargetUser', action: 'kick',
      reason: 'must be rejected from stale authority'
    }, ack.callback);
    assert.deepEqual(ack.value(), { error: 'Permission denied.' });
    assert.deepEqual(setup.UserModel.rows.find(user => user.username === 'TargetUser').servers, [
      'global', 'ABC123', 'XYZ789'
    ]);
    assert.equal(setup.ModerationAuditModel.rows.length, 0);
  });
}

for (const failureStage of ['leave', 'join', 'disconnect']) {
  test(`failed ${failureStage} during eviction quarantines stale target identity and map access`, async () => {
    const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'ban' });
    const targetSocket = connectAdditionalSocket(setup, {
      id: `target-failed-${failureStage}`, username: 'TargetUser', serverCode: 'ABC123',
      joinedServers: ['global', 'ABC123', 'XYZ789']
    });
    const originalLeave = targetSocket.leave.bind(targetSocket);
    const originalJoin = targetSocket.join.bind(targetSocket);
    let leaveCalls = 0;
    targetSocket.leave = code => {
      leaveCalls += 1;
      if ((failureStage === 'leave' || failureStage === 'disconnect') && leaveCalls === 1) {
        return Promise.reject(new Error('transport leave rejected'));
      }
      return originalLeave(code);
    };
    targetSocket.join = code => {
      originalJoin(code);
      if (failureStage === 'join') return Promise.reject(new Error('transport join rejected'));
    };
    if (failureStage === 'disconnect') {
      targetSocket.disconnect = () => Promise.reject(new Error('transport disconnect rejected'));
    }
    const ack = acknowledge();
    await setup.socket.trigger('moderate_user', {
      serverCode: 'ABC123', targetUser: 'TargetUser', action: 'ban',
      reason: 'documented transport-failure reason'
    }, ack.callback);

    assert.deepEqual(ack.value(), { success: true });
    assert.equal(targetSocket.username, null);
    assert.equal(targetSocket.serverCode, null);
    assert.deepEqual(targetSocket.joinedServers, []);
    assert.equal(setup.onlineUsersMap.has(targetSocket.id), false);
    assert.equal(targetSocket.joinedServers.includes('ABC123'), false);
    assert.equal(targetSocket.joinedRooms.has('ABC123'), false);
    assert.equal(targetSocket.joinedRooms.has('global'), false);
    if (failureStage !== 'disconnect') assert.equal(targetSocket.disconnected, true);
    assert.deepEqual(setup.ModerationAuditModel.rows[0].metadata, {
      transportSynchronized: false,
      removedRoom: 'ABC123',
      fallbackCode: 'global'
    });
  });
}

test('audit retry treats first-write-committed response loss as one successful append', async () => {
  const rows = [];
  let attempts = 0;
  const ModerationAuditModel = {
    rows,
    async create(entry) {
      attempts += 1;
      if (rows.some(row => row.correlationId === entry.correlationId)) {
        const duplicate = new Error('duplicate');
        duplicate.code = 11000;
        throw duplicate;
      }
      rows.push({ ...entry });
      throw new Error('response lost after commit');
    }
  };
  const setup = moderationScenario({
    room: 'ABC123', actor: 'admin', action: 'timeout', ModerationAuditModel
  });
  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'timeout', duration: '10m',
    reason: 'audit retry reason'
  }, ack.callback);
  assert.deepEqual(ack.value(), { success: true });
  assert.equal(attempts, 2);
  assert.equal(rows.length, 1);
  assert.match(rows[0].correlationId, /^[0-9a-f]{24}$/);
});

test('audit snapshots pre-mutation room roles independently from global account roles', async () => {
  const globalSetup = moderationScenario({ room: 'global', actor: 'admin', action: 'timeout' });
  const timeoutAck = acknowledge();
  await globalSetup.socket.trigger('moderate_user', {
    serverCode: 'global', targetUser: 'TargetUser', action: 'timeout', duration: '10m',
    reason: 'documented audit role timeout'
  }, timeoutAck.callback);
  assert.deepEqual(timeoutAck.value(), { success: true });
  assert.equal(globalSetup.ModerationAuditModel.rows[0].actorRole, 'admin');
  assert.equal(globalSetup.ModerationAuditModel.rows[0].actorRoomRole, 'user');

  const privateSetup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'kick' });
  privateSetup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators.push('TargetUser');
  const kickAck = acknowledge();
  await privateSetup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'kick',
    reason: 'documented audit role kick'
  }, kickAck.callback);
  assert.deepEqual(kickAck.value(), { success: true });
  assert.equal(privateSetup.ModerationAuditModel.rows[0].actorRole, 'admin');
  assert.equal(privateSetup.ModerationAuditModel.rows[0].actorRoomRole, 'user');
  assert.equal(privateSetup.ModerationAuditModel.rows[0].targetRoomRole, 'mod');
});

test('audit double failure stays redacted, preserves notifications, and acknowledges enforced state', async () => {
  const logs = [];
  let attempts = 0;
  const ModerationAuditModel = {
    rows: [],
    async create() { attempts += 1; throw new Error('secret audit outage'); }
  };
  const setup = moderationScenario({
    room: 'ABC123', actor: 'admin', action: 'timeout', ModerationAuditModel,
    logger: { error(...args) { logs.push(args); } }
  });
  const targetSocket = connectAdditionalSocket(setup, {
    id: 'target-audit-failure', username: 'TargetUser', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const reason = 'never log this moderation reason';
  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'timeout', duration: '10m', reason
  }, ack.callback);
  assert.deepEqual(ack.value(), { success: true });
  assert.equal(attempts, 2);
  assert.equal(logs.length, 1);
  assert.equal(JSON.stringify(logs).includes('moderation_audit_write'), true);
  assert.equal(JSON.stringify(logs).includes(reason), false);
  assert.equal(JSON.stringify(logs).includes('secret audit outage'), false);
  assert.equal(targetSocket.outbound.some(item => item.event === 'room_restriction_updated'), true);
});

test('retrying an already-applied client ban returns generic error without duplicate state or audit', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'ban' });
  const firstAck = acknowledge();
  const secondAck = acknowledge();
  const request = {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'ban', reason: 'documented ban'
  };
  await setup.socket.trigger('moderate_user', request, firstAck.callback);
  await setup.socket.trigger('moderate_user', request, secondAck.callback);
  assert.deepEqual(firstAck.value(), { success: true });
  assert.deepEqual(secondAck.value(), { error: 'Permission denied.' });
  assert.equal(setup.RoomRestrictionModel.rows.length, 1);
  assert.equal(setup.ModerationAuditModel.rows.length, 1);
});

test('ordinary room notification for removal exposes no actor target or reason', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'kick' });
  const reason = 'sensitive documented reason';
  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'kick', reason
  }, ack.callback);
  const notices = setup.ioInstance.outbound.filter(item => item.room === 'ABC123' && item.event === 'system_message');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].payload, 'A member was removed by moderation.');
  assert.equal(JSON.stringify(notices).includes('Admin'), false);
  assert.equal(JSON.stringify(notices).includes('TargetUser'), false);
  assert.equal(JSON.stringify(notices).includes(reason), false);
});

test('unban refreshes target restriction snapshots and rebroadcasts room presence', async () => {
  const broadcasts = [];
  const setup = moderationScenario({
    room: 'ABC123', actor: 'admin', action: 'unban',
    broadcastOnlineUsersFn: code => broadcasts.push(code)
  });
  setup.UserModel.rows[1].servers = ['global', 'ABC123', 'XYZ789'];
  const targetSocket = connectAdditionalSocket(setup, {
    id: 'target-unban', username: 'TargetUser', serverCode: 'XYZ789',
    joinedServers: ['global', 'XYZ789'], bannedRooms: ['ABC123']
  });
  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'unban',
    reason: 'documented unban'
  }, ack.callback);
  assert.deepEqual(ack.value(), { success: true });
  assert.deepEqual(targetSocket.bannedRooms, []);
  assert.deepEqual(setup.onlineUsersMap.get(targetSocket.id).bannedRooms, []);
  assert.equal(targetSocket.outbound.some(item => item.event === 'room_restriction_updated' && item.payload.banned === false), true);
  assert.equal(broadcasts.includes('ABC123'), true);
});

for (const action of ['timeout', 'ban']) {
  test(`Global Chat ${action} blocks only Global Chat and preserves private-room interaction`, async () => {
    const setup = moderationScenario({ room: 'global', actor: 'admin', action });
    const targetSocket = connectAdditionalSocket(setup, {
      id: `target-global-${action}`, username: 'TargetUser', serverCode: 'global',
      joinedServers: ['global', 'ABC123', 'XYZ789']
    });
    const ack = acknowledge();
    await setup.socket.trigger('moderate_user', {
      serverCode: 'global', targetUser: 'TargetUser', action,
      duration: action === 'timeout' ? '10m' : undefined,
      reason: `documented global ${action}`
    }, ack.callback);
    assert.deepEqual(ack.value(), { success: true });

    if (action === 'timeout') {
      await targetSocket.trigger('chat_message', { text: 'must not publish in Global' });
      assert.equal(setup.MessageModel.created.length, 0);
      const switchAck = acknowledge();
      await targetSocket.trigger('switch_server', 'ABC123', switchAck.callback);
      assert.equal(Boolean(switchAck.value().error), false);
    } else {
      assert.equal(targetSocket.joinedRooms.has('global'), false);
    }
    assert.equal(targetSocket.serverCode, 'ABC123');
    await targetSocket.trigger('typing', true);
    assert.equal(targetSocket.outbound.some(item =>
      item.target === 'self' && item.event === 'typing' && item.payload.isTyping === true
    ), true);
  });
}

for (const racedAction of ['switch', 'join', 'message publication']) {
  test(`Ban racing ${racedAction} leaves no forbidden transport membership or emitted message`, async () => {
    const writeStarted = deferred();
    const releaseWrite = deferred();
    const restrictions = createMemoryModel([]);
    const baseUpsert = restrictions.findOneAndUpdate.bind(restrictions);
    let held = false;
    restrictions.findOneAndUpdate = async (...args) => {
      if (!held) {
        held = true;
        writeStarted.resolve();
        await releaseWrite.promise;
      }
      return baseUpsert(...args);
    };
    const setup = moderationScenario({
      room: 'ABC123', actor: 'admin', action: 'ban', RoomRestrictionModel: restrictions
    });
    const initialRoom = racedAction === 'message publication' ? 'ABC123' : 'global';
    const targetSocket = connectAdditionalSocket(setup, {
      id: `target-race-${racedAction.replaceAll(' ', '-')}`,
      username: 'TargetUser', serverCode: initialRoom,
      joinedServers: ['global', 'ABC123', 'XYZ789']
    });
    const banAck = acknowledge();
    const banPending = setup.socket.trigger('moderate_user', {
      serverCode: 'ABC123', targetUser: 'TargetUser', action: 'ban', reason: 'documented race ban'
    }, banAck.callback);
    await writeStarted.promise;

    let racedPending;
    let racedAck;
    if (racedAction === 'message publication') {
      racedPending = targetSocket.trigger('chat_message', { text: 'must never publish' });
    } else {
      racedAck = acknowledge();
      racedPending = targetSocket.trigger(
        racedAction === 'switch' ? 'switch_server' : 'join_server',
        'ABC123', racedAck.callback
      );
    }
    await new Promise(resolve => setImmediate(resolve));
    releaseWrite.resolve();
    await Promise.all([banPending, racedPending]);

    assert.deepEqual(banAck.value(), { success: true });
    assert.equal(targetSocket.joinedRooms.has('ABC123'), false);
    assert.equal(targetSocket.joinedServers.includes('ABC123'), false);
    assert.equal(setup.onlineUsersMap.get(targetSocket.id).joinedServers.includes('ABC123'), false);
    assert.equal(setup.ioInstance.outbound.some(item => item.room === 'ABC123' && item.event === 'chat_message'), false);
    if (racedAck) assert.deepEqual(racedAck.value(), { error: 'Permission denied.' });
  });
}

test('target leave that wins the account lock makes a racing first-time ban fail on canonical membership', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'ban' });
  const targetSocket = connectAdditionalSocket(setup, {
    id: 'target-leave-race', username: 'TargetUser', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const saveStarted = deferred();
  const releaseSave = deferred();
  const baseFindOne = setup.UserModel.findOne.bind(setup.UserModel);
  let held = false;
  setup.UserModel.findOne = async query => {
    const document = await baseFindOne(query);
    if (document && document.username === 'TargetUser' && !held) {
      const baseSave = document.save.bind(document);
      return {
        ...document,
        markModified() {},
        async save() {
          held = true;
          saveStarted.resolve();
          await releaseSave.promise;
          const values = { ...this };
          delete values.save;
          delete values.markModified;
          Object.assign(document, values);
          return baseSave();
        }
      };
    }
    return document;
  };
  const leaveAck = acknowledge();
  const leavePending = targetSocket.trigger('leave_server', 'ABC123', leaveAck.callback);
  await saveStarted.promise;
  const banAck = acknowledge();
  const banPending = setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'ban', reason: 'documented race ban'
  }, banAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(banAck.value(), undefined);
  releaseSave.resolve();
  await Promise.all([leavePending, banPending]);
  assert.deepEqual(leaveAck.value(), { success: true });
  assert.deepEqual(banAck.value(), { error: 'Permission denied.' });
  assert.deepEqual(setup.UserModel.rows[1].servers, ['global', 'XYZ789']);
  assert.equal(setup.RoomRestrictionModel.rows.length, 0);
});

test('actor room demotion that wins the account lock makes later moderation fail', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'mod', action: 'kick' });
  setup.UserModel.rows.push(userDocument({
    username: 'SecondAdmin', displayName: 'SecondAdmin', role: 'admin',
    servers: ['global', 'ABC123', 'XYZ789']
  }));
  const administrator = connectAdditionalSocket(setup, {
    id: 'room-demoter', username: 'SecondAdmin', serverCode: 'ABC123', role: 'admin',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const saveStarted = deferred();
  const releaseSave = deferred();
  const baseFindOne = setup.ChatServerModel.findOne.bind(setup.ChatServerModel);
  let held = false;
  setup.ChatServerModel.findOne = async query => {
    const room = await baseFindOne(query);
    if (room && room.code === 'ABC123' && !held) {
      const baseSave = room.save.bind(room);
      return {
        ...room,
        markModified() {},
        async save() {
          held = true;
          saveStarted.resolve();
          await releaseSave.promise;
          const values = { ...this };
          delete values.save;
          delete values.markModified;
          Object.assign(room, values);
          return baseSave();
        }
      };
    }
    return room;
  };
  const demoteAck = acknowledge();
  const demotePending = administrator.trigger('manage_role', {
    targetUser: 'RoomMod', action: 'demote_mod', serverCode: 'ABC123'
  }, demoteAck.callback);
  await saveStarted.promise;
  const moderationAck = acknowledge();
  const moderationPending = setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'kick', reason: 'documented race moderation'
  }, moderationAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(moderationAck.value(), undefined);
  releaseSave.resolve();
  await Promise.all([demotePending, moderationPending]);
  assert.deepEqual(demoteAck.value(), { success: true });
  assert.deepEqual(moderationAck.value(), { error: 'Permission denied.' });
});

test('actor global demotion that wins the account lock makes later moderation fail', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'kick' });
  setup.UserModel.rows.push(userDocument({
    username: 'SecondAdmin', displayName: 'SecondAdmin', role: 'admin',
    servers: ['global', 'ABC123', 'XYZ789']
  }));
  const administrator = connectAdditionalSocket(setup, {
    id: 'global-demoter', username: 'SecondAdmin', serverCode: 'global', role: 'admin',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const saveStarted = deferred();
  const releaseSave = deferred();
  const baseFindOne = setup.UserModel.findOne.bind(setup.UserModel);
  let held = false;
  setup.UserModel.findOne = async query => {
    const user = await baseFindOne(query);
    if (user && user.username === 'Admin' && !held) {
      const baseSave = user.save.bind(user);
      return {
        ...user,
        markModified() {},
        async save() {
          held = true;
          saveStarted.resolve();
          await releaseSave.promise;
          const values = { ...this };
          delete values.save;
          delete values.markModified;
          Object.assign(user, values);
          return baseSave();
        }
      };
    }
    return user;
  };
  const demoteAck = acknowledge();
  const demotePending = administrator.trigger('manage_role', {
    targetUser: 'Admin', action: 'demote_global_admin'
  }, demoteAck.callback);
  await saveStarted.promise;
  const moderationAck = acknowledge();
  const moderationPending = setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'kick', reason: 'documented race moderation'
  }, moderationAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(moderationAck.value(), undefined);
  releaseSave.resolve();
  await Promise.all([demotePending, moderationPending]);
  assert.deepEqual(demoteAck.value(), { success: true });
  assert.deepEqual(moderationAck.value(), { error: 'Permission denied.' });
});

test('target promotion that wins the account lock protects the target from a later ban', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'ban' });
  setup.UserModel.rows.push(userDocument({
    username: 'SecondAdmin', displayName: 'SecondAdmin', role: 'admin',
    servers: ['global', 'ABC123', 'XYZ789']
  }));
  const administrator = connectAdditionalSocket(setup, {
    id: 'target-promoter', username: 'SecondAdmin', serverCode: 'global', role: 'admin',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const saveStarted = deferred();
  const releaseSave = deferred();
  const baseFindOne = setup.UserModel.findOne.bind(setup.UserModel);
  let held = false;
  setup.UserModel.findOne = async query => {
    const user = await baseFindOne(query);
    if (user && user.username === 'TargetUser' && !held) {
      const baseSave = user.save.bind(user);
      return {
        ...user,
        markModified() {},
        async save() {
          held = true;
          saveStarted.resolve();
          await releaseSave.promise;
          const values = { ...this };
          delete values.save;
          delete values.markModified;
          Object.assign(user, values);
          return baseSave();
        }
      };
    }
    return user;
  };
  const promoteAck = acknowledge();
  const promotePending = administrator.trigger('manage_role', {
    targetUser: 'TargetUser', action: 'promote_global_admin'
  }, promoteAck.callback);
  await saveStarted.promise;
  const banAck = acknowledge();
  const banPending = setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'ban', reason: 'documented race ban'
  }, banAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(banAck.value(), undefined);
  releaseSave.resolve();
  await Promise.all([promotePending, banPending]);
  assert.deepEqual(promoteAck.value(), { success: true });
  assert.deepEqual(banAck.value(), { error: 'Permission denied.' });
  assert.equal(setup.RoomRestrictionModel.rows.length, 0);
});

for (const transition of ['demotion', 'promotion']) {
  test(`target room ${transition} that wins the account lock controls a later room-mod ban`, async () => {
    const setup = moderationScenario({ room: 'ABC123', actor: 'mod', action: 'ban' });
    setup.UserModel.rows.push(userDocument({
      username: 'SecondAdmin', displayName: 'SecondAdmin', role: 'admin',
      servers: ['global', 'ABC123', 'XYZ789']
    }));
    const roomRow = setup.ChatServerModel.rows.find(room => room.code === 'ABC123');
    if (transition === 'demotion') roomRow.moderators.push('TargetUser');
    const administrator = connectAdditionalSocket(setup, {
      id: `target-room-${transition}`, username: 'SecondAdmin', serverCode: 'ABC123', role: 'admin',
      joinedServers: ['global', 'ABC123', 'XYZ789']
    });
    const saveStarted = deferred();
    const releaseSave = deferred();
    const baseFindOne = setup.ChatServerModel.findOne.bind(setup.ChatServerModel);
    let held = false;
    setup.ChatServerModel.findOne = async query => {
      const room = await baseFindOne(query);
      if (room && room.code === 'ABC123' && !held) {
        const baseSave = room.save.bind(room);
        return {
          ...room,
          markModified() {},
          async save() {
            held = true;
            saveStarted.resolve();
            await releaseSave.promise;
            const values = { ...this };
            delete values.save;
            delete values.markModified;
            Object.assign(room, values);
            return baseSave();
          }
        };
      }
      return room;
    };
    const roleAck = acknowledge();
    const rolePending = administrator.trigger('manage_role', {
      targetUser: 'TargetUser',
      action: transition === 'demotion' ? 'demote_mod' : 'promote_mod',
      serverCode: 'ABC123'
    }, roleAck.callback);
    await saveStarted.promise;
    const banAck = acknowledge();
    const banPending = setup.socket.trigger('moderate_user', {
      serverCode: 'ABC123', targetUser: 'TargetUser', action: 'ban', reason: 'documented room-role race'
    }, banAck.callback);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(banAck.value(), undefined);
    releaseSave.resolve();
    await Promise.all([rolePending, banPending]);

    assert.deepEqual(roleAck.value(), { success: true });
    assert.deepEqual(
      banAck.value(),
      transition === 'demotion' ? { success: true } : { error: 'Permission denied.' }
    );
    assert.equal(setup.RoomRestrictionModel.rows.length, transition === 'demotion' ? 1 : 0);
  });
}

test('absence-period messages never become unread after leave kick ban rejoin or restored Global access', async () => {
  const newestAt = new Date('2026-08-10T13:00:00.000Z');
  const newestId = '507f1f77bcf86cd799439071';

  for (const scenario of [
    { name: 'join', initialState: [], expectedVersion: 0 },
    {
      name: 'rejoin after leave from an initially empty room',
      initialState: [{
        usernameKey: 'alice', serverCode: 'ABC123', notificationLevel: 'none',
        lastReadAt: null, lastReadMessageId: null, version: 0
      }],
      expectedVersion: 1
    },
    {
      name: 'rejoin after kick',
      initialState: [{
        usernameKey: 'alice', serverCode: 'ABC123', notificationLevel: 'none',
        lastReadAt: new Date('2026-08-10T12:00:00.000Z'),
        lastReadMessageId: '507f1f77bcf86cd799439070', version: 4
      }],
      expectedVersion: 5
    },
    {
      name: 'rejoin after ban and later unban',
      initialState: [{
        usernameKey: 'alice', serverCode: 'ABC123', notificationLevel: 'mentions',
        lastReadAt: new Date('2026-08-10T12:00:00.000Z'),
        lastReadMessageId: '507f1f77bcf86cd799439070', version: 6
      }],
      expectedVersion: 7
    }
  ]) {
    const RoomMemberStateModel = createMemoryModel(scenario.initialState);
    const persisted = { username: 'Alice', displayName: 'Alice', role: 'user', servers: ['global'] };
    const UserModel = {
      async findOne() {
        const document = { ...persisted, servers: [...persisted.servers] };
        document.save = async () => {
          const state = RoomMemberStateModel.rows.find(row =>
            row.usernameKey === 'alice' && row.serverCode === 'ABC123'
          );
          assert.equal(state.lastReadAt.getTime(), newestAt.getTime(), `${scenario.name} cursor before save`);
          assert.equal(state.lastReadMessageId, newestId, `${scenario.name} id before save`);
          assert.equal(state.version, scenario.expectedVersion, `${scenario.name} version before save`);
          Object.assign(persisted, document, { servers: [...document.servers] });
        };
        return document;
      }
    };
    const MessageModel = createMemoryModel([{
      _id: newestId, serverCode: 'ABC123', username: 'Other', authorKey: 'other',
      notificationMentions: ['alice'], timestamp: newestAt
    }]);
    preserveAttentionProjection(MessageModel);
    const setup = registerWithModels({
      UserModel,
      ChatServerModel: createMemoryModel([
        roomDocument('global'), roomDocument('ABC123')
      ]),
      MessageModel,
      RoomMemberStateModel
    });
    Object.assign(setup.socket, {
      username: 'Alice', displayName: 'Alice', role: 'user', serverCode: 'global',
      joinedServers: ['global'], bannedRooms: []
    });
    setup.onlineUsersMap.set(setup.socket.id, {
      username: 'Alice', displayName: 'Alice', role: 'user', serverCode: 'global',
      joinedServers: ['global'], bannedRooms: []
    });
    const ack = acknowledge();
    await setup.socket.trigger('join_server', 'ABC123', ack.callback);
    assert.equal(ack.value().success, true, scenario.name);
    MessageModel.rows.push({
      _id: '507f1f77bcf86cd799439073', serverCode: 'ABC123', username: 'Other', authorKey: 'other',
      notificationMentions: ['alice'], timestamp: new Date('2026-08-10T13:01:00.000Z')
    });
    const notificationAck = acknowledge();
    await setup.socket.trigger('update_room_notification', {
      serverCode: 'ABC123', level: scenario.initialState[0]?.notificationLevel || 'all'
    }, notificationAck.callback);
    assert.equal(notificationAck.value().unreadCount, 1, `${scenario.name} post-grant unread`);
    assert.equal(notificationAck.value().mentionCount, 1, `${scenario.name} post-grant mention`);
  }

  const RoomMemberStateModel = createMemoryModel([{
    usernameKey: 'targetuser', serverCode: 'global', notificationLevel: 'mentions',
    lastReadAt: new Date('2026-08-10T12:00:00.000Z'),
    lastReadMessageId: '507f1f77bcf86cd799439072', version: 8
  }]);
  const restrictions = createMemoryModel([restrictionDocument('global', 'TargetUser', {
    bannedAt: new Date('2026-08-10T12:30:00.000Z'), bannedBy: 'Admin', banReason: 'existing ban'
  })]);
  const originalUpdate = restrictions.findOneAndUpdate.bind(restrictions);
  restrictions.findOneAndUpdate = (query, update, options) => {
    const state = RoomMemberStateModel.rows[0];
    assert.equal(state.lastReadAt.getTime(), newestAt.getTime());
    assert.equal(state.lastReadMessageId, newestId);
    assert.equal(state.version, 9);
    return originalUpdate(query, update, options);
  };
  const restoreSetup = registerWithModels({
    users: [
      userDocument({ username: 'Admin', role: 'admin', servers: ['global'] }),
      userDocument({ username: 'TargetUser', servers: ['global'] })
    ],
    rooms: [roomDocument('global')],
    MessageModel: createMemoryModel([{ _id: newestId, serverCode: 'global', timestamp: newestAt }]),
    RoomRestrictionModel: restrictions,
    RoomMemberStateModel
  });
  Object.assign(restoreSetup.socket, {
    username: 'Admin', displayName: 'Admin', role: 'admin', serverCode: 'global',
    joinedServers: ['global'], bannedRooms: []
  });
  const restoreAck = acknowledge();
  await restoreSetup.socket.trigger('moderate_user', {
    serverCode: 'global', targetUser: 'TargetUser', action: 'unban', reason: 'restore access'
  }, restoreAck.callback);
  assert.deepEqual(restoreAck.value(), { success: true });
});

test('a failed membership or access grant leaves only a harmless early cursor advance', async () => {
  const newestAt = new Date('2026-08-10T14:00:00.000Z');
  const newestId = '507f1f77bcf86cd799439081';
  const failedJoinState = createMemoryModel([]);
  const failedJoin = registerWithModels({
    UserModel: {
      async findOne() {
        return {
          username: 'Alice', displayName: 'Alice', role: 'user', servers: ['global'],
          async save() { throw new Error('membership write failed'); }
        };
      }
    },
    ChatServerModel: createMemoryModel([roomDocument('global'), roomDocument('ABC123')]),
    MessageModel: createMemoryModel([{ _id: newestId, serverCode: 'ABC123', timestamp: newestAt }]),
    RoomMemberStateModel: failedJoinState,
    logger: { error() {} }
  });
  Object.assign(failedJoin.socket, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: 'global',
    joinedServers: ['global'], bannedRooms: []
  });
  const joinAck = acknowledge();
  await failedJoin.socket.trigger('join_server', 'ABC123', joinAck.callback);
  assert.deepEqual(joinAck.value(), { error: 'Join failed.' });
  assert.deepEqual(failedJoinState.rows.map(row => ({
    usernameKey: row.usernameKey, serverCode: row.serverCode, notificationLevel: row.notificationLevel,
    lastReadAt: row.lastReadAt, lastReadMessageId: row.lastReadMessageId, version: row.version
  })), [{
    usernameKey: 'alice', serverCode: 'ABC123', notificationLevel: 'all',
    lastReadAt: newestAt, lastReadMessageId: newestId, version: 0
  }]);

  const failedRestoreState = createMemoryModel([{
    usernameKey: 'targetuser', serverCode: 'global', notificationLevel: 'all',
    lastReadAt: new Date('2026-08-10T13:00:00.000Z'),
    lastReadMessageId: '507f1f77bcf86cd799439080', version: 2
  }]);
  const failedRestrictions = createMemoryModel([restrictionDocument('global', 'TargetUser', {
    bannedAt: new Date('2026-08-10T13:30:00.000Z'), bannedBy: 'Admin', banReason: 'existing ban'
  })]);
  failedRestrictions.findOneAndUpdate = async () => { throw new Error('unban write failed'); };
  const failedRestore = registerWithModels({
    users: [
      userDocument({ username: 'Admin', role: 'admin', servers: ['global'] }),
      userDocument({ username: 'TargetUser', servers: ['global'] })
    ],
    rooms: [roomDocument('global')],
    MessageModel: createMemoryModel([{ _id: newestId, serverCode: 'global', timestamp: newestAt }]),
    RoomRestrictionModel: failedRestrictions,
    RoomMemberStateModel: failedRestoreState,
    logger: { error() {} }
  });
  const cursorMutationSessions = [];
  const baseStateUpdate = failedRestore.RoomMemberStateModel.findOneAndUpdate
    .bind(failedRestore.RoomMemberStateModel);
  failedRestore.RoomMemberStateModel.findOneAndUpdate = (query, update, options = {}) => {
    cursorMutationSessions.push(options.session || null);
    return baseStateUpdate(query, update, options);
  };
  const rollbackSession = { id: 'rollback-session' };
  const sharedConnection = {
    async transaction(operation) {
      return operation(rollbackSession);
    }
  };
  failedRestore.UserModel.db = sharedConnection;
  failedRestore.ChatServerModel.db = sharedConnection;
  failedRestore.RoomRestrictionModel.db = sharedConnection;
  Object.assign(failedRestore.socket, {
    username: 'Admin', displayName: 'Admin', role: 'admin', serverCode: 'global',
    joinedServers: ['global'], bannedRooms: []
  });
  const restoreAck = acknowledge();
  await failedRestore.socket.trigger('moderate_user', {
    serverCode: 'global', targetUser: 'TargetUser', action: 'unban', reason: 'restore access'
  }, restoreAck.callback);
  assert.deepEqual(restoreAck.value(), { error: 'Moderation failed.' });
  assert.equal(failedRestoreState.rows[0].lastReadAt.getTime(), newestAt.getTime());
  assert.equal(failedRestoreState.rows[0].lastReadMessageId, newestId);
  assert.equal(failedRestoreState.rows[0].version, 3);
  assert.deepEqual(cursorMutationSessions, [null], 'early cursor write is outside the failed grant transaction');
  assert.notEqual(failedRestrictions.rows[0].bannedAt, null);
  assert.equal(failedRestore.ModerationAuditModel.rows.length, 0);
});

test('complete attention policy matrix covers levels blocks memberships restrictions sessions and reconnects', async () => {
  const cursorAt = new Date('2026-08-10T12:00:00.000Z');
  const cursorId = '507f1f77bcf86cd799439091';
  const newerId = '507f1f77bcf86cd799439092';
  const names = ['AllUser', 'MentionsUser', 'NoneUser', 'BlockedUser', 'TimedUser', 'BannedUser'];
  const RoomMemberStateModel = createMemoryModel(names.map((username, index) => ({
    _id: (200 + index).toString(16).padStart(24, '0'),
    usernameKey: username.toLowerCase(), serverCode: 'ABC123',
    notificationLevel: username === 'MentionsUser' ? 'mentions' : (username === 'NoneUser' ? 'none' : 'all'),
    lastReadAt: cursorAt, lastReadMessageId: cursorId, version: 0
  })));
  const setup = registerWithModels({
    users: [
      ...names.map(username => userDocument({ username, displayName: username, password: 'hash', servers: ['global', 'ABC123'] })),
      userDocument({ username: 'GhostAdmin', displayName: 'GhostAdmin', password: 'hash', role: 'admin', servers: ['global'] })
    ],
    rooms: [roomDocument('global'), roomDocument('ABC123')],
    messages: [
      {
        _id: cursorId, serverCode: 'ABC123', username: 'Author', authorKey: 'author',
        notificationMentions: [], timestamp: cursorAt
      },
      {
        _id: newerId, serverCode: 'ABC123', username: 'Author', authorKey: 'author',
        notificationMentions: ['*'], timestamp: new Date('2026-08-10T12:01:00.000Z')
      }
    ],
    restrictions: [
      restrictionDocument('ABC123', 'TimedUser', { timeoutUntil: new Date(Date.now() + 60_000) }),
      restrictionDocument('ABC123', 'BannedUser', { bannedAt: new Date() })
    ],
    roomStates: RoomMemberStateModel.rows,
    experienceStates: [{
      usernameKey: 'blockeduser',
      blockedUsers: [{ usernameKey: 'author', username: 'Author', createdAt: new Date() }],
      blockVersion: 3
    }]
  });
  preserveAttentionProjection(setup.MessageModel);
  const sockets = new Map();
  function attach(id, username, role = 'user', joinedServers = ['global', 'ABC123']) {
    const live = connectAdditionalSocket(setup, {
      id, username, role, serverCode: 'global', joinedServers
    });
    sockets.set(username, live);
    return live;
  }
  for (const username of names) attach(username.toLowerCase(), username);
  const secondAll = attach('all-second', 'AllUser');
  const ghost = attach('ghost', 'GhostAdmin', 'admin', ['global']);

  async function notification(live, level) {
    const ack = acknowledge();
    await live.trigger('update_room_notification', { serverCode: 'ABC123', level }, ack.callback);
    return ack.value();
  }

  for (const [username, level] of [
    ['MentionsUser', 'mentions'], ['NoneUser', 'none'], ['TimedUser', 'all']
  ]) {
    const state = await notification(sockets.get(username), level);
    assert.deepEqual({ unreadCount: state.unreadCount, mentionCount: state.mentionCount }, {
      unreadCount: 1, mentionCount: 1
    }, username);
  }
  const blocked = await notification(sockets.get('BlockedUser'), 'all');
  assert.deepEqual({
    unreadCount: blocked.unreadCount, mentionCount: blocked.mentionCount, blockVersion: blocked.blockVersion
  }, { unreadCount: 0, mentionCount: 0, blockVersion: 3 });
  assert.deepEqual(await notification(sockets.get('BannedUser'), 'all'), { error: 'Permission denied.' });
  assert.deepEqual(await notification(ghost, 'all'), { error: 'Permission denied.' });

  const synchronized = await notification(sockets.get('AllUser'), 'mentions');
  assert.deepEqual(secondAll.outbound.filter(item => item.event === 'room_notification_updated').at(-1).payload, synchronized);

  const reconnect = new FakeSocket();
  reconnect.id = 'all-reconnect';
  createConnectionHandler({
    ioInstance: setup.ioInstance,
    onlineUsersMap: setup.onlineUsersMap,
    UserModel: setup.UserModel,
    ChatServerModel: setup.ChatServerModel,
    MessageModel: setup.MessageModel,
    RoomRestrictionModel: setup.RoomRestrictionModel,
    ModerationAuditModel: setup.ModerationAuditModel,
    ModerationReportModel: setup.ModerationReportModel,
    RoomMemberStateModel: setup.RoomMemberStateModel,
    UserExperienceStateModel: setup.UserExperienceStateModel,
    bcryptImpl: { async compare() { return true; } },
    broadcastOnlineUsersFn: async () => {}, getRoomRoleFn: async () => 'user',
    resolvePingsFn: async text => text, logger: { error() {} }
  })(reconnect);
  setup.ioInstance.sockets.push(reconnect);
  const loginAck = acknowledge();
  await reconnect.trigger('login', { username: 'AllUser', password: '123456' }, loginAck.callback);
  const reconnectState = loginAck.value().roomStates.find(state => state.serverCode === 'ABC123');
  assert.equal(reconnectState.notificationLevel, 'mentions');
  assert.deepEqual({ unreadCount: reconnectState.unreadCount, mentionCount: reconnectState.mentionCount }, {
    unreadCount: 1, mentionCount: 1
  });
});

test('complete room experience backend policy matrix has no stale authority or content leak', async () => {
  const rooms = ['global', 'ABC123'];
  const actors = [
    { label: 'admin', username: 'Admin', role: 'admin', member: true },
    { label: 'owner', username: 'Owner', role: 'user', member: true },
    { label: 'exact-mod', username: 'ExactMod', role: 'user', member: true },
    { label: 'other-mod', username: 'OtherMod', role: 'user', member: true },
    { label: 'member', username: 'Member', role: 'user', member: true },
    { label: 'nonmember', username: 'Nonmember', role: 'user', member: false }
  ];
  const restrictions = [
    { label: 'active', banned: false, timedOut: false },
    { label: 'timeout', banned: false, timedOut: true },
    { label: 'banned', banned: true, timedOut: false }
  ];
  let cases = 0;

  for (const serverCode of rooms) {
    for (const actor of actors) {
      for (const restriction of restrictions) {
        for (const blocked of [false, true]) {
          const room = {
            code: serverCode,
            owner: 'Owner',
            moderators: serverCode === 'global' ? [] : ['ExactMod']
          };
          const active = restriction.label === 'active';
          const allowed = actor.member || actor.role === 'admin';
          const access = {
            allowed,
            user: { username: actor.username, role: actor.role },
            room,
            restriction: { banned: restriction.banned, timedOut: restriction.timedOut }
          };
          const privileged = actor.role === 'admin';
          const privateOwner = serverCode !== 'global' && actor.label === 'owner';
          const exactModerator = serverCode !== 'global' && actor.label === 'exact-mod';
          const prefix = `${serverCode}/${actor.label}/${restriction.label}/${blocked ? 'blocked' : 'unblocked'}`;

          assert.equal(
            canEditRoomDetails({ serverCode, access }),
            active && allowed && (privileged || privateOwner),
            `${prefix}: details`
          );
          assert.equal(
            canManagePins({ serverCode, access }),
            active && allowed && (privileged || privateOwner || exactModerator),
            `${prefix}: pins`
          );
          const canModerate = active && allowed && canModerateTarget({
            serverCode,
            action: 'ban',
            actorUser: access.user,
            targetUser: { username: 'Target', role: 'user' },
            room
          });
          assert.equal(
            canModerate,
            active && allowed && (privileged || exactModerator),
            `${prefix}: moderation`
          );

          const secret = `secret-${prefix}`;
          const safe = safeMessageForViewer({
            _id: VALID_MESSAGE_ID,
            serverCode,
            username: 'Author',
            authorKey: 'author',
            displayName: 'Secret Author',
            text: secret,
            attachment: `data:image/png;base64,${secret}`,
            replyTo: { id: VALID_MESSAGE_ID, text: secret },
            reactions: { 'eyes': ['Author'] },
            timestamp: new Date('2026-08-10T12:00:00.000Z')
          }, { blockedUserKeys: blocked ? new Set(['author']) : new Set() });
          if (blocked) {
            assert.deepEqual(Object.keys(safe).sort(), [
              '_id', 'authorKey', 'blocked', 'serverCode', 'timestamp', 'username'
            ]);
            assert.equal(JSON.stringify(safe).includes(secret), false, `${prefix}: blocked content`);
          } else {
            assert.equal(safe.text, secret, `${prefix}: visible content`);
            assert.notEqual(safe.blocked, true, `${prefix}: visible marker`);
          }
          cases += 1;
        }
      }
    }
  }
  assert.equal(cases, 72);
});

function sendTransitionFixture(kind, { gateCreate = false, gateTransitionWrite = false } = {}) {
  const sendCreateStarted = deferred();
  const releaseSendCreate = deferred();
  const transitionWriteStarted = deferred();
  const releaseTransitionWrite = deferred();
  const senderIsAdmin = kind === 'global demotion';
  const senderMemberships = senderIsAdmin ? ['global'] : ['global', 'ABC123'];
  const MessageModel = createMemoryModel([]);
  const persistMessage = MessageModel.create.bind(MessageModel);
  let reachedCreate = false;
  MessageModel.create = async value => {
    reachedCreate = true;
    sendCreateStarted.resolve();
    if (gateCreate) await releaseSendCreate.promise;
    return persistMessage({
      _id: '507f1f77bcf86cd799439088',
      timestamp: new Date('2026-08-10T14:00:00.000Z'),
      deleted: false,
      ...value
    });
  };

  const UserModel = createMemoryModel([
    userDocument({
      username: 'Alice', displayName: 'Alice', role: senderIsAdmin ? 'admin' : 'user',
      servers: senderMemberships
    }),
    userDocument({
      username: 'RootAdmin', displayName: 'Root Admin', role: 'admin',
      servers: ['global', 'ABC123']
    })
  ]);
  let transitionWriteGated = false;
  UserModel.saveHook = async ({ document }) => {
    const isTransitionWrite = document.username === 'Alice' &&
      ((kind === 'leave' && !document.servers.includes('ABC123')) ||
       (kind === 'global demotion' && document.role === 'user'));
    if (!gateTransitionWrite || transitionWriteGated || !isTransitionWrite) return;
    transitionWriteGated = true;
    transitionWriteStarted.resolve();
    await releaseTransitionWrite.promise;
  };

  const setup = registerWithModels({
    UserModel,
    MessageModel,
    rooms: [roomDocument('global', { owner: 'System' }), roomDocument('ABC123')]
  });
  Object.assign(setup.socket, {
    username: 'Alice',
    displayName: 'Alice',
    role: senderIsAdmin ? 'admin' : 'user',
    serverCode: 'ABC123',
    joinedServers: [...senderMemberships],
    bannedRooms: [],
    blockedUserKeys: new Set(),
    blockVersion: 0
  });
  setup.socket.joinedRooms.add('ABC123');
  setup.onlineUsersMap.set(setup.socket.id, {
    username: 'Alice',
    displayName: 'Alice',
    role: setup.socket.role,
    serverCode: 'ABC123',
    joinedServers: [...senderMemberships],
    bannedRooms: [],
    blockedUsers: [],
    blockVersion: 0
  });
  const administrator = connectAdditionalSocket(setup, {
    id: `root-${kind.replace(/\s+/g, '-')}`,
    username: 'RootAdmin',
    role: 'admin',
    serverCode: 'global',
    joinedServers: ['global', 'ABC123']
  });

  function startTransition(ack) {
    return kind === 'leave'
      ? setup.socket.trigger('leave_server', 'ABC123', ack.callback)
      : administrator.trigger('manage_role', {
        targetUser: 'Alice', action: 'demote_global_admin'
      }, ack.callback);
  }

  return {
    ...setup,
    administrator,
    sendCreateStarted,
    releaseSendCreate,
    transitionWriteStarted,
    releaseTransitionWrite,
    startTransition,
    reachedCreate: () => reachedCreate
  };
}

for (const kind of ['leave', 'global demotion']) {
  test(`chat message mutation wins before a concurrent ${kind} and commits before the transition`, async () => {
    const setup = sendTransitionFixture(kind, { gateCreate: true });
    const sendPending = setup.socket.trigger('chat_message', {
      serverCode: 'ABC123', clientContextId: 1, text: `message before ${kind}`
    });
    await setup.sendCreateStarted.promise;

    const transitionAck = acknowledge();
    const transitionPending = setup.startTransition(transitionAck);
    await new Promise(resolve => setImmediate(resolve));
    const transitionBeforeSendCommit = transitionAck.value();

    setup.releaseSendCreate.resolve();
    await Promise.all([sendPending, transitionPending]);

    assert.equal(transitionBeforeSendCommit, undefined);
    assert.deepEqual(transitionAck.value(), { success: true });
    assert.equal(setup.MessageModel.rows.length, 1);
  });

  test(`a ${kind} holding the actor account lock wins before a queued chat message`, async () => {
    const setup = sendTransitionFixture(kind, { gateTransitionWrite: true });
    const transitionAck = acknowledge();
    const transitionPending = setup.startTransition(transitionAck);
    await setup.transitionWriteStarted.promise;

    const sendPending = setup.socket.trigger('chat_message', {
      serverCode: 'ABC123', clientContextId: 1, text: `message after ${kind}`
    });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const reachedCreateBeforeTransitionCommit = setup.reachedCreate();

    setup.releaseTransitionWrite.resolve();
    await Promise.all([transitionPending, sendPending]);

    assert.deepEqual(transitionAck.value(), { success: true });
    assert.equal(reachedCreateBeforeTransitionCommit, false);
    assert.equal(setup.MessageModel.rows.length, 0);
  });
}

module.exports = {
  VALID_MESSAGE_ID,
  userDocument,
  roomDocument,
  restrictionDocument,
  registerWithModels,
  authenticatedRoomSocket,
  authenticatedLobbySocket,
  timedOutAuthenticatedSocket,
  moderationScenario,
  reportingScenario
};

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MODERATION_DURATIONS,
  normalizeModerationAction,
  normalizeModerationReason,
  normalizeAutoModSettings,
  normalizeAccountKey,
  createAutoModTracker,
  evaluateAutoMod,
  findUserByUsername,
  withAccountTransitionLocks,
  withAccountTransitionLock,
  canModerateTarget,
  activeRestrictionState,
  applySessionAccessSnapshot,
  rejectAuditMutation,
  ModerationReport,
  createConnectionHandler
} = require('../server');
const { FakeSocket, FakeIo, createMemoryModel, acknowledge, deferred } = require('./support/fakes');

const VALID_MESSAGE_ID = '507f1f77bcf86cd799439011';

function saveableDocument(value) {
  const document = { ...value };
  Object.defineProperties(document, {
    markModified: { value: () => {}, enumerable: false },
    save: { value: async () => document, enumerable: false }
  });
  return document;
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
    autoMod: { blockedKeywords: ['spam'], mentionLimit: 5, repeatLimit: 4, repeatWindowSeconds: 45 }
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

test('exact-room moderator and global admin can update room AutoMod settings without auditing keywords', async () => {
  const setup = reportingScenario();
  const moderatorSettings = {
    blockedKeywords: ['  ＳＰＡＭ  ', 'spam', 'Spoilers'],
    mentionLimit: 4,
    repeatLimit: 5,
    repeatWindowSeconds: 60
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
    repeatWindowSeconds: 60
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
    repeatWindowSeconds: 60
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
    repeatWindowSeconds: 45
  }, adminAck.callback);
  assert.deepEqual(adminAck.value(), {
    success: true,
    autoMod: {
      blockedKeywords: ['adminrule'], mentionLimit: 3, repeatLimit: 4, repeatWindowSeconds: 45
    }
  });

  const globalAck = acknowledge();
  await adminSocket.trigger('update_automod', {
    serverCode: 'global',
    blockedKeywords: ['LobbyRule'],
    mentionLimit: 2,
    repeatLimit: 3,
    repeatWindowSeconds: 30
  }, globalAck.callback);
  assert.deepEqual(globalAck.value(), {
    success: true,
    autoMod: {
      blockedKeywords: ['lobbyrule'], mentionLimit: 2, repeatLimit: 3, repeatWindowSeconds: 30
    }
  });
  assert.deepEqual(setup.ChatServerModel.rows.find(room => room.code === 'global').autoMod, {
    blockedKeywords: ['lobbyrule'], mentionLimit: 2, repeatLimit: 3, repeatWindowSeconds: 30
  });
});

test('update AutoMod settings denies other-room, stale, banned, and non-admin Global moderators', async () => {
  const setup = reportingScenario();
  const requestedSettings = {
    blockedKeywords: ['private'], mentionLimit: 4, repeatLimit: 4, repeatWindowSeconds: 40
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
  assert.deepEqual(normalizeAutoModSettings({
    blockedKeywords: ['  SPAM  ', 'spam', 'ＢＡＤ'],
    mentionLimit: 5,
    repeatLimit: 3,
    repeatWindowSeconds: 30
  }), {
    blockedKeywords: ['spam', 'bad'], mentionLimit: 5, repeatLimit: 3, repeatWindowSeconds: 30
  });
  assert.equal(normalizeAutoModSettings({ blockedKeywords: [], mentionLimit: 0, repeatLimit: 3, repeatWindowSeconds: 30 }), null);
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
  assert.deepEqual(setup.ioInstance.outbound.map(item => item.payload.text), [
    repeatText.trim(), 'same repeat', 'same repeat', 'same  repeat'
  ]);

  await new Promise(resolve => setTimeout(resolve, 510));
  await setup.socket.trigger('chat_message', { text: 'same repeat' });

  assert.equal(setup.MessageModel.rows.length, 4);
  assert.equal(setup.ioInstance.outbound.length, 4);
  assert.deepEqual(setup.socket.outbound, [{
    target: 'self', event: 'message_blocked', payload: { rule: 'content_policy' }
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
    target: 'self', event: 'message_blocked', payload: { rule: 'content_policy' }
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

test('audit schema registers every prohibited mutation operation', () => {
  const source = require('node:fs').readFileSync(require.resolve('../server'), 'utf8');
  for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
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
      item.target === 'ABC123' && item.event === 'typing' && item.payload.isTyping === true
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

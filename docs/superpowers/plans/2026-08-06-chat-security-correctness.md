# Chat Security and Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair confirmed backend authorization and validation defects plus confirmed frontend rendering and connection defects while keeping the production chat application at exactly three files.

**Architecture:** Keep all backend helpers and the dependency-injected Socket.IO connection-handler factory in `backend/server.js`; keep all browser code in `chat.html`; keep scripts and deployment notes in `backend/package.json`. Add test-only files under `backend/test/` and exercise exported production behavior with in-memory socket and model fakes.

**Tech Stack:** Node.js 22, CommonJS, `node:test`, Express 4, Socket.IO 4, Mongoose 8, bcryptjs, plain HTML/CSS/JavaScript.

## Global Constraints

- The production chat application consists of exactly `chat.html`, `backend/server.js`, and `backend/package.json`.
- Do not create another production JavaScript, CSS, HTML, README, environment, or helper file.
- Test-only files under `backend/test/`, repository configuration, and Superpowers documents are not production application files.
- Preserve Socket.IO event names, acknowledgement object shapes, MongoDB schemas, room roles, and visible workflows.
- Preserve global-administrator ghost access to existing rooms.
- Use Node's built-in test runner and add no production dependency.
- Usernames are 1–20 characters; display names and server names are 1–30 characters; messages are at most 2,000 characters; passwords are 6–128 characters.
- Avatar URLs are HTTP(S) and at most 1,000 characters.
- Attachments are JPEG, PNG, GIF, or WebP base64 data URLs no longer than 8,000,000 characters.
- Edit history retains the 20 most recent previous versions.
- The original checkout's `Zone.Identifier` deletions remain untouched; the isolated worktree may retain its tracked copies.
- Tests assert behavior and observable side effects, not source-code text.

---

### Task 1: Make the backend importable and add policy helpers

**Files:**
- Modify: `backend/server.js`
- Modify: `backend/package.json`
- Create: `backend/test/chat-security.test.js`

**Interfaces:**
- Produces from `backend/server.js`: `safeAck(callback)`, `normalizeUsername(value)`, `normalizeDisplayName(value)`, `normalizeServerName(value)`, `normalizeServerCode(value)`, `isValidPassword(value)`, `normalizeColor(value)`, `normalizeAvatarUrl(value)`, `isValidAttachment(value)`, `isValidReaction(value)`, `isValidObjectId(value)`, `neutralizePingTokens(text)`, `canAccessRoom(identity, serverCode)`, `appendBoundedHistory(history, entry, limit)`, `createReplySnapshot(message)`, and `start()`.
- Keeps production execution through `if (require.main === module) start();` so requiring the file does not bind a port or connect to MongoDB.

- [ ] **Step 1: Add the test command and write failing behavior tests**

Format `backend/package.json` conventionally and set:

```json
"scripts": {
  "start": "node server.js",
  "test": "node --test test/*.test.js"
}
```

Create `backend/test/chat-security.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const security = require('../server');

test('requiring server.js does not start the HTTP server', () => {
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
    'hello @everyone'
  );
  assert.equal(security.neutralizePingTokens('{{PING:alice|Alice Smith}}'), '@Alice Smith');
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
```

- [ ] **Step 2: Run the focused tests and verify the red state**

Run: `npm test --prefix backend`

Expected: FAIL because the current module starts listening when required and does not export the policy functions.

- [ ] **Step 3: Implement the pure helpers inside `backend/server.js`**

Define the following constants and functions after imports and before schemas:

```js
const USERNAME_RE = /^[A-Za-z0-9_-]{1,20}$/;
const DISPLAY_NAME_RE = /^[A-Za-z0-9_ -]{1,30}$/;
const SERVER_NAME_RE = /^[A-Za-z0-9_ -]{1,30}$/;
const SERVER_CODE_RE = /^[A-Z0-9]{6}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const ATTACHMENT_RE = /^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const REACTION_RE = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D)+$/u;

function safeAck(callback) {
  return typeof callback === 'function' ? callback : () => {};
}

function normalizeWith(value, pattern) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return pattern.test(normalized) ? normalized : null;
}

function normalizeUsername(value) { return normalizeWith(value, USERNAME_RE); }
function normalizeDisplayName(value) { return normalizeWith(value, DISPLAY_NAME_RE); }
function normalizeServerName(value) { return normalizeWith(value, SERVER_NAME_RE); }

function normalizeServerCode(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized.toLowerCase() === 'global') return 'global';
  const upper = normalized.toUpperCase();
  return SERVER_CODE_RE.test(upper) ? upper : null;
}

function isValidPassword(value) {
  return typeof value === 'string' && value.length >= 6 && value.length <= 128;
}

function normalizeColor(value) {
  if (value === '' || value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return COLOR_RE.test(normalized) ? normalized.toLowerCase() : null;
}

function normalizeAvatarUrl(value) {
  if (value === '' || value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized.length > 1000) return null;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? normalized : null;
  } catch {
    return null;
  }
}

function isValidAttachment(value) {
  return value === null || value === undefined || value === '' ||
    (typeof value === 'string' && value.length <= 8_000_000 && ATTACHMENT_RE.test(value));
}

function isValidReaction(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && REACTION_RE.test(value);
}

function isValidObjectId(value) {
  return typeof value === 'string' && OBJECT_ID_RE.test(value);
}

function neutralizePingTokens(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\{\{PING:([^|{}]*)\|([^{}]*)\}\}/gi, (_match, username, displayName) => {
    return `@${displayName || username}`;
  });
}

function canAccessRoom(identity, serverCode) {
  if (serverCode === 'global') return true;
  if (!identity || !Array.isArray(identity.joinedServers)) return false;
  return identity.role === 'admin' || identity.joinedServers.includes(serverCode);
}

function appendBoundedHistory(history, entry, limit = 20) {
  return [...(Array.isArray(history) ? history : []), entry].slice(-limit);
}

function createReplySnapshot(message) {
  const text = typeof message.text === 'string' ? message.text.slice(0, 100) : '';
  return {
    id: String(message._id),
    displayname: message.displayName || message.username,
    text: text || (message.attachment ? 'Image Attachment' : '')
  };
}
```

- [ ] **Step 4: Make startup explicit and export the tested interface**

Replace unconditional startup with:

```js
async function start() {
  if (MONGO_URI) {
    await mongoose.connect(MONGO_URI);
    await seedSystem();
  }
  return new Promise(resolve => {
    server.listen(PORT, () => {
      console.log(`🚀 Server on port ${PORT}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  start().catch(err => {
    console.error('Database startup failed:', err);
    process.exitCode = 1;
  });
}

module.exports = {
  app,
  server,
  start,
  safeAck,
  normalizeUsername,
  normalizeDisplayName,
  normalizeServerName,
  normalizeServerCode,
  isValidPassword,
  normalizeColor,
  normalizeAvatarUrl,
  isValidAttachment,
  isValidReaction,
  isValidObjectId,
  neutralizePingTokens,
  canAccessRoom,
  appendBoundedHistory,
  createReplySnapshot
};
```

Call `.unref()` on the rate-limit cleanup interval so importing the module cannot keep a test process alive.

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
npm test --prefix backend
node --check backend/server.js
```

Expected: all tests PASS with no warnings; syntax exits 0.

- [ ] **Step 6: Commit Task 1**

```bash
git add backend/server.js backend/package.json backend/test/chat-security.test.js
git commit -m "test: add chat security policy coverage"
```

---

### Task 2: Add an injectable handler factory and secure room lifecycle

**Files:**
- Modify: `backend/server.js`
- Create: `backend/test/support/fakes.js`
- Create: `backend/test/room-lifecycle.test.js`

**Interfaces:**
- Produces `createConnectionHandler(overrides = {})`, where supported overrides are `ioInstance`, `UserModel`, `ChatServerModel`, `MessageModel`, `bcryptImpl`, `onlineUsersMap`, `broadcastOnlineUsersFn`, `getRoomRoleFn`, and `resolvePingsFn`.
- The returned function accepts one Socket.IO-compatible socket and registers the existing events.
- Production registers handlers with `io.on('connection', createConnectionHandler())`.

- [ ] **Step 1: Create reusable in-memory test fakes**

Create `backend/test/support/fakes.js` with:

```js
class FakeSocket {
  constructor() {
    this.handlers = new Map();
    this.joinedRooms = new Set();
    this.leftRooms = [];
    this.outbound = [];
    this.handshake = { headers: {}, address: '127.0.0.1' };
    this.id = 'socket-1';
  }
  on(event, handler) { this.handlers.set(event, handler); }
  async trigger(event, ...args) { return this.handlers.get(event)(...args); }
  join(room) { this.joinedRooms.add(room); }
  leave(room) { this.joinedRooms.delete(room); this.leftRooms.push(room); }
  emit(event, payload) { this.outbound.push({ target: 'self', event, payload }); }
  to(room) {
    return { emit: (event, payload) => this.outbound.push({ target: room, event, payload }) };
  }
  disconnect() { this.disconnected = true; }
}

class FakeIo {
  constructor() { this.outbound = []; this.sockets = []; }
  to(room) { return { emit: (event, payload) => this.outbound.push({ room, event, payload }) }; }
  emit(event, payload) { this.outbound.push({ room: '*', event, payload }); }
  async fetchSockets() { return this.sockets; }
}

function queryResult(value) {
  return {
    lean: async () => value,
    sort() { return this; },
    limit() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); }
  };
}

function acknowledge() {
  let value;
  return { callback(result) { value = result; }, value() { return value; } };
}

module.exports = { FakeSocket, FakeIo, queryResult, acknowledge };
```

- [ ] **Step 2: Write failing room-lifecycle behavior tests**

Create `backend/test/room-lifecycle.test.js` covering these observable behaviors with `FakeSocket`, `FakeIo`, literal model results, and no source-text assertions:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConnectionHandler } = require('../server');
const { FakeSocket, FakeIo, queryResult, acknowledge } = require('./support/fakes');

function register(overrides = {}) {
  const socket = new FakeSocket();
  const ioInstance = new FakeIo();
  createConnectionHandler({
    ioInstance,
    onlineUsersMap: new Map(),
    broadcastOnlineUsersFn: async () => {},
    getRoomRoleFn: async () => 'user',
    resolvePingsFn: async text => text,
    ...overrides
  })(socket);
  return { socket, ioInstance };
}

test('login rejects replacing an authenticated socket identity', async () => {
  const { socket } = register();
  socket.username = 'alice';
  const ack = acknowledge();
  await socket.trigger('login', { username: 'bob', password: '123456' }, ack.callback);
  assert.deepEqual(ack.value(), { error: 'Already authenticated.' });
  assert.equal(socket.username, 'alice');
});

test('unauthorized room switch leaves current membership unchanged', async () => {
  const ChatServerModel = { findOne: () => queryResult({ code: 'ABC123' }) };
  const MessageModel = { find: () => queryResult([]) };
  const { socket } = register({ ChatServerModel, MessageModel });
  socket.username = 'alice';
  socket.role = 'user';
  socket.joinedServers = ['global'];
  socket.serverCode = 'global';
  socket.joinedRooms.add('global');
  const ack = acknowledge();
  await socket.trigger('switch_server', 'ABC123', ack.callback);
  assert.deepEqual(ack.value(), { error: 'Permission denied.' });
  assert.equal(socket.serverCode, 'global');
  assert.equal(socket.leftRooms.length, 0);
});

test('authorized room switch leaves old room only after access succeeds', async () => {
  const ChatServerModel = { findOne: () => queryResult({ code: 'ABC123', moderators: [] }) };
  const MessageModel = { find: () => queryResult([]) };
  const { socket } = register({ ChatServerModel, MessageModel });
  socket.username = 'alice';
  socket.role = 'user';
  socket.joinedServers = ['global', 'ABC123'];
  socket.serverCode = 'global';
  socket.joinedRooms.add('global');
  const ack = acknowledge();
  await socket.trigger('switch_server', 'ABC123', ack.callback);
  assert.equal(socket.serverCode, 'ABC123');
  assert.deepEqual(socket.leftRooms, ['global']);
  assert.equal(socket.joinedRooms.has('ABC123'), true);
  assert.deepEqual(ack.value(), { history: [], roomRole: 'user' });
});

test('leaving the active room removes transport and moderator access then moves to global', async () => {
  const user = { servers: ['global', 'ABC123'], async save() {} };
  const pulled = [];
  const UserModel = { findOne: async () => user };
  const ChatServerModel = { async updateOne(filter, update) { pulled.push({ filter, update }); } };
  const { socket } = register({ UserModel, ChatServerModel });
  socket.username = 'alice';
  socket.displayName = 'Alice';
  socket.serverCode = 'ABC123';
  socket.joinedServers = user.servers;
  socket.joinedRooms.add('ABC123');
  const ack = acknowledge();
  await socket.trigger('leave_server', 'ABC123', ack.callback);
  assert.deepEqual(user.servers, ['global']);
  assert.equal(socket.joinedRooms.has('ABC123'), false);
  assert.equal(socket.joinedRooms.has('global'), true);
  assert.equal(socket.serverCode, 'global');
  assert.deepEqual(pulled, [{
    filter: { code: 'ABC123' },
    update: { $pull: { moderators: 'alice' } }
  }]);
  assert.deepEqual(ack.value(), { success: true });
});
```

In the same file, add table-driven behavior tests that trigger each acknowledgement event without a callback and assert the returned promise does not reject. Add spies that prove invalid profile values cause no `UserModel` write, promotion of a non-member causes no `ChatServerModel` write, and registration checks case-insensitive collisions independently for both username and display name.

- [ ] **Step 3: Run the room tests and verify the red state**

Run: `node --test backend/test/room-lifecycle.test.js`

Expected: FAIL because `createConnectionHandler` is not exported and current handlers close over production dependencies.

- [ ] **Step 4: Refactor existing handlers into the injectable factory**

Wrap the current `io.on('connection', socket => { ... })` body in:

```js
function createConnectionHandler({
  ioInstance = io,
  UserModel = User,
  ChatServerModel = ChatServer,
  MessageModel = Message,
  bcryptImpl = bcrypt,
  onlineUsersMap = onlineUsers,
  broadcastOnlineUsersFn = broadcastOnlineUsers,
  getRoomRoleFn = getRoomRole,
  resolvePingsFn = resolvePings
} = {}) {
  return socket => {
    // existing event registrations, using the injected names above
  };
}

io.on('connection', createConnectionHandler());
```

Replace handler references to `io`, `User`, `ChatServer`, `Message`, `bcrypt`, `onlineUsers`, `broadcastOnlineUsers`, `getRoomRole`, and `resolvePings` with the injected names inside the factory. Export `createConnectionHandler` in Task 1's `module.exports` object.

- [ ] **Step 5: Implement authentication, seeding, input, and lifecycle fixes**

Make `seedSystem` injectable and export it:

```js
async function seedSystem({
  UserModel = User,
  ChatServerModel = ChatServer,
  bcryptImpl = bcrypt,
  adminPassword = process.env.ADMIN_PASSWORD
} = {}) {
  await ChatServerModel.findOneAndUpdate(
    { code: 'global' },
    { $setOnInsert: { code: 'global', name: 'Global Chat', owner: 'System', moderators: [] } },
    { upsert: true, setDefaultsOnInsert: true }
  );
  if (!adminPassword) return;
  if (!isValidPassword(adminPassword)) throw new Error('ADMIN_PASSWORD must contain 6 to 128 characters.');
  const existing = await UserModel.findOne({ username: /^NYZhang1$/i });
  if (!existing) {
    await UserModel.create({
      username: 'NYZhang1',
      displayName: 'Bacon',
      password: await bcryptImpl.hash(adminPassword, 10),
      role: 'admin',
      servers: ['global']
    });
  }
}
```

For every acknowledgement handler, set `callback = safeAck(callback)` before early returns. Apply these exact rules:

- Registration uses normalized username/display name, validates a 6–128 character password, reserves `NYZhang1`, and rejects every case-insensitive username or display-name collision.
- Login rejects an already authenticated socket, validates inputs before bcrypt, and never changes rooms before success.
- Password change uses `isValidPassword` for the new password.
- Profile update requires normalized display name, color, and avatar URL and reserves the owner name.
- Server creation requires `normalizeServerName`; retry duplicate generated codes at most five times.
- Join, leave, delete, and switch require `normalizeServerCode`.
- Role actions come from the four existing allowed action strings; room promotion requires target membership.
- `switch_server` confirms room existence and `canAccessRoom` before calling `socket.leave`.
- `leave_server` removes database membership, pulls the moderator entry, emits the old-room leave message, calls `socket.leave(code)`, and moves an active socket to global.

- [ ] **Step 6: Run Task 2 tests and full suite**

Run:

```bash
node --test backend/test/room-lifecycle.test.js
npm test --prefix backend
node --check backend/server.js
```

Expected: all tests PASS with no warnings; syntax exits 0.

- [ ] **Step 7: Commit Task 2**

```bash
git add backend/server.js backend/test/support/fakes.js backend/test/room-lifecycle.test.js
git commit -m "fix: secure authentication and room lifecycle"
```

---

### Task 3: Secure message creation and message actions behaviorally

**Files:**
- Modify: `backend/server.js`
- Create: `backend/test/message-actions.test.js`

**Interfaces:**
- Consumes Task 1 policies and Task 2 `createConnectionHandler` injection points.
- Produces trusted message persistence and room-authorized `chat_message`, `toggle_reaction`, `edit_message`, `delete_message`, `get_edit_history`, `get_deleted_message`, and `typing` behavior.

- [ ] **Step 1: Write failing behavior tests for room-sensitive actions**

Create `backend/test/message-actions.test.js` with the Task 2 fakes and real registered handlers. Cover at least these literal outcomes:

```js
test('reaction in an inaccessible message room does not save or emit', async () => {
  let saved = false;
  const message = {
    serverCode: 'ABC123', deleted: false, reactions: {},
    markModified() {}, async save() { saved = true; }
  };
  const MessageModel = { findById: async () => message };
  const { socket, ioInstance } = registerMessages({ MessageModel });
  socket.username = 'alice';
  socket.role = 'user';
  socket.joinedServers = ['global'];
  socket.serverCode = 'global';
  await socket.trigger('toggle_reaction', { id: '507f1f77bcf86cd799439011', emoji: '👍' });
  assert.equal(saved, false);
  assert.deepEqual(ioInstance.outbound, []);
});

test('editing emits to the stored message room rather than current socket room', async () => {
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'alice',
    role: 'user', roomRole: 'user', text: 'before', history: [], deleted: false,
    markModified() {}, async save() {}
  };
  const MessageModel = { findById: async () => message };
  const { socket, ioInstance } = registerMessages({ MessageModel });
  socket.username = 'alice';
  socket.role = 'user';
  socket.joinedServers = ['global', 'ABC123'];
  socket.serverCode = 'global';
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
    async create(value) { created = value; return { ...value, _id: '507f191e810c19729de860ea', timestamp: new Date() }; }
  };
  const { socket } = registerMessages({ MessageModel });
  socket.username = 'alice';
  socket.displayName = 'Alice';
  socket.role = 'user';
  socket.joinedServers = ['global', 'ABC123'];
  socket.serverCode = 'ABC123';
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
```

In the same file, add behavior tests with injected spies proving that raw `{{PING:everyone|everyone}}` reaches the mention resolver as `@everyone`, invalid attachment and reaction values cause no model write, a 21-entry edit history retains only the newest 20 entries, owners who left a room cannot edit/read/delete old messages, and typing emits `{ username, displayName, isTyping }` only for accessible active rooms.

- [ ] **Step 2: Run the message tests and verify the red state**

Run: `node --test backend/test/message-actions.test.js`

Expected: FAIL because current handlers do not enforce message-room access, trust reply snapshots, and edit to `socket.serverCode`.

- [ ] **Step 3: Validate and authorize message creation**

In `chat_message`, require an authenticated identity with access to `socket.serverCode`, require a string text field, validate the optional attachment, neutralize ping tokens before resolving real mentions, and cap text at 2,000 characters.

For `replyTo.id`, require a valid object id, load the referenced message, require the same active room, require that it is not deleted, and persist only `createReplySnapshot(referenced)`. Persist `null` for an invalid reference without rejecting an otherwise valid outgoing message.

- [ ] **Step 4: Validate and authorize every referenced-message action**

After loading a message for reaction, edit, delete, edit history, or deleted-content reads, call:

```js
const identity = { role: socket.role, joinedServers: socket.joinedServers || [] };
if (!canAccessRoom(identity, msg.serverCode)) return;
```

Require valid object ids. Require `isValidReaction(emoji)` before reading or writing reaction keys. Preserve sender/admin/moderator permissions only after access is established. Use:

```js
msg.history = appendBoundedHistory(msg.history, { text: msg.text, timestamp: new Date() });
```

Emit mutations with `ioInstance.to(msg.serverCode)`. Include `displayName: socket.displayName || socket.username` in typing payloads and validate the boolean typing state.

- [ ] **Step 5: Log unexpected failures without sensitive payload content**

Replace empty catches with event-specific logging such as `console.error('edit_message failed:', err)`. Never log passwords, message text, attachment data, or reply snapshots.

- [ ] **Step 6: Run Task 3 tests and full suite**

Run:

```bash
node --test backend/test/message-actions.test.js
npm test --prefix backend
node --check backend/server.js
```

Expected: all tests PASS with no warnings; syntax exits 0.

- [ ] **Step 7: Commit Task 3**

```bash
git add backend/server.js backend/test/message-actions.test.js
git commit -m "fix: authorize and validate message actions"
```

---

### Task 4: Correct the single-file frontend safely

**Files:**
- Modify: `chat.html`
- Create: `backend/test/client-smoke.test.js`

**Interfaces:**
- Produces inline `ChatClientHelpers` with `normalizeBackendUrl`, `replaceSocket`, `appendTextElement`, and `typingDisplayName`.
- Consumes corrected typing payload `{ username, displayName, isTyping }` and unchanged acknowledgement object shapes.

- [ ] **Step 1: Write the failing inline-helper smoke test**

Create `backend/test/client-smoke.test.js` that reads `chat.html`, extracts the code between `TESTABLE_CLIENT_HELPERS_START` and `TESTABLE_CLIENT_HELPERS_END`, executes that real block with `node:vm`, and asserts:

```js
test('backend URLs allow only HTTP and HTTPS', () => {
  const helpers = loadHelpers();
  assert.equal(helpers.normalizeBackendUrl('example.com/'), 'https://example.com');
  assert.equal(helpers.normalizeBackendUrl('http://localhost:3000/'), 'http://localhost:3000');
  assert.equal(helpers.normalizeBackendUrl('javascript:alert(1)'), null);
});

test('changing backend URL disconnects and replaces the old socket', () => {
  const helpers = loadHelpers();
  let disconnected = 0;
  const oldSocket = { disconnect() { disconnected += 1; } };
  const ioFactory = url => ({ url });
  assert.equal(helpers.replaceSocket(oldSocket, 'https://a.test', 'https://a.test', ioFactory).socket, oldSocket);
  assert.equal(disconnected, 0);
  assert.equal(helpers.replaceSocket(oldSocket, 'https://a.test', 'https://b.test', ioFactory).socket.url, 'https://b.test');
  assert.equal(disconnected, 1);
});

test('stored markup is assigned as text rather than interpreted HTML', () => {
  const helpers = loadHelpers();
  const parent = { children: [], appendChild(child) { this.children.push(child); } };
  const doc = { createElement: tagName => ({ tagName, className: '', textContent: '' }) };
  const child = helpers.appendTextElement(doc, parent, 'span', 'name', '<img src=x>');
  assert.equal(child.textContent, '<img src=x>');
});

test('typing display falls back to username', () => {
  const helpers = loadHelpers();
  assert.equal(helpers.typingDisplayName({ username: 'alice', displayName: 'Alice' }), 'Alice');
  assert.equal(helpers.typingDisplayName({ username: 'alice' }), 'alice');
});
```

- [ ] **Step 2: Run the client test and verify the red state**

Run: `node --test backend/test/client-smoke.test.js`

Expected: FAIL because the inline helper block does not exist.

- [ ] **Step 3: Add inline helpers and success color**

Add `--success: #3ba55c` to `:root`. Add a delimited `ChatClientHelpers` block near the beginning of the existing inline script. Implement URL normalization, conditional socket replacement, safe text-element creation, and typing-name fallback exactly as exercised by Step 1. Expose it with `globalThis.ChatClientHelpers = ChatClientHelpers` for the smoke test.

- [ ] **Step 4: Fix authentication connection lifecycle**

Track `socketUrl`. Validate with `normalizeBackendUrl`. When a normalized URL differs, disconnect the old socket, create a new one, and call `setupSocket()` once for that new socket. On `connect_error`, re-enable the authentication button and show `Unable to connect. Check the backend URL and try again.`. Treat an absent acknowledgement result as `{ error: 'No response from server.' }` before reading it.

- [ ] **Step 5: Replace untrusted HTML interpolation with DOM construction**

Use `appendTextElement` or direct `textContent` for server tooltips and titles, user labels and context menus, deleted-message author labels, reply authors and reply text, and compose info-bar labels. Create image and badge nodes directly. Keep `innerHTML` only for constant markup or the escaped output of `formatMessageText`.

- [ ] **Step 6: Make room switching acknowledgement-driven**

Do not assign `currentServerCode` or mutate active-room UI before a successful acknowledgement. On `{ error }`, retain the previous room and show the existing modal. On success, assign room state, render active icon/header/buttons, clear old history and typing state, and load the acknowledged history.

- [ ] **Step 7: Correct typing names**

Store `typingUsers.set(data.username, ChatClientHelpers.typingDisplayName(data))` and retain the existing single/multiple typing wording.

- [ ] **Step 8: Run Task 4 tests and full suite**

Run:

```bash
node --test backend/test/client-smoke.test.js
npm test --prefix backend
sed -n '/<script>/,/<\/script>/p' chat.html | sed '1d;$d' | node --check -
```

Expected: all tests PASS; inline syntax exits 0.

- [ ] **Step 9: Commit Task 4**

```bash
git add chat.html backend/test/client-smoke.test.js
git commit -m "fix: harden single-file chat client"
```

---

### Task 5: Document deployment in package metadata and verify the three-file application

**Files:**
- Modify: `backend/package.json`
- Verify: `backend/server.js`
- Verify: `chat.html`
- Verify: test-only files under `backend/test/`

**Interfaces:**
- Consumes all previous tasks.
- Produces final package metadata and complete verification evidence.

- [ ] **Step 1: Document environment requirements without adding an application file**

Set the package description to:

```json
"description": "Three-file Socket.IO chat; requires MONGO_URI, supports optional ADMIN_PASSWORD (6-128 characters), and defaults PORT to 3000"
```

Do not create a README, `.env`, production helper, client script, stylesheet, or additional manifest.

- [ ] **Step 2: Run the complete automated suite and syntax checks**

Run:

```bash
npm test --prefix backend
node --check backend/server.js
sed -n '/<script>/,/<\/script>/p' chat.html | sed '1d;$d' | node --check -
git diff --check 593dda5..HEAD
```

Expected: all tests pass, all syntax checks exit 0, and the diff check prints nothing.

- [ ] **Step 3: Verify credentials and production file count**

Run:

```bash
rg -n "DragonNYZ0924|bcrypt\\.hash\\([[:space:]]*['\"]" backend/server.js chat.html backend/package.json
find . -path './.git' -prune -o -path './.superpowers' -prune -o -path './backend/test' -prune -o -path './docs' -prune -o -path './.worktrees' -prune -o -type f -print | sort
```

Expected: the credential scan returns no matches. After excluding Git metadata, test-only files, planning documents, and worktree scratch data, the application file list contains `.gitignore`, the three tracked `Zone.Identifier` metadata files, and exactly these three production files:

```text
./backend/package.json
./backend/server.js
./chat.html
```

- [ ] **Step 4: Verify protocol event coverage manually**

Run:

```bash
rg -n 'socket\.on\(|socket\.emit\(' backend/server.js chat.html
rg -n 'innerHTML[[:space:]]*=.*\$\{' chat.html
git status --short
git diff --stat 593dda5..HEAD
```

Confirm every client-emitted event retains a backend handler, every server-emitted UI event retains a client handler, and remaining interpolated `innerHTML` assignments contain only constant or formatter-escaped markup. The isolated worktree must be clean before final review.

- [ ] **Step 5: Commit Task 5**

```bash
git add backend/package.json
git commit -m "docs: document secure chat startup"
```

- [ ] **Step 6: Review final branch history**

Run:

```bash
git log --oneline --decorate -8
git diff --stat 593dda5..HEAD
git diff --check 593dda5..HEAD
git status --short
```

Expected: five focused implementation commits after `593dda5`, no whitespace errors, and a clean isolated worktree.

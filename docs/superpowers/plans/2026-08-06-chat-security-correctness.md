# Chat Security and Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the confirmed backend authorization and validation defects plus the confirmed single-file frontend rendering and connection defects without changing intended chat workflows.

**Architecture:** Keep `chat.html` as the only production frontend file. Extract dependency-free backend policy functions into `backend/lib/chat-security.js`, integrate them into the existing Socket.IO handlers, and test both the pure rules and their wiring with Node's built-in test runner.

**Tech Stack:** Node.js 22, CommonJS, `node:test`, Express 4, Socket.IO 4, Mongoose 8, bcryptjs, plain HTML/CSS/JavaScript.

## Global Constraints

- Keep `chat.html` as the only production frontend file; do not create production `.js` or `.css` files.
- Preserve Socket.IO event names, acknowledgement object shapes, MongoDB schemas, room roles, and visible workflows.
- Preserve global-administrator ghost access to existing rooms.
- Use Node's built-in test runner and add no production dependency.
- Usernames are 1–20 characters; display names and server names are 1–30 characters; messages are at most 2,000 characters; passwords are 6–128 characters.
- Avatar URLs are HTTP(S) and at most 1,000 characters.
- Attachments are JPEG, PNG, GIF, or WebP base64 data URLs no longer than 8,000,000 characters.
- Edit history retains the 20 most recent previous versions.
- Preserve the unstaged deletions of all three `Zone.Identifier` metadata files.

---

### Task 1: Add dependency-free security policy helpers

**Files:**
- Create: `backend/lib/chat-security.js`
- Create: `backend/test/chat-security.test.js`
- Modify: `backend/package.json`

**Interfaces:**
- Consumes: JavaScript primitives plus socket identity objects shaped as `{ role: string, joinedServers: string[] }`.
- Produces: `safeAck`, `normalizeUsername`, `normalizeDisplayName`, `normalizeServerName`, `normalizeServerCode`, `isValidPassword`, `normalizeColor`, `normalizeAvatarUrl`, `isValidAttachment`, `isValidReaction`, `isValidObjectId`, `neutralizePingTokens`, `canAccessRoom`, `appendBoundedHistory`, and `createReplySnapshot`.

- [ ] **Step 1: Add the test command and write the failing helper tests**

Update `backend/package.json` scripts to:

```json
"scripts": {
  "start": "node server.js",
  "test": "node --test test/*.test.js"
}
```

Create `backend/test/chat-security.test.js` with table-driven behavioral tests:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
} = require('../lib/chat-security');

test('safeAck returns a callable no-op when acknowledgement is omitted', () => {
  assert.doesNotThrow(() => safeAck(undefined)({ error: 'ignored' }));
  let received;
  safeAck(value => { received = value; })({ success: true });
  assert.deepEqual(received, { success: true });
});

test('identity and room values are normalized without truncating invalid input', () => {
  assert.equal(normalizeUsername(' Alice_1 '), 'Alice_1');
  assert.equal(normalizeUsername('x'.repeat(21)), null);
  assert.equal(normalizeDisplayName(' Alice Smith '), 'Alice Smith');
  assert.equal(normalizeDisplayName('<img>'), null);
  assert.equal(normalizeServerName(' Team Room '), 'Team Room');
  assert.equal(normalizeServerName('Room<script>'), null);
  assert.equal(normalizeServerCode(' ab12cd '), 'AB12CD');
  assert.equal(normalizeServerCode('global'), 'global');
  assert.equal(normalizeServerCode('ABC'), null);
});

test('password, profile, attachment, reaction, and id validation is bounded', () => {
  assert.equal(isValidPassword('123456'), true);
  assert.equal(isValidPassword('x'.repeat(129)), false);
  assert.equal(normalizeColor('#A1b2C3'), '#a1b2c3');
  assert.equal(normalizeColor('red; background:url(x)'), null);
  assert.equal(normalizeAvatarUrl('https://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(normalizeAvatarUrl('javascript:alert(1)'), null);
  assert.equal(isValidAttachment('data:image/png;base64,AAAA'), true);
  assert.equal(isValidAttachment('javascript:alert(1)'), false);
  assert.equal(isValidReaction('👍'), true);
  assert.equal(isValidReaction('__proto__😀'), false);
  assert.equal(isValidObjectId('507f1f77bcf86cd799439011'), true);
  assert.equal(isValidObjectId('not-an-id'), false);
});

test('client ping tokens become ordinary mention text before resolution', () => {
  assert.equal(
    neutralizePingTokens('hello {{PING:everyone|everyone}}'),
    'hello @everyone'
  );
  assert.equal(
    neutralizePingTokens('{{PING:alice|Alice Smith}}'),
    '@Alice Smith'
  );
});

test('room access preserves global and admin access but rejects non-members', () => {
  assert.equal(canAccessRoom({ role: 'user', joinedServers: ['global'] }, 'global'), true);
  assert.equal(canAccessRoom({ role: 'user', joinedServers: ['global'] }, 'ABC123'), false);
  assert.equal(canAccessRoom({ role: 'user', joinedServers: ['global', 'ABC123'] }, 'ABC123'), true);
  assert.equal(canAccessRoom({ role: 'admin', joinedServers: ['global'] }, 'ABC123'), true);
});

test('history and reply snapshots are derived and bounded', () => {
  const history = Array.from({ length: 20 }, (_, index) => ({ text: String(index) }));
  const bounded = appendBoundedHistory(history, { text: 'next' });
  assert.equal(bounded.length, 20);
  assert.equal(bounded[0].text, '1');
  assert.equal(bounded[19].text, 'next');

  const snapshot = createReplySnapshot({
    _id: '507f1f77bcf86cd799439011',
    username: 'alice',
    displayName: 'Alice',
    text: 'x'.repeat(150),
    attachment: null
  });
  assert.equal(snapshot.displayname, 'Alice');
  assert.equal(snapshot.text.length, 100);
});
```

- [ ] **Step 2: Run the helper tests and confirm the red state**

Run: `npm test --prefix backend`

Expected: FAIL with `Cannot find module '../lib/chat-security'`.

- [ ] **Step 3: Implement the minimal policy module**

Create `backend/lib/chat-security.js`:

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

module.exports = {
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

- [ ] **Step 4: Run the helper tests and confirm the green state**

Run: `npm test --prefix backend`

Expected: all helper tests PASS with no warnings.

- [ ] **Step 5: Commit Task 1**

```bash
git add backend/package.json backend/lib/chat-security.js backend/test/chat-security.test.js
git commit -m "test: add chat security policy coverage"
```

---

### Task 2: Secure authentication, seeding, roles, and room lifecycle

**Files:**
- Modify: `backend/server.js`
- Create: `backend/test/server-wiring.test.js`
- Test: `backend/test/chat-security.test.js`

**Interfaces:**
- Consumes: Task 1 exports from `./lib/chat-security`.
- Produces: protected `register`, `login`, `change_password`, `logout_all_devices`, `update_profile`, `manage_role`, `create_server`, `join_server`, `leave_server`, `delete_server`, and `switch_server` handlers.

- [ ] **Step 1: Write failing wiring regressions**

Create `backend/test/server-wiring.test.js` with source-level integration assertions:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function handler(name) {
  const start = source.indexOf(`socket.on('${name}'`);
  assert.notEqual(start, -1, `missing ${name} handler`);
  const next = source.indexOf("socket.on('", start + 12);
  return source.slice(start, next === -1 ? source.length : next);
}

test('source contains no shipped administrator password', () => {
  assert.doesNotMatch(source, /DragonNYZ0924/);
  assert.match(source, /process\.env\.ADMIN_PASSWORD/);
});

test('acknowledgement handlers normalize omitted callbacks', () => {
  for (const event of [
    'register', 'login', 'change_password', 'logout_all_devices', 'update_profile',
    'manage_role', 'create_server', 'join_server', 'leave_server', 'delete_server',
    'switch_server', 'get_edit_history', 'get_deleted_message'
  ]) {
    assert.match(handler(event), /safeAck\(callback\)/, `${event} must use safeAck`);
  }
});

test('login blocks identity replacement and room switches check access before leaving', () => {
  assert.match(handler('login'), /if \(socket\.username\)/);
  const switchHandler = handler('switch_server');
  assert.match(switchHandler, /canAccessRoom/);
  assert.ok(switchHandler.indexOf('canAccessRoom') < switchHandler.indexOf('socket.leave'));
});

test('leaving a room removes socket and moderator membership', () => {
  const leaveHandler = handler('leave_server');
  assert.match(leaveHandler, /socket\.leave\(code\)/);
  assert.match(leaveHandler, /\$pull: \{ moderators: socket\.username \}/);
  assert.match(leaveHandler, /socket\.serverCode = 'global'/);
});
```

- [ ] **Step 2: Run the targeted test and confirm the red state**

Run: `node --test backend/test/server-wiring.test.js`

Expected: FAIL on the hardcoded password assertion before later wiring assertions can pass.

- [ ] **Step 3: Import helpers and make seeding non-destructive**

At the top of `backend/server.js`, import all Task 1 functions. Replace `seedSystem` with logic equivalent to:

```js
async function seedSystem() {
  await ChatServer.findOneAndUpdate(
    { code: 'global' },
    { $setOnInsert: { code: 'global', name: 'Global Chat', owner: 'System', moderators: [] } },
    { upsert: true, setDefaultsOnInsert: true }
  );

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    console.warn('ADMIN_PASSWORD is not set; owner account seeding skipped.');
    return;
  }
  if (!isValidPassword(adminPassword)) {
    throw new Error('ADMIN_PASSWORD must contain 6 to 128 characters.');
  }

  const existingAdmin = await User.findOne({ username: /^NYZhang1$/i });
  if (!existingAdmin) {
    await User.create({
      username: 'NYZhang1',
      displayName: 'Bacon',
      password: await bcrypt.hash(adminPassword, 10),
      role: 'admin',
      servers: ['global']
    });
  }
}
```

Keep `mongoose.connect(MONGO_URI).then(seedSystem)` and replace the generic rejection handler with `console.error('Database startup failed:', err)`.

- [ ] **Step 4: Normalize callbacks and payloads across acknowledgement handlers**

At the first line of every acknowledgement handler, assign `callback = safeAck(callback)`. Use the Task 1 normalizers instead of `.substring()` or direct property access. Apply these exact rules:

```js
const cleanUser = normalizeUsername(data?.username);
const cleanDisplay = normalizeDisplayName(data?.displayName || data?.username);
if (!cleanUser || !cleanDisplay || !isValidPassword(data?.password)) {
  return callback({ error: 'Invalid input format.' });
}
```

- Registration rejects every case-insensitive display-name collision, even when display name equals the new username.
- Login rejects `socket.username` with `{ error: 'Already authenticated.' }` and validates password type and maximum length before bcrypt.
- Password change uses `isValidPassword(data?.newPassword)`.
- Profile updates require a valid normalized display name, color, and avatar URL and reserve `NYZhang1` for the system owner.
- Server creation requires `normalizeServerName(name)` and retries code creation up to five times only when MongoDB reports duplicate key code `11000`.
- Join, leave, delete, and switch use `normalizeServerCode(code)`.
- Role management accepts only `promote_global_admin`, `demote_global_admin`, `promote_mod`, or `demote_mod`; room promotion verifies `targetUserDoc.servers.includes(serverCode)`.

- [ ] **Step 5: Enforce room access before state changes**

Use this identity shape everywhere:

```js
const identity = { role: socket.role, joinedServers: socket.joinedServers || [] };
```

In `switch_server`, look up non-global rooms before leaving the old room, reject missing rooms with `Server not found.`, and reject `!canAccessRoom(identity, code)` with `Permission denied.`. Only then leave the old room, join the new room, set `socket.serverCode`, update presence, and return `{ history, roomRole }`.

In `leave_server`, after updating the user:

```js
await ChatServer.updateOne({ code }, { $pull: { moderators: socket.username } });
socket.leave(code);
if (socket.serverCode === code) {
  socket.serverCode = 'global';
  socket.join('global');
}
```

Update `onlineUsers` after changing both `joinedServers` and `serverCode`. Emit the leave system message to the old room before `socket.leave(code)`.

- [ ] **Step 6: Run Task 2 tests and syntax checks**

Run:

```bash
npm test --prefix backend
node --check backend/server.js
```

Expected: all tests PASS; syntax check exits 0.

- [ ] **Step 7: Commit Task 2**

```bash
git add backend/server.js backend/test/server-wiring.test.js backend/test/chat-security.test.js
git commit -m "fix: secure authentication and room lifecycle"
```

---

### Task 3: Secure message creation and room-sensitive actions

**Files:**
- Modify: `backend/server.js`
- Modify: `backend/test/server-wiring.test.js`
- Test: `backend/test/chat-security.test.js`

**Interfaces:**
- Consumes: `neutralizePingTokens`, `isValidAttachment`, `isValidReaction`, `isValidObjectId`, `canAccessRoom`, `appendBoundedHistory`, and `createReplySnapshot` from Task 1.
- Produces: trusted message persistence and room-authorized message action handlers.

- [ ] **Step 1: Add failing room-sensitive handler assertions**

Append to `backend/test/server-wiring.test.js`:

```js
test('every room-sensitive handler enforces access', () => {
  for (const event of [
    'chat_message', 'toggle_reaction', 'edit_message', 'delete_message',
    'get_edit_history', 'get_deleted_message', 'typing'
  ]) {
    assert.match(handler(event), /canAccessRoom/, `${event} must check room access`);
  }
});

test('message mutations emit to the stored message room', () => {
  for (const event of ['toggle_reaction', 'edit_message', 'delete_message']) {
    assert.match(handler(event), /io\.to\(msg\.serverCode\)/, `${event} must emit to msg.serverCode`);
  }
  assert.doesNotMatch(handler('edit_message'), /io\.to\(socket\.serverCode\)/);
});

test('message creation validates attachment, neutralizes tokens, and derives replies', () => {
  const chat = handler('chat_message');
  assert.match(chat, /isValidAttachment/);
  assert.match(chat, /neutralizePingTokens/);
  assert.match(chat, /createReplySnapshot/);
  assert.doesNotMatch(chat, /replyTo: replyTo/);
});

test('typing includes the display name expected by the client', () => {
  assert.match(handler('typing'), /displayName: socket\.displayName/);
});
```

- [ ] **Step 2: Run the targeted wiring test and confirm the red state**

Run: `node --test backend/test/server-wiring.test.js`

Expected: FAIL because the current handlers do not call `canAccessRoom`, message creation trusts `replyTo`, and typing omits `displayName`.

- [ ] **Step 3: Validate and authorize message creation**

In `chat_message`:

```js
const identity = { role: socket.role, joinedServers: socket.joinedServers || [] };
if (!socket.username || !socket.serverCode || !canAccessRoom(identity, socket.serverCode)) return;
if (!payload || (typeof payload !== 'string' && typeof payload !== 'object')) return;

const rawText = typeof payload === 'string' ? payload : payload.text;
const attachment = typeof payload === 'object' ? payload.attachment ?? null : null;
if (typeof rawText !== 'string' || !isValidAttachment(attachment)) return;

let cleanText = neutralizePingTokens(rawText).trim().slice(0, 2000);
```

Before `Message.create`, derive `replyTo` only when `payload.replyTo.id` is a valid object id. Load the referenced message, require `!referenced.deleted`, require `referenced.serverCode === socket.serverCode`, require `canAccessRoom(identity, referenced.serverCode)`, and then call `createReplySnapshot(referenced)`. Otherwise persist `replyTo: null`.

- [ ] **Step 4: Validate and authorize every referenced-message action**

For `toggle_reaction`, require an object payload, a valid object id, and `isValidReaction(emoji)`. After loading `msg`, require:

```js
const identity = { role: socket.role, joinedServers: socket.joinedServers || [] };
if (!canAccessRoom(identity, msg.serverCode)) return;
```

Apply the same access check after loading `msg` in edit, delete, history, and deleted-message handlers. A user's ownership of an old message does not override loss of room membership. Preserve administrator access and room-moderator permissions after the membership check.

In edits, replace the history mutation with:

```js
msg.history = appendBoundedHistory(msg.history, { text: msg.text, timestamp: new Date() });
msg.markModified('history');
```

Emit reactions, edits, and deletions through `io.to(msg.serverCode)`.

- [ ] **Step 5: Fix typing authorization and payload shape**

Validate `typeof isTyping === 'boolean'`, check `canAccessRoom(identity, socket.serverCode)`, and emit:

```js
socket.to(socket.serverCode).emit('typing', {
  username: socket.username,
  displayName: socket.displayName || socket.username,
  isTyping
});
```

- [ ] **Step 6: Log unexpected handler failures without message or credential content**

Replace empty catches in room and message handlers with event-specific logging, for example:

```js
} catch (err) {
  console.error('edit_message failed:', err);
}
```

Do not log payloads, passwords, message text, attachments, or reply snapshots.

- [ ] **Step 7: Run Task 3 tests and syntax checks**

Run:

```bash
npm test --prefix backend
node --check backend/server.js
```

Expected: all tests PASS; syntax check exits 0.

- [ ] **Step 8: Commit Task 3**

```bash
git add backend/server.js backend/test/server-wiring.test.js backend/test/chat-security.test.js
git commit -m "fix: authorize and validate message actions"
```

---

### Task 4: Correct the single-file frontend safely

**Files:**
- Modify: `chat.html`
- Create: `backend/test/client-smoke.test.js`

**Interfaces:**
- Consumes: existing Socket.IO events and acknowledgements plus corrected typing payload `{ username, displayName, isTyping }`.
- Produces: inline `ChatClientHelpers` with `normalizeBackendUrl`, `replaceSocket`, `appendTextElement`, and `typingDisplayName`; safer DOM rendering; acknowledged room transitions.

- [ ] **Step 1: Write the failing client helper smoke test**

Create a delimited helper block expectation in `backend/test/client-smoke.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'chat.html'), 'utf8');

function loadHelpers() {
  const match = html.match(
    /\/\/ TESTABLE_CLIENT_HELPERS_START([\s\S]*?)\/\/ TESTABLE_CLIENT_HELPERS_END/
  );
  assert.ok(match, 'testable client helper block is missing');
  const context = { URL };
  context.globalThis = context;
  vm.runInNewContext(match[1], context);
  return context.ChatClientHelpers;
}

test('backend URLs allow only HTTP and HTTPS', () => {
  const helpers = loadHelpers();
  assert.equal(helpers.normalizeBackendUrl('example.com/'), 'https://example.com');
  assert.equal(helpers.normalizeBackendUrl('http://localhost:3000/'), 'http://localhost:3000');
  assert.equal(helpers.normalizeBackendUrl('javascript:alert(1)'), null);
});

test('replacing a backend connection disconnects only when URL changes', () => {
  const helpers = loadHelpers();
  let disconnected = 0;
  const oldSocket = { disconnect() { disconnected += 1; } };
  let created = 0;
  const ioFactory = url => ({ url, created: ++created });

  const kept = helpers.replaceSocket(oldSocket, 'https://a.test', 'https://a.test', ioFactory);
  assert.equal(kept.socket, oldSocket);
  assert.equal(disconnected, 0);

  const replaced = helpers.replaceSocket(oldSocket, 'https://a.test', 'https://b.test', ioFactory);
  assert.equal(disconnected, 1);
  assert.equal(replaced.socket.url, 'https://b.test');
});

test('text elements do not interpret stored markup', () => {
  const helpers = loadHelpers();
  const parent = { children: [], appendChild(child) { this.children.push(child); } };
  const documentStub = {
    createElement(tagName) {
      return { tagName, className: '', textContent: '', children: [], appendChild(child) { this.children.push(child); } };
    }
  };
  const child = helpers.appendTextElement(documentStub, parent, 'span', 'name', '<img src=x>');
  assert.equal(child.textContent, '<img src=x>');
  assert.equal(child.className, 'name');
});

test('typing display names fall back to usernames', () => {
  const helpers = loadHelpers();
  assert.equal(helpers.typingDisplayName({ username: 'alice', displayName: 'Alice' }), 'Alice');
  assert.equal(helpers.typingDisplayName({ username: 'alice' }), 'alice');
});
```

- [ ] **Step 2: Run the client smoke test and confirm the red state**

Run: `node --test backend/test/client-smoke.test.js`

Expected: FAIL with `testable client helper block is missing`.

- [ ] **Step 3: Add inline client helpers and the success color**

Add `--success: #3ba55c` to `:root`. Near the beginning of the existing inline script, add:

```js
// TESTABLE_CLIENT_HELPERS_START
const ChatClientHelpers = (() => {
  function normalizeBackendUrl(value) {
    if (typeof value !== 'string') return null;
    let candidate = value.trim();
    if (!candidate) return null;
    if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      return parsed.origin + parsed.pathname.replace(/\/$/, '');
    } catch {
      return null;
    }
  }

  function replaceSocket(currentSocket, currentUrl, nextUrl, ioFactory) {
    if (currentSocket && currentUrl === nextUrl) return { socket: currentSocket, url: currentUrl, created: false };
    if (currentSocket) currentSocket.disconnect();
    return { socket: ioFactory(nextUrl), url: nextUrl, created: true };
  }

  function appendTextElement(doc, parent, tagName, className, text) {
    const element = doc.createElement(tagName);
    element.className = className;
    element.textContent = text == null ? '' : String(text);
    parent.appendChild(element);
    return element;
  }

  function typingDisplayName(data) {
    return data?.displayName || data?.username || 'Someone';
  }

  return { normalizeBackendUrl, replaceSocket, appendTextElement, typingDisplayName };
})();
globalThis.ChatClientHelpers = ChatClientHelpers;
// TESTABLE_CLIENT_HELPERS_END
```

Track `let socketUrl = null`. In authentication, use `normalizeBackendUrl`; show `Enter a valid HTTP(S) backend URL.` on null. Call `replaceSocket(socket, socketUrl, url, io)`, assign both returned values, and call `setupSocket()` only when `created` is true.

- [ ] **Step 4: Recover authentication controls after connection failure**

Create an inline `setAuthPending(pending, message)` function that sets `authBtn.disabled = pending` and sets the status text only when `message` is provided. The `connect_error` handler must call `setAuthPending(false, 'Unable to connect. Check the backend URL and try again.')`. All acknowledgement callbacks must start with:

```js
const response = res || { error: 'No response from server.' };
```

Read `response.error` and other fields after this guard.

- [ ] **Step 5: Replace untrusted HTML interpolation with DOM construction**

Use `appendTextElement` or direct `textContent` in these exact paths:

- server icon tooltip and server title;
- online user display name, ghost label, badges, avatar fallback, and context-menu header;
- deleted-message author label;
- reply author and reply text;
- reply/edit info bar labels.

Keep `innerHTML` only for constant application markup or the output of `formatMessageText`, which escapes input before adding allowed formatting. Create `<img>` elements with `img.src = validatedUrl`; do not construct image markup strings containing `avatarUrl`, display names, or colors.

Build the server title with a text node plus separately created badge and ghost nodes. Build deleted-message rows with icon and label text nodes. Build reply context with a `.reply-author` span whose `textContent` is `@${displayname}` and a `.reply-text` span whose `textContent` is the stored reply text after converting trusted ping tokens to visible `@name` text.

- [ ] **Step 6: Make room switching acknowledgement-driven**

Capture `previousCode = currentServerCode` and do not assign `currentServerCode = code` before emitting. In the callback:

```js
const response = res || { error: 'No response from server.' };
if (response.error) {
  showAppAlert('Error', response.error);
  renderActiveServer(previousCode);
  return;
}
currentServerCode = code;
renderActiveServer(code);
```

Move header-button state, title rendering, history clearing, typing-state clearing, and `cancelAction()` behind a successful acknowledgement. Extract `renderActiveServer(code)` inside `chat.html` to update `.active` classes without changing server state.

- [ ] **Step 7: Correct typing-name rendering**

Store `typingUsers.set(data.username, ChatClientHelpers.typingDisplayName(data))`. Keep the existing single-user and multiple-user wording.

- [ ] **Step 8: Run frontend tests and syntax checks**

Run:

```bash
npm test --prefix backend
sed -n '/<script>/,/<\/script>/p' chat.html | sed '1d;$d' | node --check -
```

Expected: all tests PASS; inline script syntax exits 0.

- [ ] **Step 9: Commit Task 4**

```bash
git add chat.html backend/test/client-smoke.test.js
git commit -m "fix: harden single-file chat client"
```

---

### Task 5: Document startup requirements and perform the complete audit

**Files:**
- Create: `backend/README.md`
- Modify: `backend/test/server-wiring.test.js`
- Verify: `backend/server.js`
- Verify: `chat.html`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: deployment instructions and final regression evidence.

- [ ] **Step 1: Add final credential and single-frontend regression assertions**

Append to `backend/test/server-wiring.test.js`:

```js
test('only one production frontend file exists', () => {
  const root = path.join(__dirname, '..', '..');
  const productionFrontendFiles = fs.readdirSync(root)
    .filter(name => /\.(?:html|css|js)$/i.test(name));
  assert.deepEqual(productionFrontendFiles, ['chat.html']);
});

test('server source contains no password literal passed to bcrypt', () => {
  assert.doesNotMatch(source, /bcrypt\.hash\(\s*['"][^'"]+['"]/);
});
```

- [ ] **Step 2: Run the final assertions and confirm their state**

Run: `npm test --prefix backend`

Expected: PASS if prior tasks are complete. If either new assertion fails, correct the production file responsible before continuing.

- [ ] **Step 3: Document environment and startup behavior**

Create `backend/README.md` containing:

````markdown
# Chat backend

## Environment

- `MONGO_URI` is required for database-backed chat operations.
- `PORT` is optional and defaults to `3000`.
- `ADMIN_PASSWORD` is optional. When set to 6–128 characters, startup creates the `NYZhang1` owner only if that account does not already exist. Startup never overwrites an existing password.

## Commands

```bash
npm install
npm test
npm start
```
````

- [ ] **Step 4: Run full automated verification**

Run:

```bash
npm test --prefix backend
node --check backend/server.js
node --check backend/lib/chat-security.js
sed -n '/<script>/,/<\/script>/p' chat.html | sed '1d;$d' | node --check -
git diff --check 94f9669..HEAD
```

Expected: every test passes, every syntax check exits 0, and `git diff --check` prints nothing.

- [ ] **Step 5: Run final security and protocol scans**

Run:

```bash
rg -n "DragonNYZ0924|bcrypt\.hash\(['\"]|replyTo: replyTo|io\.to\(socket\.serverCode\)\.emit\('message_edited'" backend chat.html
rg -n "socket\.on\(|socket\.emit\(" backend/server.js chat.html
rg -n "innerHTML\s*=.*\$\{" chat.html
git status --short
git diff --stat 94f9669..HEAD
```

Expected:

- the credential and known-vulnerability scan returns no matches;
- every client-emitted event still has a server handler and every server-emitted event used by the UI still has a client handler;
- remaining interpolated `innerHTML` assignments contain only constants or formatter-produced escaped markup;
- `git status` shows only the three intended `Zone.Identifier` deletions before the documentation commit;
- `chat.html` remains the only production frontend file.

- [ ] **Step 6: Commit Task 5**

```bash
git add backend/README.md backend/test/server-wiring.test.js
git commit -m "docs: document secure chat startup"
```

- [ ] **Step 7: Review the complete implementation diff**

Run:

```bash
git log --oneline --decorate -6
git diff --stat 94f9669..HEAD
git diff --check 94f9669..HEAD
git status --short
```

Expected: five focused implementation commits after design commit `94f9669`; no whitespace errors; only the user's three metadata deletions remain unstaged.

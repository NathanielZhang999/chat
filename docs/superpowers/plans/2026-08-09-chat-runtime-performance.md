# Chat Runtime Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the AutoMod settings controls and reduce MongoDB, Socket.IO, and browser layout work without changing chat features or visible behavior.

**Architecture:** Keep the existing single-file client and single-process Node backend. Add only query-matching schema indexes and lean reads on the server, remove one provably redundant presence publication, and introduce small pure client helpers for history policy and edge-triggered typing state so performance behavior is deterministic and testable.

**Tech Stack:** Node.js, Express, Socket.IO, Mongoose/MongoDB, browser JavaScript/CSS, `node:test`.

## Global Constraints

- Production architecture remains exactly `chat.html`, `backend/server.js`, and `backend/package.json`; no production file or dependency is added.
- Do not restore message pagination or search, alter the 100-message initial history, change attachment handling, add caches, reorder account/room locks, or tune the Mongo connection pool.
- Preserve permissions, moderation, message payloads, room history ordering, visible typing semantics, animations, and scroll behavior.
- Preserve compatibility with missing/null legacy Global `serverCode` values.
- Root-level untracked `node_modules/`, `package.json`, and `package-lock.json` are user-owned and must remain untouched and unstaged.
- Every task follows RED → GREEN, receives spec-compliance review and code-quality review, and commits only its declared files.

---

### Task 1: Optimize Mongo Queries and Room-Switch Presence

**Files:**
- Modify: `backend/server.js:616-625,728-745,787-825,2964-3077,3476-3515`
- Test: `backend/test/room-lifecycle.test.js:1-70,1019-1055`

**Interfaces:**
- Consumes: existing `UserSchema`, `MessageSchema`, `resolvePings`, `createConnectionHandler`, and injected `broadcastOnlineUsersFn`.
- Produces: exported `UserSchema`, `MessageSchema`, and `resolvePings`; `resolvePings(text, serverCode, senderRole, senderRoomRole, senderUsername, UserModel = User) -> Promise<string>`; indexes `{ servers: 1 }` and `{ serverCode: 1, timestamp: -1, _id: -1 }`.

- [ ] **Step 1: Write failing schema-index and lean-query tests**

Extend the server import and add these tests to `backend/test/room-lifecycle.test.js`:

```js
const {
  createConnectionHandler, seedSystem, withAccountTransitionLock,
  UserSchema, MessageSchema, resolvePings
} = require('../server');

test('room membership and private history schemas declare query-matching indexes once', () => {
  const userIndexes = UserSchema.indexes().filter(([keys]) => keys.servers === 1);
  const messageIndexes = MessageSchema.indexes().filter(([keys]) =>
    keys.serverCode === 1 && keys.timestamp === -1 && keys._id === -1
  );
  assert.equal(userIndexes.length, 1);
  assert.equal(messageIndexes.length, 1);
  assert.deepEqual(userIndexes[0][0], { servers: 1 });
  assert.deepEqual(messageIndexes[0][0], { serverCode: 1, timestamp: -1, _id: -1 });
});

test('mention resolution uses the exact membership projection and a lean query', async () => {
  const calls = [];
  const UserModel = {
    find(query, projection) {
      calls.push({ query, projection });
      return {
        async lean() {
          calls.push({ lean: true });
          return [
            { username: 'alice', displayName: 'Alice Smith' },
            { username: 'ali', displayName: 'Ali' }
          ];
        }
      };
    }
  };
  const result = await resolvePings(
    'Hi @ALICE SMITH and @ali', 'ABC123', 'user', 'user', 'bob', UserModel
  );
  assert.deepEqual(calls, [
    { query: { servers: 'ABC123' }, projection: 'username displayName' },
    { lean: true }
  ]);
  assert.equal(result, 'Hi {{PING:alice|Alice Smith}} and {{PING:ali|Ali}}');
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
node --test --test-name-pattern='query-matching indexes|exact membership projection' backend/test/room-lifecycle.test.js
```

Expected: both new tests fail because the schemas and resolver are not exported, the indexes are missing, and the resolver cannot receive an injected model or call `.lean()`.

- [ ] **Step 3: Add the indexes and lean resolver implementation**

In `backend/server.js`, add the schema declarations before model creation:

```js
UserSchema.index({ servers: 1 });
const User = mongoose.model('User', UserSchema);

MessageSchema.index({ serverCode: 1, timestamp: -1, _id: -1 });
const Message = mongoose.model('Message', MessageSchema);
```

Change the resolver signature and membership lookup only:

Replace the current declaration with this exact declaration; do not change the function body except for the query line that follows:

```js
async function resolvePings(text, serverCode, senderRole, senderRoomRole, senderUsername, UserModel = User) {
```

Leave every statement in the existing function in place except for this one query substitution:

```js
const roomUsers = await UserModel.find(
  { servers: serverCode },
  'username displayName'
).lean();
```

Add these properties to the existing `module.exports` object without removing or renaming any current property:

```js
UserSchema,
MessageSchema,
resolvePings,
```

- [ ] **Step 4: Run the focused index/resolver tests and confirm GREEN**

Run the Step 2 command. Expected: both selected tests pass, including the mixed-case and longest-name mention result.

- [ ] **Step 5: Write a failing room-switch broadcast matrix**

Replace the existing expectation that always includes `broadcast:global` and drive these real-handler scenarios:

```js
test('room switching acknowledges first and publishes only affected private presence', async () => {
  const scenarios = [
    { oldCode: 'OLD123', targetCode: 'ABC123', expected: ['OLD123', 'ABC123'] },
    { oldCode: 'global', targetCode: 'ABC123', expected: ['ABC123'] },
    { oldCode: 'OLD123', targetCode: 'global', expected: ['OLD123'] },
    { oldCode: 'ABC123', targetCode: 'ABC123', expected: ['ABC123'] },
    { oldCode: 'global', targetCode: 'global', expected: [] }
  ];

  for (const scenario of scenarios) {
    const events = [];
    const onlineUsersMap = new Map([['socket-1', {
      username: 'alice', serverCode: scenario.oldCode,
      joinedServers: ['global', 'OLD123', 'ABC123']
    }]]);
    const ChatServerModel = {
      findOne: query => queryResult({ code: query.code, moderators: [] })
    };
    const MessageModel = { find: () => queryResult([]) };
    const { socket } = register({
      ChatServerModel, MessageModel, onlineUsersMap,
      broadcastOnlineUsersFn: code => events.push(`broadcast:${code}`)
    });
    Object.assign(socket, {
      username: 'alice', role: 'user', serverCode: scenario.oldCode,
      joinedServers: ['global', 'OLD123', 'ABC123']
    });
    socket.joinedRooms.add(scenario.oldCode);

    await socket.trigger('switch_server', scenario.targetCode, () => events.push('ack'));
    assert.deepEqual(events, ['ack', ...scenario.expected.map(code => `broadcast:${code}`)]);
  }
});
```

- [ ] **Step 6: Run the switch matrix and confirm RED**

Run:

```bash
node --test --test-name-pattern='publishes only affected private presence' backend/test/room-lifecycle.test.js
```

Expected: each applicable case includes an extra `broadcast:global` under the current implementation.

- [ ] **Step 7: Remove only the redundant Global switch broadcast**

Replace the post-ack broadcast construction in `switch_server` with:

```js
const broadcastCodes = [];
if (result.oldCode && result.oldCode !== serverCode && result.oldCode !== 'global') {
  broadcastCodes.push(result.oldCode);
}
if (serverCode !== 'global') broadcastCodes.push(serverCode);
[...new Set(broadcastCodes)].forEach(broadcastCode => {
  try {
    Promise.resolve(broadcastOnlineUsersFn(broadcastCode)).catch(err => {
      logUnexpectedError(logger, 'switch_server_presence_broadcast', err);
    });
  } catch (err) {
    logUnexpectedError(logger, 'switch_server_presence_broadcast', err);
  }
});
```

Do not move the acknowledgement or change broadcasts in login, disconnect, profile, moderation, join, leave, or deletion handlers.

- [ ] **Step 8: Run Task 1 verification**

Run:

```bash
node --test --test-name-pattern='query-matching indexes|exact membership projection|publishes only affected private presence' backend/test/room-lifecycle.test.js
node backend/test/room-lifecycle.test.js
node backend/test/message-actions.test.js
node --check backend/server.js
git diff --check
```

Expected: all commands pass. Confirm no history limit/order, Global legacy query, login/disconnect presence, or payload code changed.

- [ ] **Step 9: Commit Task 1**

```bash
git add -- backend/server.js backend/test/room-lifecycle.test.js
git commit -m "perf: optimize room queries and presence"
```

The task report must note that schema declaration is verified locally but Atlas execution plans require post-deploy inspection. If a safe configured Atlas shell is available, run the following read-only check; otherwise include it verbatim in the final handoff:

```bash
mongosh "$MONGO_URI" --quiet --eval 'const room=db.chatservers.findOne({code:{$ne:"global"}}); printjson(db.users.getIndexes()); printjson(db.messages.getIndexes()); if(room){printjson(db.messages.find({serverCode:room.code}).sort({timestamp:-1}).limit(100).explain("executionStats")); printjson(db.users.find({servers:room.code},{username:1,displayName:1}).explain("executionStats"));} printjson(db.messages.find({$or:[{serverCode:"global"},{serverCode:{$exists:false}},{serverCode:null}]}).sort({timestamp:-1}).limit(100).explain("executionStats"));'
```

---

### Task 2: Align AutoMod Controls and Eliminate History Layout Reads

**Files:**
- Modify: `chat.html:40-55,534-551,620-1340,3261-3275`
- Test: `backend/test/client-smoke.test.js:1-140`

**Interfaces:**
- Consumes: `ChatClientHelpers.isNearScrollEnd`, `messageRenderPolicy`, `chatScrollCoordinator`, and `appendMessage`.
- Produces: CSS class `.automod-limits-grid`; `ChatClientHelpers.messageRenderPolicyForElement(element, { history }) -> policy`; `ChatClientHelpers.renderHistoryMessages(messages, { append, isMine, requestScroll }) -> number`.

- [ ] **Step 1: Write failing AutoMod layout tests**

Extend the existing exact title/control test:

```js
test('browser title and AutoMod message-rate controls are exact and aligned', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /<title>Chat v1\.3\.2<\/title>/);
  assert.match(source, /\.automod-limits-grid\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(170px,\s*1fr\)\)[^}]*gap:\s*10px[^}]*align-items:\s*end/s);
  const panelStart = source.indexOf('<section id="moderator-panel-automod"');
  const panelEnd = source.indexOf('</section>', panelStart);
  assert.notEqual(panelStart, -1);
  assert.ok(panelEnd > panelStart);
  const panel = source.slice(panelStart, panelEnd);
  assert.match(panel, /<div class="automod-limits-grid">/);
  assert.doesNotMatch(panel, /minmax\(130px,\s*1fr\)/);
  const controls = [
    ['automod-mention-limit', 'Mention limit (1–20)', '1', '20'],
    ['automod-repeat-limit', 'Repeat limit (2–10)', '2', '10'],
    ['automod-repeat-window', 'Window seconds (5–300)', '5', '300'],
    ['automod-message-limit', 'Message limit (1–20)', '1', '20'],
    ['automod-message-window', 'Window seconds (1–60)', '1', '60']
  ];
  let previousIndex = -1;
  for (const [id, label, min, max] of controls) {
    const labelIndex = panel.indexOf(`<label for="${id}">${label}</label>`);
    const inputPattern = new RegExp(`id="${id}"[^>]*min="${min}"[^>]*max="${max}"`);
    assert.ok(labelIndex > previousIndex, `${id} label is present in order`);
    assert.match(panel.slice(labelIndex), inputPattern);
    previousIndex = labelIndex;
  }
});
```

- [ ] **Step 2: Write failing measurable history-render tests**

Add pure helper coverage:

```js
test('history rendering skips layout measurements and performs one final scroll', () => {
  const helpers = loadHelpers();
  let measurements = 0;
  const scroller = {
    get scrollHeight() { measurements += 1; return 1_000; },
    get scrollTop() { measurements += 1; return 600; },
    get clientHeight() { measurements += 1; return 320; }
  };
  const rows = Array.from({ length: 100 }, (_, index) => ({ _id: String(index), username: 'alice' }));
  const appended = [];
  const scrolls = [];

  const count = helpers.renderHistoryMessages(rows, {
    append(message, isMe, options) {
      appended.push({ message, isMe, options: { ...options } });
      helpers.messageRenderPolicyForElement(scroller, options);
    },
    isMine: message => message.username === 'alice',
    requestScroll: behavior => scrolls.push(behavior)
  });

  assert.equal(count, 100);
  assert.equal(appended.length, 100);
  assert.equal(appended.every(item => item.isMe && item.options.history === true), true);
  assert.equal(measurements, 0);
  assert.deepEqual(scrolls, ['auto']);

  const livePolicy = helpers.messageRenderPolicyForElement(scroller, { history: false });
  assert.equal(measurements, 3);
  assert.deepEqual({ ...livePolicy }, { animate: true, shouldScroll: true, behavior: 'smooth' });
});
```

Add a narrow production-wiring assertion:

```js
test('production history path uses the measured helper boundary', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /function loadHistory\(msgs\)[\s\S]{0,500}ChatClientHelpers\.renderHistoryMessages/);
  assert.match(source, /function appendMessage\([\s\S]{0,500}ChatClientHelpers\.messageRenderPolicyForElement\(chatWindow,\s*\{ history \}\)/);
});
```

- [ ] **Step 3: Run focused client tests and confirm RED**

Run:

```bash
node --test --test-name-pattern='exact and aligned|skips layout measurements|measured helper boundary' backend/test/client-smoke.test.js
```

Expected: layout class and both helper interfaces are absent.

- [ ] **Step 4: Implement the scoped AutoMod grid**

Add this rule near the existing `.input-group` styles:

```css
.automod-limits-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 10px;
    align-items: end;
}
```

Replace only the numeric-control wrapper's inline style:

```html
<div class="automod-limits-grid">
```

Keep all five existing `.input-group` children, label text, IDs, order, `min`, and `max` values unchanged.

- [ ] **Step 5: Implement the history measurement boundary**

Add these methods inside the delimited `ChatClientHelpers` object:

```js
messageRenderPolicyForElement(element, { history = false } = {}) {
    return this.messageRenderPolicy({
        history,
        wasNearBottom: history ? false : this.isNearScrollEnd(element)
    });
},

renderHistoryMessages(messages, { append, isMine, requestScroll } = {}) {
    if (!Array.isArray(messages) || typeof append !== 'function' ||
        typeof isMine !== 'function' || typeof requestScroll !== 'function') return 0;
    messages.forEach(message => append(message, Boolean(isMine(message)), { history: true }));
    requestScroll('auto');
    return messages.length;
},
```

Wire production through the helpers:

```js
function loadHistory(msgs) {
    ChatClientHelpers.renderHistoryMessages(msgs, {
        append: appendMessage,
        isMine: message => message.username === myUsername,
        requestScroll: behavior => chatScrollCoordinator.request(behavior)
    });
}

function appendMessage(data, isMe, { history = false } = {}) {
    const renderPolicy = ChatClientHelpers.messageRenderPolicyForElement(
        chatWindow,
        { history }
    );
}
```

Only replace the existing `renderPolicy` initialization shown above; leave every subsequent DOM-construction statement in `appendMessage` unchanged.

- [ ] **Step 6: Run Task 2 verification**

Run:

```bash
node --test --test-name-pattern='exact and aligned|skips layout measurements|measured helper boundary|scroll policy' backend/test/client-smoke.test.js
node backend/test/client-smoke.test.js
npm test --prefix backend
git diff --check
```

Expected: all commands pass; 100 history rows produce zero layout reads and one final scroll, while the live-message policy still reads the three scroll properties once.

- [ ] **Step 7: Commit Task 2**

```bash
git add -- chat.html backend/test/client-smoke.test.js
git commit -m "perf: align automod and streamline history rendering"
```

---

### Task 3: Make Typing Notifications Edge-Triggered

**Files:**
- Modify: `chat.html:620-790,1420-1550,2328-2440,2925-3165`
- Test: `backend/test/client-smoke.test.js:160-220,1100-1220`

**Interfaces:**
- Consumes: exact current socket reference and `compositionContextCoordinator.current()` returning `{ roomCode, clientContextId }`.
- Produces: `ChatClientHelpers.createTypingCoordinator({ schedule, cancel, getSocket, getContext, delay }) -> { input(), submit(), clear(), current() }`.

- [ ] **Step 1: Write failing edge-trigger and boundary tests**

Add a deterministic scheduler and the primary count test:

```js
test('typing coordinator emits one start and one idle stop for one hundred inputs', () => {
  const helpers = loadHelpers();
  let nextTimer = 0;
  const timers = new Map();
  const emitted = [];
  const socket = {
    connected: true,
    emit(event, payload) { emitted.push({ event, payload: { ...payload } }); }
  };
  const context = { roomCode: 'ABC123', clientContextId: 7 };
  const typing = helpers.createTypingCoordinator({
    schedule(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    cancel(id) { timers.delete(id); },
    getSocket: () => socket,
    getContext: () => ({ ...context }),
    delay: 1_500
  });

  for (let index = 0; index < 100; index += 1) assert.equal(typing.input(), true);
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], {
    event: 'typing',
    payload: { serverCode: 'ABC123', clientContextId: 7, isTyping: true }
  });
  assert.equal(timers.size, 1);
  const idle = [...timers.values()][0];
  assert.equal(idle.delay, 1_500);
  idle.callback();
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].payload.isTyping, false);
  assert.equal(typing.current().active, false);
  typing.input();
  assert.equal(emitted.filter(item => item.payload.isTyping).length, 2);
});
```

Add submit and socket/context invalidation coverage:

```js
test('typing submit is ordered once and stale socket timers cannot emit', () => {
  const helpers = loadHelpers();
  const callbacks = [];
  const canceled = [];
  const events = [];
  let context = { roomCode: 'ABC123', clientContextId: 2 };
  const oldSocket = { connected: true, emit(event, payload) { events.push({ source: 'old', event, payload }); } };
  const newSocket = { connected: true, emit(event, payload) { events.push({ source: 'new', event, payload }); } };
  let socket = oldSocket;
  const typing = helpers.createTypingCoordinator({
    schedule(callback) { callbacks.push(callback); return callbacks.length; },
    cancel(id) { canceled.push(id); },
    getSocket: () => socket,
    getContext: () => ({ ...context })
  });

  typing.input();
  oldSocket.emit('chat_message', { text: 'sent' });
  assert.equal(typing.submit(), true);
  assert.deepEqual(events.map(item => `${item.event}:${item.payload.isTyping}`), [
    'typing:true', 'chat_message:undefined', 'typing:false'
  ]);
  assert.equal(typing.submit(), false, 'no duplicate false without an active start');

  typing.input();
  const staleSameEpisodeTimer = callbacks.at(-1);
  typing.input();
  const currentSameEpisodeTimer = callbacks.at(-1);
  staleSameEpisodeTimer();
  assert.equal(typing.current().active, true);
  assert.equal(typing.current().timerPending, true);
  assert.equal(events.filter(item => item.payload.isTyping === false).length, 1);

  const staleRoomTimer = currentSameEpisodeTimer;
  typing.clear();
  socket = newSocket;
  context = { roomCode: 'BBB222', clientContextId: 3 };
  typing.input();
  staleRoomTimer();
  assert.equal(typing.current().active, true);
  assert.equal(typing.current().timerPending, true);
  assert.equal(events.filter(item => item.source === 'new' && item.payload.isTyping === false).length, 0);
  assert.equal(events.filter(item => item.source === 'old' && item.payload.isTyping === false).length, 1);
  assert.ok(canceled.length >= 2);

  typing.clear();
  const eventCount = events.length;
  newSocket.connected = false;
  assert.equal(typing.input(), false);
  newSocket.connected = true;
  context = { roomCode: null, clientContextId: 4 };
  assert.equal(typing.input(), false);
  assert.equal(events.length, eventCount, 'invalid socket or room fails closed');
});
```

- [ ] **Step 2: Write failing production-wiring assertions**

Add a test that extracts the named production blocks and requires all boundaries:

```js
test('production typing wiring uses the coordinator at every lifecycle boundary', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /const typingCoordinator = ChatClientHelpers\.createTypingCoordinator\(/);
  assert.match(source, /msgInput\.addEventListener\(['"]input['"],\s*\(\)\s*=>\s*\{[\s\S]{0,300}typingCoordinator\.input\(\)/);
  assert.match(source, /document\.getElementById\(['"]compose['"]\)[\s\S]{0,1800}socket\.emit\(['"]chat_message['"][\s\S]{0,500}typingCoordinator\.submit\(\)/);
  for (const boundary of ['enterLobby', 'requestServerSwitch', 'logoutApp']) {
    const start = source.indexOf(`function ${boundary}`);
    const end = source.indexOf('\n    function ', start + 1);
    assert.notEqual(start, -1, boundary);
    assert.match(source.slice(start, end === -1 ? source.length : end), /typingCoordinator\.clear\(\)/, boundary);
  }
  assert.match(source, /const previousSocket = socket;[\s\S]{0,300}replaceSocket[\s\S]{0,300}if \(socket !== previousSocket\)\s*\{[\s\S]{0,120}typingCoordinator\.clear\(\)/);
  assert.match(source, /activeSocket\.on\(['"]force_logout['"][\s\S]{0,200}typingCoordinator\.clear\(\)/);
  assert.match(source, /activeSocket\.on\(['"]global_role_updated['"][\s\S]{0,700}typingCoordinator\.clear\(\)[\s\S]{0,120}roomSwitchCoordinator\.request\(currentServerCode\)/);
  assert.match(source, /activeSocket\.on\(['"]room_role_updated['"][\s\S]{0,500}typingCoordinator\.clear\(\)[\s\S]{0,120}roomSwitchCoordinator\.request\(currentServerCode\)/);
  assert.doesNotMatch(source, /let typingTimeout|clearTimeout\(typingTimeout\)/);
});
```

- [ ] **Step 3: Run focused tests and confirm RED**

Run:

```bash
node --test --test-name-pattern='typing coordinator|production typing wiring' backend/test/client-smoke.test.js
```

Expected: the coordinator factory and production wiring are absent.

- [ ] **Step 4: Implement the pure typing coordinator**

Add this method to `ChatClientHelpers`:

```js
createTypingCoordinator({
    schedule = (callback, wait) => setTimeout(callback, wait),
    cancel = timerId => clearTimeout(timerId),
    getSocket,
    getContext,
    delay = 1_500
} = {}) {
    let timerId = null;
    let timerGeneration = 0;
    let active = null;
    const clearTimer = () => {
        if (timerId !== null) cancel(timerId);
        timerId = null;
        timerGeneration += 1;
    };
    const readToken = () => {
        const activeSocket = typeof getSocket === 'function' ? getSocket() : null;
        const context = typeof getContext === 'function' ? getContext() : null;
        if (!activeSocket || !activeSocket.connected || !context || !context.roomCode ||
            !Number.isSafeInteger(context.clientContextId) || context.clientContextId <= 0) return null;
        return Object.freeze({
            socket: activeSocket,
            serverCode: context.roomCode,
            clientContextId: context.clientContextId
        });
    };
    const isCurrent = token => {
        const current = readToken();
        return Boolean(current && token && current.socket === token.socket &&
            current.serverCode === token.serverCode &&
            current.clientContextId === token.clientContextId);
    };
    const sameEpisode = (left, right) => Boolean(left && right &&
        left.socket === right.socket && left.serverCode === right.serverCode &&
        left.clientContextId === right.clientContextId);
    const payload = (token, isTyping) => ({
        serverCode: token.serverCode,
        clientContextId: token.clientContextId,
        isTyping
    });
    const clear = () => {
        clearTimer();
        active = null;
    };
    const stop = () => {
        const token = active;
        clear();
        if (!token || !isCurrent(token)) return false;
        token.socket.emit('typing', payload(token, false));
        return true;
    };
    return {
        input() {
            const token = readToken();
            if (!token) { clear(); return false; }
            if (!sameEpisode(active, token)) {
                clear();
                active = token;
                token.socket.emit('typing', payload(token, true));
            }
            clearTimer();
            const scheduledToken = active;
            const scheduledGeneration = timerGeneration;
            timerId = schedule(() => {
                if (scheduledGeneration !== timerGeneration || active !== scheduledToken) return;
                timerId = null;
                stop();
            }, delay);
            return true;
        },
        submit: stop,
        clear,
        current() {
            return { active: Boolean(active), timerPending: timerId !== null };
        }
    };
},
```

- [ ] **Step 5: Wire all production lifecycle boundaries**

Create one coordinator after `compositionContextCoordinator`:

```js
const typingCoordinator = ChatClientHelpers.createTypingCoordinator({
    getSocket: () => socket,
    getContext: () => compositionContextCoordinator.current()
});
```

Remove `let typingTimeout` and the existing per-input timer implementation. Replace the input listener body with the existing access guard followed by `typingCoordinator.input()`.

After a valid `edit_message` or `chat_message` emit in the compose submit handler, call `typingCoordinator.submit()` in the same synchronous turn. Do not call it for `/clear`, invalid input, missing socket, or any path that returns before an emit.

Call `typingCoordinator.clear()`:

- at the beginning of `enterLobby`, before composition invalidation;
- in `requestServerSwitch` after the same-room/no-pending early return and before `roomSwitchCoordinator.request(code)`;
- after logout confirmation and before removing storage/reloading;
- inside the existing `if (socket !== previousSocket)` block immediately after replacement and before composition/privilege invalidation, so submitting the same URL does not clear a live episode;
- at the start of the active socket's `force_logout` handler.

The `global_role_updated` and `room_role_updated` handlers intentionally call `roomSwitchCoordinator.request(currentServerCode)` directly to force a same-room refresh. Insert `typingCoordinator.clear()` immediately before those two direct calls; do not route them through `requestServerSwitch`, whose same-room fast path would suppress the required refresh.

Do not emit a new cross-room stop packet or change backend typing authorization.

Update the existing `production client invalidates revoked access and sends every room mutation with context` smoke test so its direct `compositionContextCoordinator.payload(...)` source loop covers only `chat_message`, `edit_message`, `toggle_reaction`, and `delete_message`. Typing context is now proven by the executable coordinator tests and the dedicated production-wiring test above.

- [ ] **Step 6: Run Task 3 verification**

Run:

```bash
node --test --test-name-pattern='typing coordinator|production typing wiring|typing display|composition context' backend/test/client-smoke.test.js
node backend/test/client-smoke.test.js
node backend/test/message-actions.test.js
npm test --prefix backend
git diff --check
```

Expected: all commands pass. Inspect the event-count test to confirm 100 input events produce one start and one idle stop, submit produces no duplicate stop, and an old timer cannot emit through a replacement socket.

- [ ] **Step 7: Commit Task 3**

```bash
git add -- chat.html backend/test/client-smoke.test.js
git commit -m "perf: reduce typing event traffic"
```

---

### Task 4: Whole-Branch Release Gate and Publication Readiness

**Files:**
- Verify: `backend/server.js`
- Verify: `chat.html`
- Verify: `backend/test/room-lifecycle.test.js`
- Verify: `backend/test/client-smoke.test.js`
- Report only: `.superpowers/sdd/2026-08-09-chat-runtime-performance/final-report.md` (ignored scratch artifact)

**Interfaces:**
- Consumes: the three task commits and the approved design.
- Produces: verified release evidence, independent whole-branch review, and a branch ready to merge and push.

- [ ] **Step 1: Run the complete functional gate**

```bash
npm test --prefix backend
node --check backend/server.js
```

Expected: all five backend test files pass and server syntax is valid.

- [ ] **Step 2: Compile every inline client script**

Run:

```bash
node -e "const fs=require('fs'),vm=require('vm');const html=fs.readFileSync('chat.html','utf8');const blocks=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).filter(s=>s.trim()&&!/\bsrc\s*=/.test(s));blocks.forEach((s,i)=>new vm.Script(s,{filename:'chat-inline-'+i+'.js'}));console.log('compiled',blocks.length,'inline scripts')"
```

Expected: every inline script compiles with no exception.

- [ ] **Step 3: Check HTML IDs, diff hygiene, scope, and secrets**

Run:

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('chat.html','utf8');const ids=[...s.matchAll(/\bid=\"([^\"]+)\"/g)].map(m=>m[1]);const dup=ids.filter((id,i)=>ids.indexOf(id)!==i);if(dup.length)throw new Error('duplicate ids: '+[...new Set(dup)].join(','));console.log(ids.length,'unique ids')"
git diff --check 58d5994..HEAD
git diff --name-only 58d5994..HEAD
node -e "const fs=require('fs');const files=['backend/server.js','chat.html','backend/test/room-lifecycle.test.js','backend/test/client-smoke.test.js'];const pattern=/gho_[A-Za-z0-9]+|mongodb\\+srv:\/\/[^\\s]+:[^\\s]+@|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/;const hits=files.filter(file=>pattern.test(fs.readFileSync(file,'utf8')));if(hits.length)throw new Error('credential-like content: '+hits.join(','));console.log('credential scan clean')"
git status --short
```

Expected: no duplicate IDs; diff check passes; changed runtime/test files are confined to the declared scope plus the committed spec/plan; credential scan has no match; the worktree is otherwise clean. The three root-workspace untracked paths remain untouched whether or not they appear inside the isolated worktree.

- [ ] **Step 4: Request independent whole-branch review**

The reviewer must compare `58d5994..HEAD` to the approved design and report Critical, Important, and Minor findings for:

- index/query shape and legacy Global compatibility;
- mention matching equivalence;
- acknowledgement-before-presence ordering and every switch direction;
- history layout-read count and unchanged live scroll policy;
- AutoMod alignment across normal and narrow layouts;
- typing socket/context identity, timer cancellation, submit ordering, and every lifecycle reset;
- dependency, production-file, and feature-scope compliance.

Any Critical or Important finding receives a focused RED/GREEN fix round and a second clean review before publication.

- [ ] **Step 5: Write the final report**

Record task commits, RED/GREEN evidence, full-suite counts, syntax/inline/ID/diff/credential checks, independent review verdict, exact changed files, and the Atlas verification status in `.superpowers/sdd/2026-08-09-chat-runtime-performance/final-report.md`.

If Atlas was not safely reachable, include the read-only `mongosh` command from Task 1 and state that query-plan gains are code-evident but not measured against production data.

- [ ] **Step 6: Hand off for merge and GitHub push**

Use `superpowers:finishing-a-development-branch`. Merge the reviewed worktree branch into `main` without staging the user-owned root package paths, rerun Steps 1–3 on `main`, then push the requested deployment branch only after confirming the exact local and remote branch names.

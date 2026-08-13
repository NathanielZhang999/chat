# Invisible Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add origin, authentication, transport, and resource-abuse protections that remain invisible during normal use and safe for many users sharing one public network.

**Architecture:** `backend/server.js` gains four dependency-injected security owners: an exact-origin policy, a layered authentication limiter, a network connection admission controller, and a protected Socket.IO event dispatcher. Production wires one bounded process-global instance of each owner, while registered-handler tests inject fake clocks, addresses, bcrypt, sockets, and queries. `chat.html` remains behaviorally unchanged; its title and compatibility are release-gate assertions.

**Tech Stack:** Node.js 22, Express 4, Socket.IO 4, Mongoose 8, bcryptjs 2, Node test runner, existing in-memory test fakes. No new runtime dependency.

## Global Constraints

- Implement from feature base `fb84aab648a363f2ca05116727910d756df1795e` plus approved spec commits `f6a9b17` and `f44260d` on `feat/invisible-security-hardening`.
- Keep runtime application code in `backend/server.js` and `chat.html`; do not add another production file.
- Keep `<title>Chat v1.3.2</title>` exact.
- Preserve all current chat, moderation, AutoMod, appearance, image, and shortcut behavior.
- Do not restore room information, pins, unread indicators, notifications, blocking, search, or pagination.
- Do not add CAPTCHA, mandatory 2FA, email/SMS, passkeys, persistent login tokens, durable device sessions, IP bans, fingerprinting, Redis, or another service.
- Never log passwords, hashes, message text, attachment bytes/data URLs, complete raw payloads, authorization values, usernames in network-only events, or raw network addresses.
- Treat a network address only as a coarse abuse signal. Exact limits are: account login 30/15m, account registration 20/15m, account-plus-network 6/15m, aggregate network authentication 300/15m, connection attempts 60/minute, concurrent network sockets 100, and authenticated account sockets 8.
- Use bcrypt cost 11 for new hashes and successful migration of lower-cost hashes.
- Retain the 10,000,000-byte Socket.IO transport ceiling and existing 8,000,000-character attachment contract.
- Preserve lock order and callback lifetime: identity allocation -> account transition -> room mutation; required durable/session publication and acknowledgements stay inside their existing locks.
- Do not change `package.json`, `package-lock.json`, `backend/package.json`, or `backend/package-lock.json`.
- Every task follows RED -> minimal GREEN -> focused regression -> full relevant suite -> review -> scoped commit. Never stage the user-owned root `node_modules/`, `package.json`, or `package-lock.json`.
- Push only after the final whole-branch review and fresh release gate, normally and without force, to `origin/deploy-chat`.

## File map

- Modify `backend/server.js`: all production security helpers, production wiring, login/hash migration, connection admission, event envelopes/budgets, in-flight ownership, and Mongo read deadlines.
- Modify `backend/test/chat-security.test.js`: exact origin/header/startup policy, bounded helper contracts, payload measurement, policy allowlist, and query deadlines.
- Modify `backend/test/room-lifecycle.test.js`: registered authentication, bcrypt migration, shared-network schedules, connection/session ceilings, and privacy-safe logging.
- Modify `backend/test/message-actions.test.js`: protected event dispatcher, exact envelopes/byte limits, category budgets, duplicate in-flight work, timeout cleanup, and existing attachment compatibility.
- Modify `backend/test/moderation.test.js`: moderation read/write category budgets, duplicate reads, and query deadlines.
- Modify `backend/test/support/fakes.js`: optional middleware-aware event dispatch and `maxTimeMS()` query recording required by production-shaped tests.
- Read-only verify `chat.html`: exact title, inline compilation, static ID uniqueness, and unchanged client/server payload compatibility.

---

### Task 1: Enforce exact browser origins and HTTP security headers

**Files:**
- Modify: `backend/server.js:1-18, 3625-3653, 3655-3710`
- Modify: `backend/test/chat-security.test.js`

**Interfaces:**
- Produces: `normalizeConfiguredOrigin(value) -> string | null`
- Produces: `createOriginPolicy({ allowedOriginsValue, production, defaultOrigins? }) -> { origins, configurationError, assertValid(), allows(origin, { allowMissing? }), corsOrigin(origin, callback), allowSocketRequest(request, callback) }`
- Produces: `createSecurityHeadersMiddleware({ production }) -> (req, res, next) => void`
- Produces: `configureHttpSecurity({ appInstance, originPolicy, production })`
- Updates: `start({ validateSecurityConfigurationFn? })` to validate before Mongo or listen.

- [ ] **Step 1: Add exact failing origin and header tests**

Add these exact test names to `backend/test/chat-security.test.js`:

```js
test('origin policy accepts exact deployed and configured origins only', () => { /* table below */ });
test('origin policy permits loopback only outside production and rejects missing socket origins', () => {});
test('malformed origin configuration fails before Mongo connection and listen', async () => {});
test('Express and Socket.IO share one origin policy without a wildcard fallback', () => {});
test('security headers are exact and HSTS is production only', () => {});
```

The first table must accept `https://nathanielzhang999.github.io`, `https://chat.example.com`, and a duplicate origin with a trailing slash after normalization. It must reject `https://nathanielzhang999.github.io.evil.example`, `https://user@example.com`, `https://example.com/path`, `https://*.example.com`, `file:///tmp/chat.html`, `null`, `javascript:alert(1)`, query/fragment values, and malformed URLs. Assert rejected values never appear in callbacks or logs.

Use a fake `res` with `setHeader(name, value)` and assert these exact values: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, and `Cross-Origin-Resource-Policy: same-site`. Assert `Strict-Transport-Security` is absent in development and exactly `max-age=31536000; includeSubDomains` in production.

- [ ] **Step 2: Run the focused tests and capture RED**

Run:

```bash
node --test --test-name-pattern='origin policy|origin configuration|Express and Socket.IO|security headers' backend/test/chat-security.test.js
```

Expected: FAIL because the four interfaces are absent and the current production Socket.IO config still contains `origin: "*"`.

- [ ] **Step 3: Implement strict origin parsing and headers**

Add these constants and helpers before `app`/`io` construction, preserving `https://nathanielzhang999.github.io` as the safe deployed default:

```js
const DEFAULT_ALLOWED_ORIGINS = Object.freeze(['https://nathanielzhang999.github.io']);

function normalizeConfiguredOrigin(value) {
  if (typeof value !== 'string' || value.trim() !== value || value.includes('*')) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch { return null; }
}
```

`createOriginPolicy` must split a supplied `ALLOWED_ORIGINS` value on commas, trim entries, reject empty interior entries, normalize each entry, deduplicate it, and distinguish an unset/blank environment value (use the frozen default) from a supplied malformed entry (store `configurationError`). Development-only loopback matching is computed at request time and accepts only `http:` with hostname `localhost` or `127.0.0.1`. `corsOrigin` may allow a missing Express origin without setting CORS headers, while `allowSocketRequest` must reject a missing browser handshake origin. Both must delegate to the same `allows()` method.

Configure production once:

```js
const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
const originPolicy = createOriginPolicy({
  allowedOriginsValue: process.env.ALLOWED_ORIGINS,
  production: isProduction
});
configureHttpSecurity({ appInstance: app, originPolicy, production: isProduction });
const io = new Server(server, {
  cors: { origin: originPolicy.corsOrigin },
  allowRequest: originPolicy.allowSocketRequest,
  maxHttpBufferSize: 10_000_000
});
```

The middleware sets headers before `cors({ origin: originPolicy.corsOrigin })`. Do not add CSP because the backend does not serve the frontend.

Change `start()` so `validateSecurityConfigurationFn()` runs immediately after the missing-`MONGO_URI` check and before `mongoose.connect()`. The production default is `originPolicy.assertValid`.

- [ ] **Step 4: Run focused and complete security tests**

Run:

```bash
node --test --test-name-pattern='origin policy|origin configuration|Express and Socket.IO|security headers|start fails|start connects' backend/test/chat-security.test.js
node backend/test/chat-security.test.js
node --check backend/server.js
git diff --check
```

Expected: all pass. Inspect `backend/server.js` and require zero `origin: "*"` occurrences.

- [ ] **Step 5: Commit Task 1**

```bash
git add -- backend/server.js backend/test/chat-security.test.js
git commit -m "security: restrict browser origins"
```

---

### Task 2: Make authentication generic, migration-safe, and shared-network-safe

**Files:**
- Modify: `backend/server.js:496-554, 703-707, 993-1020, 1611-1790, 3655-3710`
- Modify: `backend/test/chat-security.test.js`
- Modify: `backend/test/room-lifecycle.test.js`

**Interfaces:**
- Consumes: `normalizeTransportAddress(socket.handshake.address)`
- Produces: `hashNetworkAddress(value, salt) -> 16-character lowercase hex bucket`
- Produces: `createLayeredAuthLimiter({ now, salt, maxEntries, policies? }) -> { attempt({ action, account, address }), success(token), prune(), size(), count(key) }`
- Produces: `bcryptCost(value, bcryptImpl) -> non-negative integer | null`
- Produces: `createDummyPasswordHash({ bcryptImpl, cost }) -> Promise<string>` for constructing the process dummy hash once before accepting connections.
- Extends: `createConnectionHandler({ authLimiter, dummyPasswordHash, passwordHashCost })`.

- [ ] **Step 1: Add helper and registered-handler RED tests**

Add exact tests:

```js
test('layered authentication limits exact account pair and network boundaries without extending rejection', () => {});
test('layered authentication state bounds the union of all key types and evicts oldest deterministically', () => {});
test('network buckets are salted bounded and never expose raw addresses', () => {});
test('unknown and wrong-password login share one error and one comparison boundary', async () => {});
test('successful legacy bcrypt login upgrades to cost eleven before acknowledgement', async () => {});
test('current and stronger bcrypt hashes are not rewritten', async () => {});
test('bcrypt migration failure publishes no authenticated state', async () => {});
test('shared networks allow many valid accounts while isolating one attacked account', async () => {});
test('one successful account does not reset aggregate network abuse state', async () => {});
test('authentication acknowledgements and logs redact passwords hashes and raw network addresses', async () => {});
```

Use a fake clock. Exercise exact pair attempt 6 accepted / 7th rejected, login account attempt 30 accepted across distinct injected network addresses / 31st rejected, registration account 20/21, aggregate network 300/301, and exact expiry at 15 minutes. After a rejection, advance to the original oldest timestamp boundary and prove acceptance; a rejected attempt must not move the boundary.

The shared-network registered-handler matrix creates at least 40 distinct valid accounts on one address and proves all can log in. Separately issue seven bad attempts for one account/address pair and prove a different valid account on that address still succeeds.

The bcrypt double records `compare`, `getRounds`, `hash`, and `save` order. The upgrade assertion is `compare -> locked reload/compare -> hash(11) -> save -> session publication -> ack`.

- [ ] **Step 2: Run the authentication RED set**

Run:

```bash
node --test --test-name-pattern='layered authentication|network buckets|wrong-password|bcrypt|shared networks|aggregate network|authentication acknowledgements' backend/test/chat-security.test.js backend/test/room-lifecycle.test.js
```

Expected: FAIL because layered throttling, dummy comparison, generic errors, and hash migration do not exist. The existing handler returns `User not found.` for an unknown account and `Incorrect password.` for a wrong password.

- [ ] **Step 3: Implement the union-bounded layered limiter**

Use one insertion-ordered `Map` for all bucket types. A single attempt computes these keys without retaining the raw address:

```js
const accountKey = `${action}:account:${normalizeAccountKey(account)}`;
const pairKey = `${action}:pair:${normalizeAccountKey(account)}:${networkBucket}`;
const networkKey = `${action}:network:${networkBucket}`;
```

Policies are exactly:

```js
const AUTH_POLICIES = Object.freeze({
  login: Object.freeze({ account: 30, pair: 6, network: 300 }),
  register: Object.freeze({ account: 20, pair: 6, network: 300 })
});
```

`attempt()` first prunes all three candidate arrays and checks every ceiling. Only when all are below their ceiling does it append the same timestamp to all three. It returns a frozen token containing only action, normalized account, network bucket, and the three keys. `success(token)` deletes the account and pair keys but does not delete the aggregate network key. Keep the combined map at 10,000 entries and evict the oldest key after pruning.

Use `createHash('sha256')` with a `randomBytes(32)` per-process salt in production; inject a fixed salt in tests. Do not derive keys from `x-forwarded-for`.

- [ ] **Step 4: Implement generic login and bcrypt migration**

Create one process dummy hash at cost 11 and inject it. In `login`:

```js
const admission = authLimiter.attempt({
  action: 'login', account: username,
  address: socket.handshake && socket.handshake.address
});
if (!admission.allowed) return callback({ error: 'Too many requests. Try again later.' });

const initialUser = await findUserByUsername(UserModel, username);
const initialHash = initialUser ? initialUser.password : dummyPasswordHash;
const initialMatch = await bcryptImpl.compare(data.password, initialHash);
if (!initialUser || !initialMatch) return callback({ error: 'Invalid username or password.' });
```

Keep the locked reload and second comparison for password-change races, but return the same generic error for disappearance or mismatch. Before setting any `socket.*` authentication field, inspect `bcryptImpl.getRounds(user.password)`. If below 11, hash the supplied password at cost 11, assign it, and save inside the account lock. Invalid/unreadable costs fail closed. After the successful result, call `authLimiter.success(admission.token)` before the callback.

Registration hashes at 11 and uses the layered `register` policy. Password changes hash at 11. Do not clear the aggregate network key on success.

- [ ] **Step 5: Run mutation-sensitive auth verification**

Run:

```bash
node --test --test-name-pattern='layered authentication|network buckets|wrong-password|bcrypt|shared networks|aggregate network|authentication acknowledgements|spoofed forwarded' backend/test/chat-security.test.js backend/test/room-lifecycle.test.js
node backend/test/room-lifecycle.test.js
node --check backend/server.js
git diff --check
```

Temporarily mutate pair ceiling 6 -> 7, aggregate 300 -> 301, remove the dummy compare, return the two old distinct errors, and move session publication before rehash save. Each corresponding focused test must fail independently; restore production after each mutation and rerun GREEN.

- [ ] **Step 6: Commit Task 2**

```bash
git add -- backend/server.js backend/test/chat-security.test.js backend/test/room-lifecycle.test.js
git commit -m "security: harden shared-network authentication"
```

---

### Task 3: Bound connections, authenticated sessions, and packet envelopes

**Files:**
- Modify: `backend/server.js:20-40, 496-554, 993-1020, every socket.on registration at 1611-3595, 3625-3710`
- Modify: `backend/test/chat-security.test.js`
- Modify: `backend/test/room-lifecycle.test.js`
- Modify: `backend/test/message-actions.test.js`
- Modify: `backend/test/support/fakes.js:1-35`

**Interfaces:**
- Produces: `SOCKET_EVENT_POLICIES` frozen exact policy map for every client-originated event.
- Produces: `measurePayloadBytes(value, { maxBytes, maxDepth?, maxItems? }) -> integer | null`.
- Produces: `validateSocketEventEnvelope(event, args, policies) -> { allowed, error, policy, callback }`.
- Produces: `createConnectionAdmission({ now, salt, maxAttemptsPerMinute, maxConcurrentPerNetwork, maxEntries }) -> { open(socket), release(token), prune(), size(), concurrent(networkBucket) }`.
- Produces: `countAuthenticatedAccountSockets(sockets, username, excludedSocketId?) -> integer`.
- Produces: `createSocketEventDispatcher({ eventBudgetController?, inFlightCoordinator?, securityLogger? }) -> { dispatch({ socket, event, args, handler }) }`.
- Extends: `createConnectionHandler({ connectionAdmission, socketEventDispatcher, maxAuthenticatedSockets })`.
- Produces within handler: `onProtected(event, handler)` as the only registration path for client-originated application events; `disconnect` remains a direct lifecycle listener.

- [ ] **Step 1: Upgrade the fake socket before writing feature assertions**

Add an optional injected `dispatchPacket({ socket, event, args, handler })` boundary to `FakeSocket`. `trigger(event, ...args)` must call that boundary before the registered handler when supplied, while preserving the existing context enrichment for message events. Unknown events return `undefined` rather than throwing. This exercises the same dispatcher used by production `onProtected()` rather than inventing a test-only Socket.IO middleware path.

Add this fake-only regression before production changes:

```js
test('FakeSocket dispatcher can reject a packet before its registered handler', async () => {});
```

Run `node backend/test/message-actions.test.js` and require the complete file to remain green after the fake upgrade.

- [ ] **Step 2: Add the connection and envelope RED tests**

Add exact tests:

```js
test('connection admission allows sixty attempts and one hundred shared-network sockets at exact boundaries', () => {});
test('connection admission releases counters on every disconnect path and bounds network keys', () => {});
test('eight existing account sessions allow no ninth authenticated socket', async () => {});
test('distinct accounts on one network remain independent below the emergency ceiling', async () => {});
test('socket event policy covers every registered client event exactly once', () => {});
test('socket envelopes reject unknown events extra fields cycles depth and item overflow before handlers', async () => {});
test('event byte budgets accept exact boundaries and reject one byte over', () => {});
test('maximum valid chat attachment still reaches existing validation while oversized control data does no work', async () => {});
test('payload rejection telemetry contains no payload username attachment or raw-address sentinel', async () => {});
```

The policy-coverage test extracts every `socket.on('...')` application event from production, removes `disconnect`, and compares the sorted list exactly with `Object.keys(SOCKET_EVENT_POLICIES)`. This prevents a future handler from silently bypassing admission.

- [ ] **Step 3: Run the connection/envelope RED set**

Run:

```bash
node --test --test-name-pattern='connection admission|account sessions|Distinct accounts|socket event policy|socket envelopes|event byte budgets|maximum valid chat attachment|payload rejection telemetry' backend/test/chat-security.test.js backend/test/room-lifecycle.test.js backend/test/message-actions.test.js
```

Expected: FAIL because no connection controller, policy map, byte estimator, or protected registration path exists.

- [ ] **Step 4: Implement connection admission and account-session ceiling**

`createConnectionAdmission.open(socket)` uses only `socket.handshake.address`, hashes it, applies a 60-per-60,000ms rolling attempt window, then checks concurrent count < 100. It returns `{ allowed: true, token }` and increments concurrency, or a frozen generic rejection. `release(token)` is exact-token/idempotent. Both attempts and concurrency maps share the 10,000-key bound.

Do not apply the process-global controller to dependency-injected legacy unit handlers automatically. Wire it explicitly only here:

```js
const serverConnectionAdmission = createConnectionAdmission();
const serverSocketEventDispatcher = createSocketEventDispatcher();
io.on('connection', createConnectionHandler({
  connectionAdmission: serverConnectionAdmission,
  socketEventDispatcher: serverSocketEventDispatcher
}));
```

At handler entry, reject excess connections before registering application handlers or creating session state. Register an immediate disconnect cleanup that releases the exact token.

Inside the successful-login account lock, fetch live sockets before socket mutation and require `countAuthenticatedAccountSockets(liveSockets, user.username, socket.id) < 8`. On failure return `Too many active sessions.` without publishing the new session or evicting an existing session.

- [ ] **Step 5: Implement bounded exact packet policies and protected registration**

Define policies with these exact outer keys and limits (callbacks are trailing arguments and not payload keys):

```js
const SOCKET_EVENT_POLICIES = Object.freeze({
  register: objectPolicy(8_192, ['username', 'displayName', 'password'], 'auth'),
  login: objectPolicy(8_192, ['username', 'password'], 'auth'),
  change_password: objectPolicy(8_192, ['oldPassword', 'newPassword'], 'sensitive_write', true),
  update_preferences: objectPolicy(8_192, ['preferences', 'expectedVersion'], 'sensitive_write', true),
  logout_all_devices: noDataPolicy('sensitive_write', true),
  update_profile: objectPolicy(8_192, ['displayName', 'color', 'avatarUrl'], 'sensitive_write', true),
  manage_role: objectPolicy(8_192, ['action', 'targetUser', 'serverCode'], 'sensitive_write', true),
  moderate_user: objectPolicy(8_192, ['serverCode', 'targetUser', 'action', 'reason', 'duration'], 'sensitive_write', true),
  report_moderation_target: objectPolicy(8_192, ['serverCode', 'targetUser', 'reason', 'messageId'], 'sensitive_write', true),
  list_moderation_reports: objectPolicy(8_192, ['serverCode', 'status', 'limit', 'cursor'], 'moderation_read', true),
  resolve_moderation_report: objectPolicy(8_192, ['serverCode', 'reportId', 'status', 'resolution'], 'sensitive_write', true),
  list_room_restrictions: objectPolicy(8_192, ['serverCode', 'targetUser', 'limit', 'cursor'], 'moderation_read', true),
  get_moderation_audit: objectPolicy(8_192, ['serverCode', 'limit', 'cursor'], 'moderation_read', true),
  get_automod: objectPolicy(8_192, ['serverCode'], 'moderation_read', true),
  update_automod: objectPolicy(8_192, ['serverCode', 'blockedKeywords', 'mentionLimit', 'repeatLimit', 'repeatWindowSeconds', 'messageLimit', 'messageWindowSeconds'], 'sensitive_write', true),
  create_server: scalarPolicy(8_192, 'sensitive_write', true),
  join_server: scalarPolicy(8_192, 'sensitive_write', true),
  leave_server: scalarPolicy(8_192, 'sensitive_write', true),
  delete_server: scalarPolicy(8_192, 'sensitive_write', true),
  switch_server: scalarPolicy(8_192, 'heavy_read', true),
  chat_message: objectPolicy(8_100_000, ['serverCode', 'clientContextId', 'text', 'attachment', 'replyTo'], null, false),
  toggle_reaction: objectPolicy(16_384, ['id', 'emoji', 'serverCode', 'clientContextId'], 'light', false),
  edit_message: objectPolicy(16_384, ['id', 'text', 'serverCode', 'clientContextId'], 'light', false),
  delete_message: objectPolicy(16_384, ['id', 'serverCode', 'clientContextId'], 'light', false),
  get_edit_history: scalarPolicy(8_192, 'heavy_read', true),
  get_deleted_message: scalarPolicy(8_192, 'heavy_read', true),
  typing: objectPolicy(8_192, ['serverCode', 'clientContextId', 'isTyping'], 'light', false)
});
```

`objectPolicy` permits missing optional keys for existing handler validation but rejects every unknown outer key. The estimator walks only primitives, arrays, and plain objects, tracks object identity to reject cycles, rejects depth > 4 or > 100 aggregate entries, and stops once `maxBytes + 1` is reached. Count strings using `Buffer.byteLength(value, 'utf8')`; never `JSON.stringify` an 8 MB attachment.

Add `onProtected(event, handler)` inside `createConnectionHandler`. Replace every application `socket.on` with `onProtected`; leave only `disconnect` direct. The dispatcher validates before invoking the handler, responds through a trailing callback with `Invalid input format.` when available, silently drops invalid fire-and-forget packets, and logs only `payload_rejected` plus event/category/network bucket.

An `auth` policy bypasses the generic authenticated-event budget because Task 2's layered limiter is authoritative. A `null` category bypasses the generic budget for `chat_message` because persisted AutoMod message-rate enforcement remains authoritative. For every other category, consume only after `socket.username` exists; unauthenticated requests continue into the existing handler so its `Not authenticated.` contract is preserved. `noDataPolicy` treats a sole callback argument as an empty payload, and scalar policies validate only the scalar before the callback.

- [ ] **Step 6: Run complete Task 3 gates and mutations**

Run:

```bash
node --test --test-name-pattern='connection admission|account sessions|Distinct accounts|socket event policy|socket envelopes|event byte budgets|maximum valid chat attachment|payload rejection telemetry' backend/test/chat-security.test.js backend/test/room-lifecycle.test.js backend/test/message-actions.test.js
node backend/test/chat-security.test.js
node backend/test/message-actions.test.js
node backend/test/room-lifecycle.test.js
node --check backend/server.js
node --check backend/test/support/fakes.js
git diff --check
```

Mutation-check: delete one policy entry, add an unapproved `secret` key to a valid login packet, change the account ceiling 8 -> 9, and lower `chat_message` to 8,000,000 bytes. Each exact test must fail; restore and rerun GREEN.

- [ ] **Step 7: Commit Task 3**

```bash
git add -- backend/server.js backend/test/chat-security.test.js backend/test/room-lifecycle.test.js backend/test/message-actions.test.js backend/test/support/fakes.js
git commit -m "security: bound socket admission"
```

---

### Task 4: Add category budgets, duplicate suppression, and Mongo read deadlines

**Files:**
- Modify: `backend/server.js:480-554, 993-1020, relevant read/write handlers at 1764-3557, exports`
- Modify: `backend/test/chat-security.test.js`
- Modify: `backend/test/message-actions.test.js`
- Modify: `backend/test/moderation.test.js`
- Modify: `backend/test/support/fakes.js:55-75`

**Interfaces:**
- Produces: `createEventBudgetController({ now, maxEntries, policies? }) -> { consume({ account, category }), prune(), size() }`.
- Produces: `createInFlightRequestCoordinator({ schedule?, clearSchedule? }) -> { begin(socketId, event), finish(token), cancelSocket(socketId), size() }`.
- Produces: `applyQueryDeadline(query, milliseconds = 2_000) -> query`.
- Extends: `createSocketEventDispatcher({ eventBudgetController, inFlightCoordinator, securityLogger })` so protected handlers acquire and release exact tokens in `finally`.

- [ ] **Step 1: Add the focused RED tests**

Add exact tests:

```js
test('event category budgets enforce exact independent account boundaries and expiry', () => {});
test('shared network accounts never share authenticated event budgets', async () => {});
test('AutoMod chat message rate remains authoritative without a duplicate generic charge', async () => {});
test('duplicate expensive requests execute once and release after success error throw and disconnect', async () => {});
test('a timed-out in-flight token cannot release a newer request token', async () => {});
test('read-heavy handlers apply a two-second Mongo deadline when supported', async () => {});
test('query deadlines degrade safely for injected thenables without maxTimeMS', async () => {});
test('security budget and duplicate logs contain categories but no private payloads', async () => {});
```

Budget exact limits are light 120/account/minute, heavy read 30/account/minute, sensitive write 10/account/15 minutes, and moderation read 30/account/minute. Use two accounts on the same address and prove exhausting Alice never delays Bob.

The duplicate tests gate the first real `switch_server`, `get_edit_history`, `update_profile`, and `get_moderation_audit` handler operation, send an identical second request, and require one database entry plus `{ error: 'Request already in progress.' }`. Release the first through success, returned error, thrown dependency, thrown callback, and disconnect, then prove the next request enters.

- [ ] **Step 2: Run Task 4 RED**

Run:

```bash
node --test --test-name-pattern='event category budgets|shared network accounts|AutoMod chat|duplicate expensive|in-flight token|two-second Mongo|query deadlines|security budget' backend/test/chat-security.test.js backend/test/message-actions.test.js backend/test/moderation.test.js
```

Expected: FAIL because category budgets, exact-token in-flight ownership, and query deadlines are absent.

- [ ] **Step 3: Implement budgets and exact-token in-flight ownership**

Policies:

```js
const EVENT_BUDGET_POLICIES = Object.freeze({
  light: Object.freeze({ maxAttempts: 120, windowMs: 60_000 }),
  heavy_read: Object.freeze({ maxAttempts: 30, windowMs: 60_000 }),
  sensitive_write: Object.freeze({ maxAttempts: 10, windowMs: 15 * 60_000 }),
  moderation_read: Object.freeze({ maxAttempts: 30, windowMs: 60_000 })
});
```

Keys are category plus normalized account only; never include network address. Rejections do not extend the window. All categories share one bounded 10,000-key map.

The in-flight coordinator key is `${socketId}\0${event}`. `begin()` returns a frozen identity token or `null`. `finish(token)` deletes only when the stored token is the exact object. Add a 10-second safety timer whose callback exact-token-finishes abandoned work; call `.unref()` when available. `cancelSocket()` cancels and clears all keys for that socket.

The dispatcher order is: envelope -> authenticated category budget -> in-flight acquisition -> handler. It invokes the handler inside `try/finally`, so handler returns and throws release immediately. Wrap a supplied acknowledgement with the existing once-only safe acknowledgement behavior so a throwing client callback is contained and cannot trigger a second callback attempt or skip `finally`. Disconnect calls `cancelSocket(socket.id)`.

Expected rejections are `Too many requests. Try again later.` and `Request already in progress.`. Do not use `logUnexpectedError` for them.

- [ ] **Step 4: Apply read deadlines without changing mutation ordering**

Add:

```js
function applyQueryDeadline(query, milliseconds = 2_000) {
  return query && typeof query.maxTimeMS === 'function' ? query.maxTimeMS(milliseconds) : query;
}
```

Apply it immediately before awaiting the query chains for:

- `switch_server` message history;
- `list_moderation_reports`;
- `list_room_restrictions`;
- `get_moderation_audit`;
- `get_edit_history` message lookup;
- `get_deleted_message` message lookup.

Do not wrap mutating transactions in `Promise.race` and do not move callbacks outside account/room locks. Recognize Mongo deadline failures only by bounded error names/codes and return the handler's existing generic failure response.

Extend `queryResult()` in fakes with `maxTimeMS(value) { this.maxTimeMSValue = value; return this; }` and allow test-specific query spies to assert `2_000`. Do not make the fake sleep.

- [ ] **Step 5: Run complete Task 4 verification and mutations**

Run:

```bash
node --test --test-name-pattern='event category budgets|shared network accounts|AutoMod chat|duplicate expensive|in-flight token|two-second Mongo|query deadlines|security budget' backend/test/chat-security.test.js backend/test/message-actions.test.js backend/test/moderation.test.js
node backend/test/message-actions.test.js
node backend/test/moderation.test.js
node --check backend/server.js
git diff --check
```

Mutation-check account-only budget keys -> network keys, remove exact-token comparison, remove dispatcher `finally`, and remove one `.maxTimeMS(2000)` call. Each corresponding test must fail independently; restore and rerun GREEN.

- [ ] **Step 6: Commit Task 4**

```bash
git add -- backend/server.js backend/test/chat-security.test.js backend/test/message-actions.test.js backend/test/moderation.test.js backend/test/support/fakes.js
git commit -m "security: limit expensive socket work"
```

---

### Task 5: Prove the complete invisible-security policy and prepare publication

**Files:**
- Modify: `backend/test/chat-security.test.js`
- Modify: `backend/test/room-lifecycle.test.js`
- Modify: `backend/test/message-actions.test.js`
- Modify: `backend/test/moderation.test.js`
- Read-only verify: `backend/server.js`, `chat.html`, package files

**Interfaces:**
- Consumes every production helper and registered handler from Tasks 1-4.
- Produces no new product behavior; adds release-blocking integration matrices and evidence.

- [ ] **Step 1: Add the complete registered-handler security matrix before any corrective production edit**

Add exact tests:

```js
test('complete invisible-security matrix uses registered handlers and shared production policies', async () => {});
test('security boundaries preserve current chat moderation appearance image and shortcut contracts', async () => {});
test('security failures disclose no credential payload attachment or network sentinels', async () => {});
```

The matrix must include:

- production/development origin × exact/hostile/missing origin;
- unknown/existing account × correct/wrong password × below/at pair/account/network limit;
- cost 10/11/12 bcrypt hashes × save success/failure;
- 40 valid accounts on one network plus one attacked account;
- network connection attempt/concurrency exact edges;
- 8/9 same-account sessions;
- every policy event with valid payload and extra-key rejection; every byte class at its exact boundary and one byte over; every category at its exact boundary and expiry; and every event marked in-flight with a duplicate operation;
- current room/member/mod/admin/ban/timeout authorization remains delegated to existing handlers after admission;
- old socket and disconnect cleanup releases no newer token;
- all read-heavy query adapters receive `maxTimeMS(2000)`.

Assertions must be fixture-dependent: allowed rows prove a real model query/event/ack; denied rows require zero model queries, writes, broadcasts, and private sentinel serialization.

- [ ] **Step 2: Run the matrix against the unchanged Task 4 production tree**

Run:

```bash
node --test --test-name-pattern='complete invisible-security matrix|security boundaries preserve|security failures disclose' backend/test/chat-security.test.js backend/test/room-lifecycle.test.js backend/test/message-actions.test.js backend/test/moderation.test.js
```

Expected: PASS. If it exposes a genuine product gap, capture the exact failing row, use `superpowers:systematic-debugging`, add the smallest focused RED, and fix only that root cause before continuing.

- [ ] **Step 3: Run mutation sensitivity for the matrix**

One at a time, temporarily remove origin enforcement, account-plus-network throttling, dummy bcrypt comparison, packet extra-key rejection, account-only event budgeting, in-flight exact ownership, and one query deadline. Require a named matrix row to fail for every mutation. Restore production after each mutation and rerun the matrix GREEN.

- [ ] **Step 4: Request independent code review and resolve release blockers**

Use `superpowers:requesting-code-review` over `fb84aab..HEAD`. The review must separately grade:

- spec compliance for origin, NAT safety, login timing/errors, bcrypt migration, packet limits, connection/session ceilings, category budgets, duplicate suppression, deadlines, privacy, and deployment;
- task quality/mutation sensitivity;
- lock order, acknowledgement lifetime, disconnect cleanup, and compatibility with all legacy payloads.

Resolve every Critical or Important finding with a focused RED/GREEN round and a separate scoped commit. Ledger Minor findings explicitly; do not silently broaden scope.

- [ ] **Step 5: Run the fresh release gate**

Run from repository root:

```bash
npm test --prefix backend
node backend/test/chat-security.test.js
node backend/test/room-lifecycle.test.js
node backend/test/message-actions.test.js
node backend/test/moderation.test.js
node --check backend/server.js
node --check backend/test/chat-security.test.js
node --check backend/test/room-lifecycle.test.js
node --check backend/test/message-actions.test.js
node --check backend/test/moderation.test.js
node --check backend/test/support/fakes.js
node -e "const fs=require('fs'),vm=require('vm');const h=fs.readFileSync('chat.html','utf8');const s=[...h.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)].map(m=>m[1]).filter(x=>x.trim());s.forEach((x,i)=>new vm.Script(x,{filename:'inline-'+(i+1)+'.js'}));if(s.length!==1)throw Error('expected one inline script');console.log('inline scripts: 1')"
node -e "const fs=require('fs');const h=fs.readFileSync('chat.html','utf8').replace(/<script(?:\\s[^>]*)?>[\\s\\S]*?<\\/script>/gi,'');const ids=[...h.matchAll(/\\bid=\"([^\"]+)\"/g)].map(m=>m[1]);const d=[...new Set(ids.filter((x,i)=>ids.indexOf(x)!==i))];if(d.length)throw Error('duplicate ids: '+d);console.log('unique static IDs:',ids.length)"
node -e "const h=require('fs').readFileSync('chat.html','utf8');if(!/<title>Chat v1\\.3\\.2<\\/title>/.test(h))throw Error('title mismatch');console.log('title: Chat v1.3.2')"
git diff --check fb84aab..HEAD
git diff --check
git diff --exit-code fb84aab..HEAD -- package.json package-lock.json backend/package.json backend/package-lock.json
git status --short
```

Run a Node credential/privacy scan over every changed tracked file. Fail on Mongo connection strings other than the inert `mongodb://database/chat` fixture, bearer/token/API-key/private-key shapes, or the exact password/hash/address sentinels seeded by the security tests outside test fixtures. Run a production marker scan requiring zero removed-feature strings and zero `origin: "*"`.

- [ ] **Step 6: Commit any tests-only matrix changes**

If Step 1 changed tests after Task 4, stage only the exact changed test files:

```bash
git add -- backend/test/chat-security.test.js backend/test/room-lifecycle.test.js backend/test/message-actions.test.js backend/test/moderation.test.js
git commit -m "test: cover invisible security policy"
```

Skip this commit only if the matrix was already committed with an approved corrective round and the worktree is tracked-clean.

- [ ] **Step 7: Publish only after final review and remote fast-forward verification**

Use `superpowers:verification-before-completion`, then `superpowers:finishing-a-development-branch`, then the GitHub publication workflow. Fetch first and require the remote deployment branch to be an ancestor:

```bash
git fetch origin deploy-chat
git merge-base --is-ancestor FETCH_HEAD HEAD
git push origin HEAD:deploy-chat
git ls-remote --heads origin deploy-chat
git rev-parse HEAD
```

Require the two final SHAs to match exactly. Do not force-push. Report the exact commit, full test counts, configured `ALLOWED_ORIGINS` requirement, and any honest manual/deployment limitation.

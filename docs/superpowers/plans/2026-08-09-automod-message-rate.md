# AutoMod Message-Rate Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable per-account, per-room rolling message limit to AutoMod for every role and set the browser-tab title to `Chat v1.3.2`.

**Architecture:** Extend the existing persisted `ChatServer.autoMod` object and its bounded process-global tracker rather than creating another service or model. A send-only rate check runs after basic payload validation and fresh room access but before reply lookup, ping resolution, message persistence, or broadcast; edits continue through the existing content rules without consuming message-rate capacity. The current one-process Render topology shares the bounded state across sockets and reconnects, while legacy rooms receive 5-message/5-second defaults.

**Tech Stack:** Node.js, Express, Socket.IO, Mongoose/MongoDB, one-file HTML/CSS/vanilla JavaScript client, Node's built-in `node:test` runner.

## Global Constraints

- The approved design is `docs/superpowers/specs/2026-08-09-automod-message-rate-design.md`; its exact behavior governs this plan.
- Preserve the production three-file architecture. This feature changes only `backend/server.js` and `chat.html`; do not add a runtime file or dependency.
- Add `messageLimit` as an integer from 1 through 20 and `messageWindowSeconds` as an integer from 1 through 60.
- Defaults are exactly 5 messages per rolling 5 seconds, including for existing rooms whose stored AutoMod object lacks both new fields.
- The rate limit applies to ordinary users, Room Moderators, and Global Admins without exemption.
- The rate key is normalized account username plus exact room code and is shared across sockets/reconnects in the same backend process while isolated across rooms/accounts.
- Count new text or attachment-only messages; never count edits, reactions, typing, reports, or moderation actions.
- Rejected rate-limited attempts do not add a timestamp or extend the rolling window; a timestamp exactly on the boundary is expired.
- Reject over-limit sends before reply lookup, ping resolution, persistence, or broadcast and never expose raw message/attachment content.
- Create at most one `automod_block` audit entry per active rate-limit episode and continue notifying the sender for every rejected attempt.
- Keep combined AutoMod account-room state bounded to 10,000 keys and rate timestamps bounded to `messageLimit` per key.
- Remove the old 500-millisecond per-socket throttle and its `system_message` warning.
- The document `<title>` must be exactly `Chat v1.3.2`; visible branding is unchanged.
- Preserve all user-owned untracked root files and do not stage `node_modules/`, `package.json`, or `package-lock.json`.
- Use strict RED/GREEN TDD: observe every new regression fail for the intended missing behavior before editing production code.

---

## File Structure

- Modify `backend/server.js`: AutoMod defaults/schema/normalization, bounded shared tracker, send-only rate enforcement, settings API fields, audit coalescing, and removal of the legacy throttle.
- Modify `backend/test/moderation.test.js`: unit, settings authorization/persistence, bounded tracker, cross-socket/role, audit, and policy regressions.
- Modify `backend/test/message-actions.test.js`: registered `chat_message` and `edit_message` ordering/no-side-effect regressions.
- Modify `chat.html`: exact document title, two AutoMod numeric controls, normalization, rendering, and save payload.
- Modify `backend/test/client-smoke.test.js`: executable client normalization/render/save behavior and exact title/markup checks.

---

### Task 1: Persist and enforce the server-side rolling message limit

**Files:**
- Modify: `backend/server.js:81-205, 552-561, 821-828, 1216-1241, 2414-2489, 2988-3068, 3135-3185, 3370-3405`
- Modify: `backend/test/moderation.test.js:725-890, 1140-1405`
- Modify: `backend/test/message-actions.test.js:1-230, 540-620`

**Interfaces:**
- Consumes: existing `normalizeAccountKey`, `normalizeAutoModSettings`, `createAutoModTracker`, `roomAutoModSettings`, `rejectAutoModContent`, `loadRoomAccessState`, `withRoomMutationLock`, and `update_automod`/`get_automod` handlers.
- Produces: strict socket-input `normalizeAutoModSettings(value)`; legacy-compatible `normalizeStoredAutoModSettings(value)`; normalized settings `{blockedKeywords, mentionLimit, repeatLimit, repeatWindowSeconds, messageLimit, messageWindowSeconds}`; tracker method `recordMessageAttempt(key, limit, windowMs) -> {allowed: boolean, shouldAudit: boolean}`; unchanged repeat method `recordAndCheck(key, normalizedText, limit, windowMs) -> boolean`; diagnostic tracker methods `messageAttemptCount(key)` and `hasKey(key)` for bounded-state verification; `evaluateMessageRate({username, serverCode, settings, tracker})`; `rejectAutoModContent({... , result})`; registered send-only enforcement for `chat_message`.

- [ ] **Step 1: Add failing settings-normalization and API tests**

Extend `moderation.test.js` so the existing normalization, fetch, update, and authorization cases use complete settings and assert legacy defaults:

```js
assert.equal(normalizeAutoModSettings({
  blockedKeywords: ['spam'],
  mentionLimit: 5,
  repeatLimit: 3,
  repeatWindowSeconds: 30
}), null);

assert.deepEqual(normalizeStoredAutoModSettings({
  blockedKeywords: ['spam'],
  mentionLimit: 5,
  repeatLimit: 3,
  repeatWindowSeconds: 30
}), {
  blockedKeywords: ['spam'],
  mentionLimit: 5,
  repeatLimit: 3,
  repeatWindowSeconds: 30,
  messageLimit: 5,
  messageWindowSeconds: 5
});

assert.deepEqual(normalizeAutoModSettings({
  blockedKeywords: [],
  mentionLimit: 8,
  repeatLimit: 3,
  repeatWindowSeconds: 30,
  messageLimit: 1,
  messageWindowSeconds: 60
}), {
  blockedKeywords: [],
  mentionLimit: 8,
  repeatLimit: 3,
  repeatWindowSeconds: 30,
  messageLimit: 1,
  messageWindowSeconds: 60
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
```

Update the real `get_automod` and `update_automod` assertions so the response, persisted room, and audit metadata all contain `messageLimit` and `messageWindowSeconds`. Keep the assertion that serialized audit rows contain no configured keyword text. Add a legacy room fixture with neither field and require `get_automod` to return 5/5. Add a socket update that omits either new field and require `{error: 'Invalid input format.'}` with no persistence or audit write.

- [ ] **Step 2: Run the focused settings tests and verify RED**

Run:

```bash
node --test --test-name-pattern='AutoMod|legacy AutoMod' backend/test/moderation.test.js
```

Expected: failures show the response/normalizer lacks `messageLimit` and `messageWindowSeconds`, and invalid new bounds are accepted or ignored. Existing authority assertions must continue passing.

- [ ] **Step 3: Implement settings defaults, validation, persistence, and audit metadata**

In `backend/server.js`:

1. Add constants `DEFAULT_AUTOMOD_MESSAGE_LIMIT = 5` and `DEFAULT_AUTOMOD_MESSAGE_WINDOW_SECONDS = 5` near the existing AutoMod constants.
2. Keep `normalizeAutoModSettings` strict for client/socket writes: require both new properties as integers within the exact 1–20 and 1–60 bounds. Missing, `null`, strings, fractions, and out-of-range numbers return `null`.
3. Add `normalizeStoredAutoModSettings(value)`, which substitutes 5/5 only when the stored object's new properties are `undefined`, then delegates to `normalizeAutoModSettings`. Existing fields remain required and malformed stored values still fail closed. Use this stored-data normalizer from `roomAutoModSettings` and `get_automod`; export it for direct testing.
4. Return both fields from both successful normalizers and include them in `DEFAULT_AUTOMOD_SETTINGS`.
5. Add Mongoose subdocument fields:

```js
messageLimit: { type: Number, min: 1, max: 20, default: 5 },
messageWindowSeconds: { type: Number, min: 1, max: 60, default: 5 }
```

6. Read both fields from `update_automod`, validate them through the strict normalizer, persist the normalized complete object, return it from get/update, and include both numeric values in `update_automod` audit metadata.

- [ ] **Step 4: Run the focused settings tests and verify GREEN**

Run:

```bash
node --test --test-name-pattern='AutoMod|legacy AutoMod' backend/test/moderation.test.js
```

Expected: every selected test passes, including legacy defaults, invalid-bound rejection, exact-room authorization, persistence, response payload, and keyword-free audit metadata.

- [ ] **Step 5: Add failing tracker-policy tests**

Add direct tests for `createAutoModTracker` using an injected clock. Require the following exact sequence for `recordMessageAttempt('ABC123\0admin', 2, 1_000)`:

```js
let currentTime = 0;
const tracker = createAutoModTracker({ maxKeys: 10_000, now: () => currentTime });
assert.deepEqual(tracker.recordMessageAttempt('ABC123\0admin', 2, 1_000), {
  allowed: true, shouldAudit: false
});
currentTime = 100;
assert.deepEqual(tracker.recordMessageAttempt('ABC123\0admin', 2, 1_000), {
  allowed: true, shouldAudit: false
});
currentTime = 200;
assert.deepEqual(tracker.recordMessageAttempt('ABC123\0admin', 2, 1_000), {
  allowed: false, shouldAudit: true
});
currentTime = 300;
assert.deepEqual(tracker.recordMessageAttempt('ABC123\0admin', 2, 1_000), {
  allowed: false, shouldAudit: false
});
currentTime = 1_000;
assert.deepEqual(tracker.recordMessageAttempt('ABC123\0admin', 2, 1_000), {
  allowed: true, shouldAudit: false
});
```

Also assert:

- a blocked call at 300 did not move the boundary past 1,000;
- `ABC123\0alice`, `XYZ789\0admin`, and `ABC123\0admin` do not share timestamps;
- 10,001 distinct account-room keys leave `tracker.size()` equal to 10,000 and evict the deterministic oldest key;
- accepted timestamp storage never exceeds the configured limit by exposing diagnostic `messageAttemptCount(key)` and `hasKey(key)` methods on the returned tracker, analogous to existing `size()` and not used by runtime handlers;
- after filling one key under a 20-message limit, lowering the same key to a 1-message limit immediately trims its stored rate state to the newest one unexpired timestamp, keeps the next attempt blocked, and makes `messageAttemptCount(key) <= 1`;
- a mixed union of 5,000 repeat-only keys created through `recordAndCheck` plus 5,001 rate-only keys created through `recordMessageAttempt` still reports exactly 10,000 combined keys, `hasKey` reports the oldest repeat key was evicted, and the newest rate key remains;
- existing identical-message repeat tests remain unchanged in meaning.

- [ ] **Step 6: Run the tracker tests and verify RED**

Run:

```bash
node --test --test-name-pattern='message-rate tracker|repeat tracker' backend/test/moderation.test.js
```

Expected: the new tests fail because `recordMessageAttempt` and `messageAttemptCount` do not exist; the existing repeat test passes.

- [ ] **Step 7: Refactor the bounded tracker and implement message-rate state**

Keep the public repeat interface intact while storing one bounded state object per account-room key:

```js
{
  repeatedTextTimestamps: new Map(),
  acceptedMessageTimestamps: [],
  rateWindowMs: 0,
  repeatWindowMs: 0,
  rateAuditRecorded: false
}
```

`recordAndCheck` prunes and updates only `repeatedTextTimestamps` and records the current repeat window on that account-room state. `recordMessageAttempt` records the current rate window and prunes timestamps using `currentTime - timestamp < windowMs`. After expiry pruning, if a moderator lowered the limit, retain only the newest `limit` timestamps before evaluating; retaining the newest timestamps preserves the correct future unblock boundary while enforcing the per-key memory bound immediately. When under limit it appends once and resets `rateAuditRecorded` to `false`. When at limit it returns `allowed: false`, sets `rateAuditRecorded` on the first rejection only, and never appends. `size()` reports the combined account-room state map size. Pruning removes a key only when both repeat and rate state are empty. Global pruning uses each state's recorded repeat/rate window rather than applying one room's window to every key.

Before creating a new key at capacity, prune expired state and then evict `statesByAccountRoom.keys().next().value` until the map is within `boundedMaxKeys`. Do not store content in rate state. Keep the existing `prune` behavior compatible with its tests while ensuring per-state window metadata governs mixed-room cleanup.

- [ ] **Step 8: Run tracker and full moderation tests and verify GREEN**

Run:

```bash
node --test --test-name-pattern='message-rate tracker|repeat tracker|identical normalized messages' backend/test/moderation.test.js
node backend/test/moderation.test.js
```

Expected: focused tests and the complete moderation suite pass with no warnings or unexpected logs.

- [ ] **Step 9: Add failing registered-handler enforcement tests**

Add real `chat_message` handler cases across `message-actions.test.js` and the shared-model scenarios in `moderation.test.js` that prove:

1. With `messageLimit: 2` and `messageWindowSeconds: 5`, two valid messages persist and broadcast; a third emits exactly one room-scoped `message_blocked` with rule presentation unchanged and persists/broadcasts nothing.
2. The blocked third attempt performs zero `MessageModel.findById` reply lookups and zero `resolvePingsFn` calls by resetting spies after the first two accepted sends.
3. A fourth blocked attempt emits another client notice but the two blocked attempts create only one audit row whose metadata rule is `message_rate`; neither raw text nor attachment data appears in the audit, logs, or socket event.
4. After advancing the injected tracker clock exactly 5,000 ms from the oldest accepted timestamp, a new message is accepted; a later limit episode may create one new audit row.
5. A user and a Global Admin are both blocked by the same room settings; a Room Moderator is also blocked. No assertion relies on socket role snapshots for exemption.
6. Two sockets using case variants of the same canonical account share rate state, while another account or room does not.
7. An attachment-only message counts; `edit_message` does not call `recordMessageAttempt` and does not consume send capacity.
8. The old sub-500-ms behavior no longer emits `⚠️ Slow down! You are sending messages too fast.`; rapid sends below the configured limit succeed.
9. A legacy 5/5 room accepts five immediate distinct messages and blocks the sixth.
10. A strict 1/1 room accepts the first message, blocks an attempt at 999 ms, and accepts a new attempt exactly at 1,000 ms; the blocked attempt did not extend the boundary.
11. Malformed stored rate settings, including a string `messageLimit` or out-of-range window, fail closed with no message persistence or broadcast.
12. An injected tracker exception logs only the operation label, never raw text/attachment content, and produces no persistence or broadcast.

Use distinct message text in the default 5/5 case so the separate repeat-message rule cannot obscure the message-rate result. Codify that any otherwise-valid send admitted by the rate gate consumes one rate slot even if a later keyword, mention, or repeat rule blocks publication.

Use the existing injectable `autoModTracker`, fake sockets, shared in-memory models, outbound records, and `deferred()` gates. Do not add production test flags.

Use this structure for the ordering/no-side-effect regression in `message-actions.test.js`, with the room fixture returning the complete 2/5 settings object:

```js
test('rate-limited messages skip reply lookup, ping resolution, persistence, and broadcast', async () => {
  let currentTime = 1_000;
  let replyLookups = 0;
  let pingResolutions = 0;
  let creates = 0;
  const audits = [];
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
    ModerationAuditModel: { async create(value) { audits.push(value); return value; } }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });

  await socket.trigger('chat_message', { serverCode: 'ABC123', clientContextId: 1, text: 'one' });
  await socket.trigger('chat_message', { serverCode: 'ABC123', clientContextId: 1, text: 'two' });
  replyLookups = 0;
  pingResolutions = 0;
  await socket.trigger('chat_message', {
    serverCode: 'ABC123', clientContextId: 1, text: 'blocked secret',
    replyTo: { id: '507f1f77bcf86cd799439011' }
  });
  await socket.trigger('chat_message', { serverCode: 'ABC123', clientContextId: 1, text: 'blocked again' });

  assert.equal(creates, 2);
  assert.equal(replyLookups, 0);
  assert.equal(pingResolutions, 0);
  assert.equal(ioInstance.outbound.filter(item => item.event === 'chat_message').length, 2);
  assert.equal(socket.outbound.filter(item => item.event === 'message_blocked').length, 2);
  assert.equal(audits.filter(item => item.metadata?.rule === 'message_rate').length, 1);
  assert.equal(JSON.stringify(audits).includes('blocked secret'), false);
});
```

In `moderation.test.js`, use `registerWithModels` plus `connectAdditionalSocket` for the canonical-account/multi-role matrix. Send two distinct messages through the first socket, then assert the same-account case-variant socket is blocked. Repeat with a distinct account and a distinct room and require both sends to persist. Set `role: 'admin'` and a current room-moderator fixture in separate rows and require the same third-send rejection. Use an attachment-only payload `{text: '', attachment: 'data:image/png;base64,AA=='}` for one admitted slot, then invoke the registered `edit_message` handler and assert the tracker's `messageAttemptCount(key)` is unchanged.

Add a true reconnect case named `AutoMod message-rate state survives a same-account reconnect in the running backend`: fill the limit through one socket, trigger or simulate that socket's disconnect, create a fresh `FakeSocket`, register it through the same connection handler dependencies with the same injected tracker, authenticate the case-variant username in the same room, and require its next send to be blocked. Do not retain or copy state on either socket; the shared tracker must be the only bridge.

Name the default and strict cases exactly `default AutoMod accepts five immediate distinct sends and blocks the sixth` and `strict one-per-second AutoMod expires at the exact rolling boundary`. For the malformed-state case, return a stored room with all existing valid settings but `messageLimit: '5'`; assert no `MessageModel.create` or room emit. For the tracker-error case, inject an object whose `recordMessageAttempt()` throws `new Error('tracker failure containing NeverLogRaw')`, send raw text `NeverLogRaw message`, and assert neither the captured log serialization nor any outbound/persisted data contains `NeverLogRaw`.

- [ ] **Step 10: Run registered-handler tests and verify RED**

Run:

```bash
node --test --test-name-pattern='AutoMod|message-rate|rate-limited|attachment-only.*rate|edits do not consume|configured limit replaces' backend/test/message-actions.test.js backend/test/moderation.test.js
```

Expected: the configured-rate tests fail because the production send handler still has only the old 500-ms per-socket/admin-exempt throttle and performs expensive reply/ping work before any shared configurable check.

- [ ] **Step 11: Implement send-only enforcement and coalesced audit behavior**

In `createConnectionHandler`:

1. Delete closure variable `lastMessageTime` and the 500-ms role-exempt block.
2. After validating `payload`, exact `serverCode`, positive `clientContextId`, attachment shape, sanitized attachment, and nonempty text-or-attachment, enter the existing room mutation lock.
3. Inside the lock, load fresh access and normalized room AutoMod settings before reply lookup or `resolvePingsFn`.
4. Add and export a role-agnostic helper `evaluateMessageRate({username, serverCode, settings, tracker})`. It normalizes the account-room key, calls the tracker, and returns either `{allowed: true}` or `{allowed: false, rule: 'message_rate', shouldAudit}`. It deliberately accepts no role and therefore cannot exempt admins or moderators.
5. Call `evaluateMessageRate` before any reply lookup or ping resolution.

```js
const rateResult = evaluateMessageRate({
  username: access.user.username,
  serverCode,
  settings,
  tracker: autoModTracker
});
```

6. If not allowed, pass the returned result to `rejectAutoModContent` and return before reply lookup, resolution, persistence, or room emit.
7. Extend `rejectAutoModContent` so it always emits the existing generic `message_blocked` payload, but returns before `appendAuditReliably` only when `result.shouldAudit === false`. Existing keyword/mention/repeat results omit the property and therefore still audit.
8. Continue reply lookup, ping resolution, content AutoMod evaluation, persistence, and broadcast only after the rate check. Keep the final fresh access/current-room checks inside the same serialized operation so a concurrent restriction or room switch cannot publish stale content.
9. Leave `edit_message` on `evaluateAutoMod` only; never call `recordMessageAttempt` from edit handling.
10. If tracker evaluation unexpectedly throws, log only the operation name, emit no content, and fail closed without persistence or broadcast.

- [ ] **Step 12: Run focused and full backend verification**

Run:

```bash
node --test --test-name-pattern='AutoMod|message-rate|rate-limited|attachment-only.*rate|edits do not consume|configured limit replaces' backend/test/message-actions.test.js backend/test/moderation.test.js
node backend/test/message-actions.test.js
node backend/test/moderation.test.js
npm test --prefix backend
node --check backend/server.js
git diff --check
```

Expected: every command exits 0; all five backend test files pass; syntax and diff checks are clean; no raw blocked content or old slow-down warning appears in output.

- [ ] **Step 13: Self-review and commit the backend task**

Inspect `git diff -- backend/server.js backend/test/moderation.test.js backend/test/message-actions.test.js` for settings-field consistency, lock ordering, role exemptions, bounded memory, and accidental unrelated changes. Stage exactly those three files and commit:

```bash
git add -- backend/server.js backend/test/moderation.test.js backend/test/message-actions.test.js
git commit -m "feat: add configurable automod message limits"
```

---

### Task 2: Add AutoMod controls and the `Chat v1.3.2` browser title

**Files:**
- Modify: `chat.html:1-10, 504-546, 844-870, 1943-1991`
- Modify: `backend/test/client-smoke.test.js:1-75, 500-610, 795-920`

**Interfaces:**
- Consumes: Task 1 settings fields `messageLimit` and `messageWindowSeconds` in `get_automod`/`update_automod` payloads.
- Produces: inputs `#automod-message-limit` and `#automod-message-window`; `ChatClientHelpers.normalizeAutoModPrompt(input)` returns the complete six-field settings object or `null`; pure executable helpers `applyAutoModForm(elements, autoMod)` and `readAutoModForm(elements)`; exact document title `Chat v1.3.2`.

- [ ] **Step 1: Add failing executable client and markup tests**

Extend `client-smoke.test.js` to assert:

```js
assert.match(source, /<title>Chat v1\.3\.2<\/title>/);
assert.match(source, /id="automod-message-limit"[^>]*min="1"[^>]*max="20"/);
assert.match(source, /id="automod-message-window"[^>]*min="1"[^>]*max="60"/);

assert.deepEqual(client.normalizeAutoModPrompt({
  keywordsText: ' Spam\nspoilers ',
  mentionLimit: '4',
  repeatLimit: '5',
  repeatWindowSeconds: '60',
  messageLimit: '5',
  messageWindowSeconds: '5'
}), {
  blockedKeywords: ['spam', 'spoilers'],
  mentionLimit: 4,
  repeatLimit: 5,
  repeatWindowSeconds: 60,
  messageLimit: 5,
  messageWindowSeconds: 5
});
```

Require `null` for 0/21 message limits, 0/61 windows, fractional values, missing fields, and nonnumeric strings.

Test the production `ChatClientHelpers` block in its existing VM harness. Add pure form helpers to that block rather than inventing an extraction harness for outer-scope functions. `applyAutoModForm(elements, autoMod)` must write all six settings to controlled element objects, while `readAutoModForm(elements)` must return the raw six input values expected by `normalizeAutoModPrompt`. Production `renderAutoModSettings` and `saveAutoModSettings` must call those helpers through one `autoModFormElements()` element-map function; retain a narrow source-wiring assertion for those three named calls. Retain the existing coordinator assertions that invalidation or a stale acknowledgement cannot mutate the newer save state.

Extend the existing AutoMod request fixture exactly as follows so the existing executable coordinator test remains mutation-sensitive:

```js
const autoModPayload = {
  serverCode: 'ABC123',
  blockedKeywords: ['spam'],
  mentionLimit: 4,
  repeatLimit: 3,
  repeatWindowSeconds: 30,
  messageLimit: 7,
  messageWindowSeconds: 12
};
const autoModSave = client.moderatorCenterMutationRequestFor('automod', autoModPayload);
assert.deepEqual(autoModSave, {
  event: 'update_automod',
  key: 'automod:save',
  view: 'automod',
  payload: autoModPayload
});
```

In the executable helper test, pass plain element objects such as `{value: ''}` for all six fields to `applyAutoModForm`, then assert the new `.value` properties are `7` and `12`. Set those controlled values to `5` and `9`, pass them to `readAutoModForm`, normalize the result, and assert it contains `messageLimit: 5` and `messageWindowSeconds: 9` alongside the existing normalized fields. The production source-wiring assertion must require `renderAutoModSettings` to call `ChatClientHelpers.applyAutoModForm(autoModFormElements(), autoMod)` and `saveAutoModSettings` to call `ChatClientHelpers.readAutoModForm(autoModFormElements())` before normalization.

- [ ] **Step 2: Run client tests and verify RED**

Run:

```bash
node --test --test-name-pattern='AutoMod|browser title' backend/test/client-smoke.test.js
```

Expected: failures identify the old title, missing controls, incomplete normalized payload, missing render values, and incomplete save request.

- [ ] **Step 3: Implement the title, controls, normalization, render, and save wiring**

In `chat.html`:

1. Replace `<title>Pro Global Chat</title>` with `<title>Chat v1.3.2</title>` and change no other branding string.
2. Change the AutoMod numeric-control container to a responsive grid such as `grid-template-columns:repeat(auto-fit, minmax(130px, 1fr))` so five controls remain usable on narrow screens.
3. Add exact controls:

```html
<div class="input-group">
  <label for="automod-message-limit">Message limit (1–20)</label>
  <input id="automod-message-limit" class="text-input" type="number" min="1" max="20">
</div>
<div class="input-group">
  <label for="automod-message-window">Window seconds (1–60)</label>
  <input id="automod-message-window" class="text-input" type="number" min="1" max="60">
</div>
```

4. Extend `normalizeAutoModPrompt` with `Number(input.messageLimit)` and `Number(input.messageWindowSeconds)`, validate both with the exact integer bounds, and return them with the existing settings.
5. Add `applyAutoModForm(elements, autoMod)` and `readAutoModForm(elements)` to `ChatClientHelpers`. Use explicit named element properties `keywords`, `mentionLimit`, `repeatLimit`, `repeatWindowSeconds`, `messageLimit`, and `messageWindowSeconds`; do not query the DOM from the pure helpers.
6. Add `autoModFormElements()` outside the helper block to return those six named properties from the exact six element IDs.
7. In `renderAutoModSettings`, call `ChatClientHelpers.applyAutoModForm(autoModFormElements(), autoMod)`.
8. In `saveAutoModSettings`, call `ChatClientHelpers.readAutoModForm(autoModFormElements())` and pass the result through `normalizeAutoModPrompt` so `dispatchModeratorCenterRequest` sends the complete normalized object.
9. Keep the existing inline error, pending Save state, stale-response coordinator, and success refresh behavior unchanged.

- [ ] **Step 4: Run focused client tests and verify GREEN**

Run:

```bash
node --test --test-name-pattern='AutoMod|browser title' backend/test/client-smoke.test.js
```

Expected: all selected title, markup, helper, DOM rendering, save-payload, invalid-value, and stale-response tests pass.

- [ ] **Step 5: Run the complete release gate**

Run:

```bash
node backend/test/client-smoke.test.js
npm test --prefix backend
node --check backend/server.js
node --check backend/test/client-smoke.test.js
git diff --check
```

Compile every inline `chat.html` script with:

```bash
node -e "const fs=require('fs'),vm=require('vm');const h=fs.readFileSync('chat.html','utf8');const s=[...h.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)].map(m=>m[1]);s.forEach((c,i)=>new vm.Script(c,{filename:'chat-inline-'+(i+1)+'.js'}));console.log('inline scripts:',s.length);"
```

Require unique static IDs with:

```bash
node -e "const fs=require('fs');const h=fs.readFileSync('chat.html','utf8');const ids=[...h.matchAll(/\\sid=\"([^\"]+)\"/g)].map(m=>m[1]);const d=[...new Set(ids.filter((id,i)=>ids.indexOf(id)!==i))];if(d.length)throw new Error('duplicate ids: '+d.join(','));console.log('unique ids:',ids.length);"
```

Scan only the Task 2 changed files for live credential shapes with:

```bash
if rg -n --ignore-case 'gh[pousr]_[A-Za-z0-9]{20,}|mongodb(\+srv)?:\/\/[^[:space:]]+:[^[:space:]]+@' chat.html backend/test/client-smoke.test.js; then exit 1; else echo 'credential scan clean'; fi
```

Expected: all tests and syntax checks pass, every inline script compiles, IDs are unique, the changed-file credential scan has zero live secrets, and the only browser title is `Chat v1.3.2`.

- [ ] **Step 6: Self-review and commit the client task**

Inspect `git diff -- chat.html backend/test/client-smoke.test.js` for exact bounds, field names, responsive layout, stale-request safety, the requested title, and unrelated branding changes. Stage exactly those two files and commit:

```bash
git add -- chat.html backend/test/client-smoke.test.js
git commit -m "feat: configure automod message limits"
```

---

## Final Review and Publication Gate

After both task reviews pass, dispatch one independent whole-branch reviewer over the design-base-to-head diff. It must re-evaluate every Global Constraint and specifically attempt to falsify: admin enforcement, same-account multi-socket sharing, rolling-boundary behavior, audit coalescing, pre-reply/pre-ping rejection, legacy settings compatibility, tracker memory bounds, exact client fields, narrow-screen layout, stale AutoMod responses, and the tab title.

Resolve every Critical or Important finding through one final test-first fix wave and one scoped re-review. Then run a fresh complete `npm test`, backend/client syntax checks, inline-script compilation, HTML-ID uniqueness, `git diff --check`, changed-file credential scan, and git status review. Preserve all user-owned untracked files.

Use `superpowers:finishing-a-development-branch` only after the independent final review is clean and the fresh verification evidence passes. The user has already selected subagent-driven execution; do not offer inline execution again.

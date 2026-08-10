# Room Experience Features Design

**Date:** 2026-08-10

**Status:** Approved

## Goal

Add five connected chat features without changing the existing three-file runtime architecture:

1. Synchronized unread and mention badges.
2. Bounded room message pins.
3. Room descriptions and rules.
4. Per-room in-app notification preferences.
5. Private, global, asymmetric user blocking.

The browser tab title remains exactly `Chat v1.3.2`. The previously removed typing, presence, and history-rendering optimizations remain removed. Message pagination, message search, browser desktop notifications, and new runtime dependencies are out of scope.

## Architecture

The implementation is server-authoritative. MongoDB stores durable read cursors, notification preferences, room metadata, pin metadata, and user block relationships. The backend applies fresh authorization and filters blocked content before delivery. The client keeps versioned room maps for rendering and rejects stale acknowledgements.

Runtime production files remain:

- `backend/server.js`: schemas, validation, authorization, locks, safe serializers, socket handlers, and recipient-aware delivery.
- `chat.html`: styles, markup, pure client helpers, client state, socket wiring, and accessible UI.
- `backend/package.json`: unchanged.

No filesystem or timer state is authoritative. The supported deployment remains one Node process on Render Free with MongoDB persistence.

## Durable Data

### ChatServer additions

- `description`: string, empty by default, maximum 500 characters.
- `rules`: string, empty by default, maximum 2,000 characters.
- `metadataVersion`: nonnegative integer, default `0`, incremented atomically for each accepted description/rules mutation.
- `pinnedMessages`: a bounded array of at most 20 `{ messageId, pinnedAt, pinnedBy }` records.
- `pinVersion`: nonnegative integer, default `0`, incremented in the same atomic room-document update as every accepted pin/unpin/delete-unpin/restore mutation.

### Message additions

- `authorKey`: immutable normalized author username for blocker-aware queries.
- `notificationMentions`: immutable normalized usernames captured when the message is sent. The reserved value `*` represents an `@everyone` mention.
- `replyTo`: a backend-generated snapshot containing only `{ id, authorKey, displayname, text }`. The client supplies only the referenced message ID; the backend loads the exact-room source message and derives all snapshot fields. Client-supplied reply display names, authorship, or preview text are never trusted.

Edits never alter `notificationMentions` and never create new unread or mention activity. Pin summaries always load the referenced current message and omit deleted or missing targets. Deleting a pinned message uses the project's existing transaction abstraction to update the message and atomically pull the room pin while advancing `pinVersion`. Where transactions are unavailable, the room-locked fallback first pulls the pin and advances the version, then deletes the message. If deletion fails, reliable repair restores the exact prior pin and advances the version again before returning the error; if restoration exhausts retries, the message remains safely unpinned, the server emits the authoritative newer pin snapshot, and it reports/logs the partial failure without content.

### RoomMemberState

One document per normalized account and room:

- `usernameKey`
- `serverCode`
- `notificationLevel`: `all`, `mentions`, or `none`; default `all`.
- `lastReadAt`
- `lastReadMessageId`
- `version`: nonnegative integer, default `0`, incremented atomically for each accepted notification or read-cursor mutation.
- timestamps

The `(lastReadAt, lastReadMessageId)` tuple advances monotonically. A client supplies a message ID, never a trusted timestamp. The backend verifies the message belongs to the room before advancing the cursor.

Legacy accounts lazily initialize a room cursor at that room's newest existing message under the account-to-room lock order. This prevents historical messages from appearing as newly unread. Notification eligibility is always derived from fresh authoritative membership and restriction state rather than duplicated on `RoomMemberState`. Leave, kick, and ban retain the preference and cursor but make the state ineligible through those authoritative records. Before a join/rejoin membership grant or restored Global access is published, the handler advances the cursor to the newest message while holding the account-to-room locks; if the later membership/access write fails, the harmless early cursor advance remains and the next successful grant repeats it. Absence-period messages therefore never appear as unread. Room deletion removes all associated room-state documents.

### UserExperienceState

One bounded document per normalized account:

- `usernameKey`: unique normalized owner.
- `blockedUsers`: at most 500 `{ usernameKey, username, createdAt }` records.
- `blockVersion`: nonnegative integer, default `0`.
- timestamps

The block array and `blockVersion` change together in one atomic account-document update under the account lock. Blocks are global across rooms, private, asymmetric, and limited to 500 per account. Self-blocking is invalid. Room metadata/pin versions are scoped to one room, room-state versions are scoped to one account-room pair, and block versions are scoped to one account. Client request-generation tokens prevent stale dialog callbacks; these durable versions prevent older server events or acknowledgements from overwriting newer accepted state.

### Indexes

- Message room cursor: `{ serverCode: 1, timestamp: -1, _id: -1 }`.
- Unique room state: `{ usernameKey: 1, serverCode: 1 }`.
- Room state cleanup: `{ serverCode: 1, usernameKey: 1 }`.
- Unique experience state: `{ usernameKey: 1 }`.

The message room cursor index is feature-required for unread and pin reads. None of the previously removed typing, presence, or history-rendering behaviors return.

## Permissions

All checks use fresh MongoDB state within the existing identity, account, then room lock order. Persisted bans override membership, ownership, moderator status, and global role.

### Room descriptions and rules

- Private room: room owner or global admin.
- Global Chat: global admin only.
- Room moderators may read but not edit room metadata.

### Pins

- Private room: room owner, a moderator of that exact room, or global admin.
- Global Chat: global admin only.
- Maximum 20 live pins per room.
- The target must be a current, non-deleted message in the exact room.
- An active timeout denies pin, unpin, and room-metadata mutations even when the actor otherwise has an owner, moderator, or global-admin role.

### Personal state

- Any freshly authorized reader may update that room's notification setting or read cursor.
- An active timeout still permits reading, updating notification preferences, and marking read.
- An active ban denies all room-scoped feature access.
- Admin inspection of a private room does not create notifications unless that admin is an actual room member.

### Blocking

- Any authenticated user may block an existing account other than themselves.
- A block never kicks, bans, mutes, or removes either user from shared rooms.
- Moderation actions and system notices remain visible even when an involved account is blocked.

## Socket Contract

### Requests

- `get_room_details({ serverCode }, ack)`
- `update_room_details({ serverCode, description, rules }, ack)`
- `list_pinned_messages({ serverCode }, ack)`
- `set_message_pin({ serverCode, messageId, pinned, clientContextId }, ack)`
- `get_blocked_message({ serverCode, messageId, clientContextId }, ack)`
- `update_room_notification({ serverCode, level }, ack)`
- `mark_room_read({ serverCode, messageId }, ack)`
- `set_user_block({ username, blocked }, ack)`

Every acknowledgement returns canonical room/account identifiers and a monotonically increasing version where state can race. The client checks the request token before inspecting response data. Room metadata accepts only a greater `metadataVersion`; pins accept only a greater `pinVersion`; blocks accept only a greater `blockVersion`; notification/read state accepts only a greater account-room `version` (or an idempotent response with the same version and identical state). Other equal or lower versions are ignored. Because notification level and read cursor share one room-state version, every related acknowledgement and `room_notification_updated`/`room_read_updated` event carries the complete canonical state: notification level, cursor tuple, exact unread count, exact mention count, and version.

### Server events

- `room_details_updated`
- `message_pin_updated`
- `room_notification_updated`
- `room_read_updated`
- `room_activity`
- `user_block_updated`

Account-scoped changes are sent to every current session for that normalized account. Room activity is personalized and can update an inactive room's attention state without joining its Socket.IO room.

Every feature listener first verifies that the captured socket is still the current active socket. Socket replacement invalidates all room/pin/block coordinators and clears the feature maps before any event version is considered.

Login returns initial safe room summaries, room states, block state, and attention snapshots. A successful room switch returns safe room details, the notification mode, pin count, attention state, and blocker-filtered history. Pin bodies load only when the Pins panel opens.

## Unread and Notification Semantics

- Counts include newly created messages from another author unless that author is currently blocked by the reader.
- Canonical send-time mentions, including `@everyone`, create mention activity.
- Edits, reactions, typing, pins, system messages, and moderation notices do not create unread counts.
- A later deletion does not erase prior unread or mention activity. Deleted messages retain non-content author/mention/timestamp metadata for cursor counting while their text, attachment, reply, reactions, and edit history remain redacted. Live and reconnect-derived counts therefore agree without an unordered deletion snapshot.
- A room is marked read only while it is open, the document is visible, and the chat is at the bottom.
- The server verifies the last visible message and advances the cursor monotonically.
- Activity at or before the accepted cursor is ignored even if events and acknowledgements arrive out of order.
- Each `room_activity` carries the message `(timestamp, _id)` tuple, message ID, and the recipient's current `blockVersion`. The client ignores activity with an older block version, at or before its accepted read cursor, or with a recently seen message ID. A bounded recent-ID set prevents duplicate increments. Account-scoped read events replace the exact counts and cursor; reconnect/login snapshots recompute exact counts from MongoDB.
- Counts synchronize across tabs and devices.
- Display counts are capped visually at `99+`; the durable cursor remains exact.

Notification levels affect visible in-app attention:

- `all`: show unread and mention badges.
- `mentions`: show mention badges only.
- `none`: show no badges while continuing to track unread state.

The same level gates the client's existing incoming-message sounds: `all` permits normal-message and mention sounds, `mentions` permits mention sounds only, and `none` permits neither. No new sound, browser permission prompt, service worker, or background push is added.

## Blocking and Privacy

Blocking is not merely a CSS filter. For blocked-authored messages, the backend sends only an explicit redacted placeholder envelope containing the message ID, room, canonical author identity, timestamp, and `blocked: true`; it never sends the message text, attachment, reply text, reactions, edit history, or other content to the blocker. This lets the client preserve chronology and render the approved collapsed row without receiving the hidden content. Other blocked-author events are suppressed or recipient-filtered, and the client also applies its local block state before rendering.

For the blocker:

- Messages from the blocked author render as a collapsed `Blocked message — Show` row.
- Mentions and unread activity from that author are suppressed.
- Typing events from that author are suppressed.
- Reply preview text authored by that user is stripped.
- Their reaction identities are removed from reaction details.
- Pins whose underlying message was authored by that user are omitted from the blocker's Pins panel. The moderator recorded in `pinnedBy` does not control omission.
- Presence/member entries remain visible.
- Moderation and system notices remain visible.

The collapsed row's Show control calls `get_blocked_message` for that exact room/message/context. The backend requires fresh room access, verifies that the message author is currently blocked by the requester, and returns a one-time safe content payload for only that message. The response omits edit history, internal fields, reaction identities, and reply content and never changes the block relationship, unread cursor, or mention state. A stale room/context acknowledgement is ignored before response inspection.

The blocked account is never notified. Blocking or unblocking serializes under the blocker's account lock, atomically changes the bounded block array and `blockVersion` in `UserExperienceState`, then synchronously replaces the block cache on every live blocker session before acknowledging. Concurrent login uses the same account lock and reloads the durable block set. Message delivery reads the recipient socket's current cache immediately before a synchronous emit, with no intervening await; an emit therefore linearizes either before the live block replacement or after it. Unblocking refetches the active room so previously filtered history can be displayed. Messages sent while the block existed can become unread after unblocking when they are newer than the account's existing room cursor; the system does not silently advance unrelated room cursors. Legacy reply snapshots without an author are stripped for viewers with a nonempty block list rather than risking disclosure.

After every block or unblock, the backend recomputes blocker-aware unread and mention snapshots for accessible joined rooms and sends replacement snapshots, carrying the new `blockVersion`, to all blocker sessions. Older activity events or snapshots cannot overwrite that replacement.

The same block update invalidates every cached Pins response, clears blocked-author typing state, and refetches the active room for each blocker session. The replacement snapshot includes recipient-visible pin counts. Both initial pin counts and `message_pin_updated` are recipient-aware: a pin whose message author is blocked is absent from the count and payload. Reaction details and reply previews are rebuilt from the new block state rather than left in the current DOM.

Normal history, pin, and live-message payloads use explicit field allowlists. Stored edit-history arrays, internal Mongo fields, AutoMod configuration, and other internal fields are never included unless a separately authorized endpoint requires them.

Legacy Global Chat messages whose `serverCode` is missing or null remain readable through the existing Global compatibility query. New Global messages always store canonical `serverCode: "global"`.

Legacy messages without `authorKey` use `normalizeUsername(message.username)` as the authoritative application-layer fallback in serializers, block filtering, pin reads, and reply filtering. The fallback is fail-closed when the legacy author cannot be normalized. Because a legacy room cursor initializes at the newest existing message, pre-feature messages do not enter unread/mention counts; every new message stores `authorKey` and immutable mention metadata.

Legacy reply snapshots lack trustworthy authorship. For any viewer with a nonempty block list, legacy reply previews are omitted rather than risking disclosure. New replies always use the backend-derived `authorKey` snapshot described above.

## User Experience

### Room rail

- Room entries become real keyboard-accessible buttons.
- A lower-right badge displays `@N` when mentions exist; otherwise it displays unread count.
- Accessible labels and tooltips follow the selected notification level: both counts for `all`, mentions only for `mentions`, and no attention counts for `none`.
- Badge changes do not use a noisy live region.

### Room Info

- A compact Room Info header control opens one accessible dialog.
- Everyone with access can read the description and rules.
- Authorized editors see explicit Edit and Save controls.
- The same dialog contains the room notification selector.
- Newly joining users see Room Info once after a successful join.

### Pins

- A compact Pins header control displays the current pin count.
- The Pins dialog shows author, current text or attachment summary, original message time, and pin metadata.
- Message actions expose Pin or Unpin only when authorized.
- A pin outside the currently loaded history remains a summary only; jumping to unloaded context is out of scope.

### Blocking

- Block or Unblock appears in the member and message-author menus.
- Profile Settings contains a Blocked Users section for recovery and unblocking.
- Each blocked placeholder has an individual Show control that does not globally unblock the author.
- Member rows, message authors, avatars, and menu triggers use semantic buttons or equivalent Enter/Space activation with `aria-haspopup` and `aria-expanded`. Menus move focus inside when opened, close on Escape or outside activation, and restore focus to the trigger. The blocked-message Show control exposes `aria-expanded`.

### Mobile and accessibility

- New dialogs use `role="dialog"`, `aria-modal`, labelled headings, initial focus, Escape handling, and trigger-focus restoration.
- Pins and Room Info remain reachable through compact header controls on narrow screens.
- At widths of 700px and below, Room Info and Pins remain 44px compact controls while the existing invite/leave/delete/join/moderate/settings/logout actions move into one keyboard-accessible overflow menu with 44px targets. No header action may clip, overlap, or become unreachable at 320px width or 200% text zoom.
- Message actions are keyboard accessible and usable on coarse-pointer devices without relying on hover.
- Existing reduced-motion behavior is preserved.

## Concurrency and Failure Behavior

- Every room mutation performs a fresh access and permission check within the room lock.
- Account-specific mutations serialize with login and other session-state changes.
- Dialog and mutation callbacks use room/account-scoped generation tokens; stale acknowledgements cannot update reopened or switched UI.
- Blocking commits durable state before acknowledgement and refreshes all live account sessions under the account lock.
- Pin and message deletion races resolve under the same room lock. Pin/unpin changes the bounded room pin array and `pinVersion` atomically. Transactional deletion changes the message and pin set together. The no-transaction fallback changes and versions the pin set before deletion, and any compensating restore advances the version again; consequently every recipient-visible pin-set change has a strictly newer `pinVersion`.
- Read cursors never move backward.
- Duplicate block, unblock, pin, unpin, or read updates are idempotent.
- Expected validation and authorization failures return generic user-safe errors. Unexpected logs contain operation names and identifiers but never message, rule, description, or blocked-content text.
- Room description/rules edits and pin/unpin actions append moderation audit records. Metadata audits store actor, room, action, timestamps, message ID when applicable, and description/rule lengths or changed-field flags—never description, rules, message text, or attachment content. Personal blocks, read cursors, and notification preferences are not moderation-audited.

## Test Strategy

Implementation uses test-driven development and independent review after each stage:

1. Safe serializers, schemas, indexes, injectable models, and fake-model support.
2. Room details and notification preference permissions, bounds, stale acknowledgements, and multi-session updates.
3. Pin limits, exact-room roles, global policy, edits, deletions, and delete/pin races.
4. Durable block privacy across history, live messages, replies, reactions, typing, pins, reconnects, and concurrent login.
5. Unread and mention cursors, notification modes, blocked senders, inactive rooms, multiple sessions, reconnects, and out-of-order read/activity events.
6. Mobile and keyboard reachability, dialog focus behavior, room-switch invalidation, socket replacement, and complete policy matrices.

The final gate includes the complete backend suite, server syntax, inline client compilation, static ID uniqueness, diff hygiene, credential scanning, a whole-branch security/concurrency review, and confirmation that only the intended runtime/test/documentation files changed. Nothing is pushed until the complete branch passes review.

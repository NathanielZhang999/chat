# Room-Scoped Moderation Design

## Goal

Add secure, room-scoped moderation for the existing Global Chat and private rooms without granting authority outside the room where a moderator is assigned.

## Scope

This phase adds private-room kick, timeout, ban, unban, reports, an append-only moderation log, and lightweight AutoMod. Global Chat supports timeout, ban, and unban but does not support kick. Later phases will add pagination/search, unread state/notifications, and pins/announcements.

All production work remains in `chat.html`, `backend/server.js`, and `backend/package.json`. No new runtime dependencies are required.

## Authority Model

Authorization is always derived from fresh persisted data, never from message role snapshots or a stale client claim.

- A global admin can moderate Global Chat and every private room.
- A room moderator can moderate only the exact private room whose current `moderators` list contains that username.
- Being a moderator in one room grants no authority in any other room.
- A room creator has moderation authority because creation adds the owner to that room's moderator list; ownership is not a separate moderation bypass.
- Room moderators cannot act on another current room moderator or a global admin.
- Global admins cannot moderate another global admin through these room actions.
- The protected system owner cannot be kicked, timed out, banned, or otherwise restricted.

### Action matrix

| Room | Kick | Timeout / clear timeout | Ban / unban |
|---|---|---|---|
| Global Chat | Not available | Global admins | Global admins |
| Private room | Room moderators and global admins | Room moderators and global admins | Room moderators and global admins |

The server rejects every action outside this matrix with a generic permission error.

## Action Semantics

### Private-room kick

A kick removes the target's persisted membership and room-moderator entry. All live target sessions lose that membership immediately. Sessions actively viewing the room move to another accessible room, preferring Global Chat when allowed, otherwise the first joined private room, otherwise the room-selection state. A kicked user may rejoin later with the room's invite code.

### Timeout

A timeout is scoped to one room and expires automatically. Supported durations are 10 minutes, 1 hour, 24 hours, and 7 days. While timed out, a user may read room content, search it, load older messages, and delete their own existing messages, but cannot send or edit messages, react, or publish typing state. Authorized moderators can clear a timeout early.

### Ban and unban

A ban is scoped to one room. It removes private-room membership and moderator status, immediately evicts active sessions, and blocks future room access and rejoin attempts. A Global Chat ban blocks only Global Chat; it does not remove or restrict private-room access.

Unban removes only the ban restriction. It does not restore prior private-room membership or moderator status. A private-room user must rejoin normally with an invite code. An unbanned Global Chat user can enter Global Chat again normally.

When a Global Chat ban leaves no currently accessible room, the client enters a room-selection state where private invite joining remains available. Login selects the first accessible room instead of assuming Global Chat.

## Durable Data

Add three bounded, indexed models:

1. `RoomRestriction`
   - `serverCode`, normalized `username`
   - optional ban metadata: actor, reason, created timestamp
   - optional `timeoutUntil` plus actor/reason metadata
   - unique index on `(serverCode, username)`
   - indexes for active bans and timeout expiry queries

2. `ModerationAudit`
   - append-only action, room, actor, target, reason, duration/expiry, timestamp, and correlation identifier
   - authority snapshots for explanation only, never authorization
   - optional message/report reference
   - bounded reason text and indexed `(serverCode, timestamp)`

3. `ModerationReport`
   - reporter, room, target user, optional message identifier, bounded reason, status, resolver, and timestamps
   - report content is visible only to eligible moderators for that exact room and global admins
   - indexes for room/status/time and bounded duplicate-report protection

Store bounded AutoMod settings on the existing `ChatServer` record, including normalized blocked keywords, a mention limit, and repeated-message thresholds. The seeded Global Chat server stores its own settings like a private room.

## Server Flow and Concurrency

Add an ordered multi-account lock helper that acquires normalized actor/target account locks in stable sorted order, then takes the room lock. This preserves the existing lock order: identity allocation → account transition → room mutation.

Every moderation mutation performs these steps inside the locks:

1. Reload the actor, target, room, and restriction records.
2. Recalculate exact-room authority and target hierarchy.
3. Persist the restriction, membership, and moderator changes.
4. Update every live socket and map-only session for the target before awaiting transport operations.
5. Evict or move active sessions when required.
6. Append the audit record.
7. Emit only room-safe notices and direct target updates.

Ban access is checked during login room selection, join, switch, message creation, reactions, edits, typing, pagination, search, pins, and announcements. Timeout state is checked on the interaction events it blocks. A stale socket cannot bypass a fresh restriction.

## Socket Interface

- `moderate_user({serverCode, targetUser, action, duration, reason})`
  - actions: `kick`, `timeout`, `clear_timeout`, `ban`, `unban`
- `report_moderation_target({serverCode, targetUser, messageId, reason})`
- `list_moderation_reports({serverCode, status, before, limit})`
- `resolve_moderation_report({serverCode, reportId, resolution})`
- `get_moderation_audit({serverCode, before, limit})`
- `update_automod({serverCode, blockedKeywords, mentionLimit, repeatLimit, repeatWindowSeconds})`

Target sessions receive `room_access_updated` and `room_restriction_updated`. Eligible moderators receive only a minimal `moderation_queue_updated` signal and fetch report details through the authorized request event. Reporter identity, reasons, and audit data are never broadcast to ordinary room members.

## AutoMod

AutoMod runs server-side before message persistence and broadcast.

- Normalize bounded message text with Unicode NFKC and case folding.
- Match only configured bounded keywords; no external or machine-learning service.
- Enforce the configured mention limit.
- Detect repeated identical normalized messages per account and room in a bounded time window.
- Blocked messages are not persisted or broadcast.
- The sender receives a generic reason; the server appends a redacted audit entry.
- AutoMod applies to ordinary users and moderators. Global admins remain subject to hard message-size and mention bounds but are exempt from room-configured keyword/repeat rules.

Only exact-room moderators or global admins can configure private-room AutoMod. Only global admins can configure Global Chat AutoMod.

## Client Design

Add moderation actions to the existing user context menu only when the current actor is eligible in the active room. Global Chat shows Timeout and Ban/Unban; private rooms show Kick, Timeout/Clear Timeout, and Ban/Unban.

Add compact moderator-only views for reports, room bans, and audit history. Confirmation dialogs require a reason and show the exact room. The client treats server authorization as authoritative and refreshes membership/room state after direct restriction events.

The room-selection state keeps the server rail and join/create controls usable while disabling message composition until an accessible room is selected.

## Error Handling and Privacy

- Validate all action names, room codes, usernames, durations, identifiers, reasons, keyword lists, and pagination bounds.
- Use generic not-found/permission errors where detailed errors would leak membership or restriction state.
- Never broadcast reporter identity, report reasons, moderation notes, or audit entries.
- Log unexpected errors by type without message content, credentials, or moderation reasons.
- Partial transport failures fail closed: cached access is removed before transport eviction attempts, and affected sessions cannot continue publishing.

## Test Strategy

Use strict RED/GREEN tests against real Socket.IO handlers and production helpers.

- Exact-room moderator authority and cross-room denial
- Global admin authority and Global Chat's no-kick rule
- Peer moderator, global-admin, and system-owner protection
- Private kick persistence, multi-session eviction, rejoin, and moderator cleanup
- Room-scoped timeout enforcement, expiry, and early clearing
- Private and Global bans, unban behavior, reconnect/login fallback, and no cross-room effect
- Concurrent ban/kick versus leave, join, switch, role change, and message publication
- Report submission, duplicate bounds, authorization, pagination, resolution, and privacy
- Audit append-only behavior and private visibility
- Keyword normalization, mention bounds, repeat detection, admin exemption limits, and no-persist/no-broadcast guarantees
- Client context-menu visibility, target updates, room-selection state, and stale-response handling
- Full existing backend and client regression suites

# Message Pagination and Search Design

**Date:** 2026-08-09

## Goal

Add bounded, room-scoped message pagination and search without changing the production application's three-file architecture. The feature must remain suitable for a single-process Render web service backed by MongoDB Atlas, preserve the existing room-moderation rules, and avoid exposing private message fields through history or search responses.

## Scope

This phase includes:

- a bounded initial history page;
- cursor-based loading of older messages;
- current-room, case-insensitive substring search over current non-deleted message text;
- a compact search modal and an explicit **Load older messages** control;
- stable scroll position when older messages are prepended;
- request coordination that rejects stale room or search responses;
- a safe message serializer shared by initial history, older pages, and search;
- MongoDB indexes for chronological room queries; and
- focused authorization, privacy, pagination, search, and client-state tests.

This phase does not include cross-room search, fuzzy search, Atlas Search, unread counts, push/browser notifications, pins, announcements, or jumping from a search result to an unloaded page. Those remain separate first-stage phases where already approved, except fuzzy/cross-room search, which is deferred unless requested later.

## Current Defect Included in This Phase

The current `switch_server` history response spreads stored Message documents into the acknowledgement. That can expose internal fields, including the stored edit-history array, during ordinary history loading. Deleted-message redaction clears current text, attachment, and reactions for ordinary viewers but does not provide a strict field allowlist.

All history and search paths will instead use an explicit viewer-aware serializer. Ordinary history responses will never contain the internal edit-history array, Mongo version fields, or other unapproved fields. Existing authorized `get_edit_history` and `get_deleted_message` handlers remain the only routes for privileged original-content access.

## Backend Architecture

### Message index

Add a compound Message index:

```js
{ serverCode: 1, timestamp: -1, _id: -1 }
```

Global history retains compatibility with legacy messages whose `serverCode` is missing or `null`. A secondary chronological index may be retained if query inspection shows it is needed for the legacy branch. This phase does not silently drop legacy Global messages.

### Safe serialization

A pure `safeMessageForViewer(message, viewer)` helper returns only approved fields:

- `_id`, `serverCode`, `username`, `displayName`, `role`, `roomRole`, `color`, `avatarUrl`;
- current `text`, sanitized `attachment`, bounded reply snapshot, reactions, edited/deleted state, and timestamp.

It never returns internal edit history or database metadata. For a deleted message viewed by someone other than its author, a current global admin, or a current moderator of that exact private room, it returns only the fields needed to render the deletion placeholder and clears current content, attachment, reply content, and reactions.

Search excludes deleted documents before text matching for every viewer. It does not search edit history and does not return attachment bodies or reaction maps.

### Cursor contract

Cursors encode the last row's `(timestamp, _id)` pair. They are opaque to the client and validated strictly on the server. Message pages use:

```js
timestamp < cursor.timestamp
OR (timestamp === cursor.timestamp AND _id < cursor.id)
```

Queries sort by `{ timestamp: -1, _id: -1 }`, request `limit + 1`, and return chronological rows plus `nextCursor` when more data exists. The default page size is 20 and the maximum accepted size is 50.

### Initial history

`switch_server` returns the newest 20 messages rather than the newest 100, serialized through the safe helper, plus `nextCursor`. The existing switch acknowledgement remains backwards-compatible by keeping `history` as an array.

The history query and acknowledgement occur inside the existing account-then-room authorization boundary, with fresh persisted access checked before disclosure. A timeout does not block reading. An active ban blocks the switch and every subsequent history/search request.

### Older-message API

Add a `list_messages` Socket.IO event accepting:

```js
{ serverCode, clientContextId, cursor, limit }
```

The server requires authentication, normalized `serverCode === socket.serverCode`, a valid positive client context, a valid cursor when supplied, and fresh persisted room access. It echoes `serverCode` and `clientContextId` with `messages` and `nextCursor`.

### Search API

Add a `search_messages` event accepting:

```js
{ serverCode, clientContextId, query, requestId }
```

The query is normalized with Unicode NFKC, trimmed, required to contain 2–80 characters, and escaped before a case-insensitive MongoDB regular expression is constructed. Search is limited to the active room, current non-deleted `text`, and 20 results ordered newest first. It has a bounded per-account/per-socket rate limit and never logs the query or matching message content.

The response echoes `serverCode`, `clientContextId`, and `requestId`. Errors remain generic and do not reveal whether a private room or matching message exists.

### Authorization and locking

Both read APIs use the established account-before-room lock order:

1. normalize and validate request shape;
2. acquire the account transition lock;
3. acquire the exact room lock;
4. load fresh User, room, and restriction state;
5. reject missing rooms, non-members where required, or active bans;
6. query and serialize while the authorization boundary is held; and
7. synchronously acknowledge the bounded result.

Global admins retain their existing private-room membership bypass but never bypass an active stored ban. Timed-out users may load and search messages.

## Client Architecture

### Controls

Add a compact Search button to the existing room controls and a modal containing:

- a bounded text input;
- Search and Close controls;
- a status/empty-state region; and
- a separate result list rendered with safe DOM text operations and the existing trusted mention formatting.

Add a **Load older messages** button at the top of the chat history. It is visible only when `nextCursor` exists and is disabled while a page request is pending.

### Per-room request coordination

Create a message-read coordinator that tracks the accepted room code, client composition context, room epoch, pending older-page request, latest search request ID, and next cursor. It is reset on:

- accepted room switch;
- lobby entry, ban, kick, or access loss;
- logout or socket replacement; and
- explicit search modal close for search-only state.

Acknowledgements may change DOM or cursor state only when their room, context, epoch, and request identity still match. Slow older pages cannot prepend into a new room, and slow searches cannot replace newer results.

### Prepending and live updates

Older rows are deduplicated by message ID and prepended in chronological order without entrance animations. The client records the old scroll height and scroll top, renders the page, then adjusts the scroll top by the height difference so the same content remains visible. Loading older history never jumps to the bottom.

Existing live message, edit, reaction, and deletion events continue to update the active room. Holding the room lock through page serialization and acknowledgement orders a page against later room mutations. Client deduplication prevents repeated rows at cursor boundaries.

### Search results

Search results remain separate from the live chat DOM. Selecting a result highlights it only when that message is already loaded; otherwise the UI states that the message is outside the loaded history. Jump-to-context pagination is intentionally deferred.

Existing edit-history and deleted-message modal callbacks will use the same active-room/context guard so a delayed privileged response cannot appear after a room switch or access loss.

## Error Handling

- Malformed limits, cursors, contexts, request IDs, or search queries return `Invalid input format.`
- Missing authentication returns `Not authenticated.`
- Missing or forbidden rooms return generic existing errors without revealing private state.
- Database failures return `Failed to load messages.` or `Search failed.` and are logged without message/query content.
- A client timeout or lost acknowledgement re-enables the relevant control through coordinator invalidation on close, switch, access change, or socket replacement.

## Testing

Backend tests will cover:

- safe serializer allowlisting and edit-history privacy;
- deleted-message redaction and search exclusion;
- initial 20-message page and `nextCursor`;
- cursor timestamp ties, invalid cursors, limits, no duplicates, and terminal pages;
- legacy missing/null Global message compatibility;
- strict room isolation and intended-room/context matching;
- fresh ban denial, timeout read/search allowance, moderator/admin redaction rules, and access rechecks across races;
- bounded escaped substring queries and rate limiting; and
- response payloads containing no attachment bodies, edit histories, or internal fields where not required.

Client tests will cover:

- stale room/page/search response rejection;
- latest-search-wins behavior;
- pending-control reset after close, switch, access loss, and socket replacement;
- stable scroll anchoring when rows are prepended;
- deduplication by message ID;
- safe result rendering and empty/error states; and
- guarded edit-history/deleted-message callbacks.

The full backend suite, server syntax check, inline client-script compilation, HTML ID uniqueness, diff hygiene, and credential scan remain release gates.

## Deployment and Compatibility

No dependency or additional runtime file is added. Production remains:

- `chat.html`
- `backend/server.js`
- `backend/package.json`

MongoDB creates the declared indexes through the existing Mongoose model initialization. The bounded APIs are designed for the current single Render instance and Atlas free-plan database. If room search volume later outgrows escaped substring queries, the API can migrate to Mongo text search or Atlas Search without changing the client request coordinator or cursor-based history interface.

## Future Interfaces

Timestamp/ObjectId cursors and stable message IDs are intentionally reusable by later unread markers, notifications, pins, and announcements. This phase does not store unread or pin state and does not couple those later features to the pagination/search implementation.

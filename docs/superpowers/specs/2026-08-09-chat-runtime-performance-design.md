# Chat Runtime Performance and AutoMod Alignment Design

## Goal

Improve runtime performance on the existing single-process Render deployment without changing chat features, permissions, visible behavior, data contracts, or the three-file production architecture. Also align the five numeric AutoMod controls when their labels wrap.

## Scope

This pass will make five targeted changes:

1. Align the AutoMod numeric inputs with a scoped responsive grid rule.
2. Add MongoDB indexes for room history and room membership queries.
3. Avoid hydrating Mongoose documents during mention-member lookup.
4. Stop broadcasting the unchanged Global online-user list on room switches.
5. Eliminate unnecessary browser layout reads during history rendering and repeated typing events during continuous typing.

The implementation will not add dependencies or production files. It will not restore message pagination or search, change the 100-message history behavior, change attachment handling, add caches, alter lock ordering, tune Mongo connection-pool settings, or modify any moderation/chat feature.

## AutoMod Layout

The five numeric controls currently use `repeat(auto-fit, minmax(130px, 1fr))`. At ordinary modal widths this creates columns narrow enough for the longer uppercase labels to wrap. Each input follows its own label, so only the inputs below wrapped labels move downward.

The numeric grid will receive a dedicated class instead of an inline layout declaration. Its responsive tracks will use a wider 170px minimum, and `align-items: end` will bottom-align the complete input groups within each grid row. The wider track prevents the current labels from wrapping at normal text sizes; bottom alignment keeps the inputs aligned even if a label wraps at high zoom. This preserves the labels, bounds, inputs, and ordering while changing only their responsive arrangement and vertical alignment. The rule will not affect controls elsewhere in the application.

## Database Query Optimization

`Message` will declare a compound index matching private-room history retrieval: `{ serverCode: 1, timestamp: -1, _id: -1 }`. The history result size, ordering, serialization, and legacy Global query compatibility remain unchanged. The legacy Global `$or` query may not receive the full benefit of this index; this pass will not migrate historical records.

`User` will declare a multikey index on `{ servers: 1 }`, matching room-membership predicates used by mention resolution and online-user construction.

Mention-member lookup will retain its existing projection, filtering, casing, sorting, and output, but add `.lean()` so Mongoose returns plain objects rather than hydrated documents.

No manual index-building endpoint or startup migration will be added. The indexes use the project's existing Mongoose schema/index lifecycle.

After deployment, the target Atlas database must be checked to confirm both indexes exist. On representative private-room data, `explain('executionStats')` for the history query must use the compound Message index without a blocking `SORT`, while membership lookup must use `servers_1`; examined keys/documents should scale with the bounded result or matching membership set rather than the whole collection. The legacy Global `$or` query will be measured and reported separately as intentionally not optimized by this pass. If production-like Atlas access is unavailable during implementation, the release report will state that limitation and provide the exact verification commands rather than claim measured database gains.

## Presence Optimization

The Global online-user list represents every authenticated online account and does not depend on which room each socket currently views. A room switch therefore does not change that list.

After a successful switch, the server will continue updating the previous and destination private rooms as applicable, but it will not separately rebuild and broadcast the Global list. Login, disconnect, profile changes, moderation changes, and other events that can actually change Global presence continue to publish it through their existing paths.

Duplicate old/new room updates will remain deduplicated. A switch involving Global will not cause an unnecessary Global broadcast.

## History Rendering Optimization

History messages are rendered with `history: true` and followed by the existing single final scroll. Per-message near-bottom detection currently reads `scrollHeight`, `scrollTop`, and `clientHeight` even though the history path never uses that result.

`appendMessage` will skip those layout reads for history messages. Live messages retain the existing near-bottom behavior, animations, order, DOM structure, attachment rendering, moderation actions, and scroll policy. Initial history still renders the same messages in the same order and performs the same final scroll.

## Typing Event Optimization

The client currently emits `typing: true` on every input event. The replacement will be an edge-triggered state machine scoped to the exact active socket reference and room context:

- The first input after idle emits `typing: true` once, including when the input becomes empty; this preserves the current 1.5-second empty-input behavior.
- Further input events only refresh the existing 1.5-second local idle timer.
- Idle timeout emits `typing: false` once when the same socket and room context remain active.
- A locally accepted submit means a valid payload was emitted through the connected socket; it emits `typing: false` immediately afterward only if that typing episode previously emitted `true`, preserving packet order. It does not wait for server persistence because `chat_message` has no acknowledgement.
- A room-switch request, lobby entry, logout, forced logout, or socket replacement clears local typing state and its timer. Socket replacement never emits through the disconnected old socket. Existing server-side disconnect and room-transition behavior remains responsible for peer cleanup.
- A timer created for an older socket or room cannot publish into the current room.
- Beginning to type after becoming idle emits `typing: true` again.

The server's existing authorization and broadcast behavior remains authoritative and unchanged. This pass does not promise a new peer-visible stop event across a room transition; it preserves the current transition behavior while ensuring no stale client timer emits into another socket or room. Normal in-room typing indicator semantics remain the same while rapid typing no longer causes a database-validated, room-locked Socket.IO event for every keystroke.

## Error and Compatibility Behavior

All new client helpers will fail closed when there is no active socket or room. Timer cleanup will be idempotent. Existing server errors and callback payloads remain unchanged.

Existing MongoDB documents require no migration. Index declarations are additive. No data is deleted or rewritten.

## Test Strategy

Implementation will follow test-driven development. Focused regressions will prove:

- the AutoMod grid has a dedicated 170px responsive track rule and bottom-aligned groups, with unchanged labels, bounds, and order;
- the expected Message and User indexes are declared exactly once;
- mention resolution uses the exact existing projection plus a lean query without changing collision or case-matching results;
- old-private to new-private, Global to private, private to Global, and same-room switches never perform a redundant Global presence broadcast; relevant private broadcasts remain deduplicated and the acknowledgement still precedes broadcasts;
- rendering 100 history rows performs zero near-bottom measurements and requests one final scroll, while a live message performs one measurement and preserves its scroll behavior;
- 100 continuous input events emit exactly one `typing: true`, then one `typing: false` after idle, and a new episode restarts correctly;
- local submit emits at most one stop after an active start, while room switch, lobby, logout, forced logout, socket replacement, and stale timers reset safely without emitting through the wrong socket or room.

The release gate will run the full backend test suite, server syntax validation, inline client-script compilation, HTML ID uniqueness, diff hygiene, and a credential scan. Only `backend/server.js`, `chat.html`, and their existing tests may change during implementation. Root-level untracked package files remain untouched.

## Expected Outcome

Room history and membership lookups can use matching Mongo indexes; mention lookup allocates fewer objects; room switches avoid an unnecessary whole-Global presence query and broadcast; initial history avoids repeated forced-layout reads; and typing traffic falls from roughly one event per keystroke to one start and one stop per typing episode. The AutoMod numeric inputs remain aligned at desktop and narrow modal widths without changing the controls themselves.

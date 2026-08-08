# Smooth Chat Animations Design

## Goal

Make the chat interface feel subtle, polished, and responsive without changing its visual structure or backend behavior.

## Scope

All production changes remain in `chat.html`. The backend, dependencies, application features, and three-production-file architecture remain unchanged.

## Motion System

Define shared CSS motion variables for short interaction feedback, normal panel movement, and a non-overshooting easing curve. Replace broad `transition: all` declarations with explicit transitions for the properties each component actually changes. Favor compositor-friendly `opacity` and `transform` animations, reduce large translations and scales, and remove springy overshoot from modals, menus, messages, reactions, server icons, and user rows.

Hover and active feedback remains visible but restrained. Existing visibility and pointer-event behavior for modals, menus, and pickers remains intact.

## Scrolling and Bulk Rendering

Add small testable client helpers that decide whether a live update should animate its automatic scroll and that coalesce multiple scroll requests into one scheduled update. A live message scrolls smoothly only when the viewer was already near the bottom; otherwise the viewer's reading position is preserved.

History rendering suppresses per-message entrance animation and per-message scrolling. After the history batch is appended, the client performs one non-animated final scroll. Live messages retain a short entrance animation.

## Accessibility

Add a `prefers-reduced-motion: reduce` rule that effectively disables transitions and entrance animations and changes chat scrolling to `auto`. The interface remains usable and state changes remain visible without motion.

## Error and Compatibility Behavior

Animation and scroll scheduling must not affect authentication, message data, room state, or Socket.IO behavior. Missing or unavailable animation-frame APIs fall back to immediate scheduling behavior suitable for the existing browser environment. Existing local-storage and deployment configuration remain unchanged.

## Verification

Extend `backend/test/client-smoke.test.js` with focused behavior tests for near-bottom scroll decisions, coalesced scheduling, and history-versus-live rendering policy. Verify the tests fail before implementation, then pass afterward. Run the full backend suite, backend syntax check, and diff check before publication.

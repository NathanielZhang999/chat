# Default Render Backend URL Design

## Goal

Make the public frontend immediately point new users to `https://chat-backend-iekp.onrender.com` while preserving the existing ability to use another backend.

## Design

Set the Backend URL input's initial value in `chat.html` to the deployed Render URL. Keep the input editable. On page load, the existing `pro_chat_url` local-storage value continues to override that default, so returning users retain their previously selected backend.

No backend behavior, deployment configuration, or application architecture changes are required.

## Data Flow and Errors

The existing login flow will continue to normalize and validate the input, save the normalized value, and create the Socket.IO connection. Existing connection-error handling remains unchanged.

## Verification

Add a client smoke assertion that reads the production HTML and verifies the Backend URL input is prefilled with the exact deployed URL. Run the focused client smoke suite, then inspect the final diff and syntax.

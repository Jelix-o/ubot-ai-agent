# UBot System Tuning V1.0.0

## Changes

- Removed the mistakenly added planning console, QQ command, backend API, stores, and route.
- Kept useful production capabilities: profiles, memory, model health, TTS, task center, audit, and operations health.
- The system improvement direction is conversation quality, memory quality, model/TTS reliability, and operations visibility.

## Verification

- Run `npm test` locally.
- After production deployment, verify `ai-project.service` is active, NapCat reverse WebSocket is connected, `/login` returns 200, and protected APIs return 401 when unauthenticated.
- Confirm the removed planning route, backend API, and QQ command do not exist as product features.

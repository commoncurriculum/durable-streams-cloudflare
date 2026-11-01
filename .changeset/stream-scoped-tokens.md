---
"@durable-streams-cloudflare/server": patch
---

A JWT with `stream_id` now reads and writes only that stream. It was validated but not enforced, so a token for one stream could read and write every stream in its project.

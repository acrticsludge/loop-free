---
description: Start, stop or inspect the loop-engine portal and its public link.
agent: build
---

Manage the loop portal. Report the result, don't narrate the steps.

Always use the launcher — it is the only supported way to start the portal, and
it handles the health check, the detached spawn, and the pid file:

```
node "$env:USERPROFILE\.config\opencode\loop\start-portal.mjs" start
node "$env:USERPROFILE\.config\opencode\loop\start-portal.mjs" stop
```

## Modes

- `start` — the default. The portal stops itself about 15 seconds after the last
  opencode loop session ends. This is the normal lifecycle, and it is what you
  want. Nothing is left listening when you are not working.
- `start keepalive` — opts out of auto-shutdown, for when you want the dashboard
  up with no loop running. It will not exit on its own. **Always tell the user
  this when you use it**, and remind them `/portal stop` turns it off.
- `stop` — stops it immediately.

Do not start the daemon with `Start-Process`. That form does not survive the
shell that launched it, which produced a portal that died without explanation.
The launcher uses a detached spawn for exactly this reason.

## If the user asks why it is not running

That is correct behaviour, not a fault. It self-terminates when idle by design.
Start a loop, or use `keepalive` deliberately.

## Report

```
PORTAL:  running (pid N) | stopped
LOCAL:   http://127.0.0.1:7317/?t=<token>
PUBLIC:  https://anubhav.tailee8d9c.ts.net/?t=<token>   (if a tunnel is up)
MODE:    auto-shutdown | keepalive
```

The launcher prints all of this. Relay it rather than recomputing it.

## Security

The token is the only thing protecting the dashboard. `ts.net` hostnames and
ngrok endpoints are both discoverable, so never treat the URL itself as secret.
If a link is ever shared or leaked, delete `portal-token` from
`~/.local/share/opencode/loopguard/` — the next start mints a new one.

Narration stays disabled. `/api/narrate` spawns a model process on this machine
and the daemon refuses it unless started with `LOOP_PORTAL_NARRATE=1`. Do not
set that variable for a tunnel that is reachable from the internet.

Adapter switching from the portal is a write endpoint. It is token-gated like
everything else, but note that switching to a more permissive adapter
downgrades the guardrails for subsequent loop runs.

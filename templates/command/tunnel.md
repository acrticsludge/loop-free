---
description: Expose the loop-engine portal on the public internet and print the shareable link. Uses Tailscale Funnel; falls back to ngrok.
agent: build
---

Expose the loop-engine portal publicly and report the link.

## Preconditions

1. The portal must be running:

```
curl -s http://127.0.0.1:7317/health
```

If it is not, tell the user to run `/portal` first. Do not start it silently.

2. Tailscale must be connected:

```
& "C:\Program Files\Tailscale\tailscale.exe" status
```

If it reports a health-check failure, the daemon is wedged. Tell the user to run
`Restart-Service Tailscale` from an elevated PowerShell, or to log out and back
in from the tray icon. Do not try to fix it yourself — a partial service restart
makes it worse.

## Preferred: Tailscale Funnel

```
& "C:\Program Files\Tailscale\tailscale.exe" funnel --bg 7317
```

This is the permanent link. `anubhav.tailce8d9c.ts.net` never changes, needs no
router port-forwarding, and works from any network.

If it reports *"Funnel is not enabled on your tailnet"*, give the user the
consent URL it prints and stop. They must approve it in a browser.

## Fallback: ngrok

Only if Tailscale is unavailable. Note in the report that this URL is temporary
and changes on every restart.

```
ngrok http 7317 --log "$env:TEMP\ngrok.log" --log-format logfmt
```

Read the public URL from the local inspector at `http://127.0.0.1:4040` (query
`/api/tunnels`). Do not guess it.

## Then report

```
PUBLIC: https://<host>/?t=<token>
PERMANENT: yes | no — changes on restart
```

Get the token from:

```
Get-Content "$env:USERPROFILE\.local\share\opencode\loopguard\portal-token" -Raw
```

Write the public URL so the portal can display it:

```
Set-Content "$env:USERPROFILE\.local\share\opencode\loopguard\public-url.txt" -Value "<public-url>" -Encoding UTF8
```

Then verify from the public side before reporting success:

```
curl.exe -s -o NUL -w "%{http_code}" "<public>/health"                  # 200
curl.exe -s -o NUL -w "%{http_code}" "<public>/api/runs"                # 401
curl.exe -s -o NUL -w "%{http_code}" "<public>/api/runs?t=<token>"      # 200
curl.exe -s -o NUL -w "%{http_code}" -X POST -d '{}' "<public>/api/narrate?t=<token>"  # 403
```

All four must match. A 502 means the local daemon died; restart it via `/portal`.

## Security, state this plainly

Narration stays off over the public internet. `/api/narrate` spawns a model
process on this machine, so the daemon refuses it unless it was started with
`LOOP_PORTAL_NARRATE=1`. Reading the dashboard is exposed; triggering work is
not. The 403 check above is how you confirm that boundary actually holds rather
than assuming it.

The token is load-bearing. The hostname is not secret — `ts.net` names and
ngrok's inspector are both discoverable — so treat the token as the only
credential and regenerate it if a link is ever shared or leaked.

## Stop

```
& "C:\Program Files\Tailscale\tailscale.exe" funnel --https=443 off
Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process
```

# loop-free installer (OpenCode)

One-command setup for the free-tier loop-engine (`loop-free`) stack plus all required and recommended MCP servers (sanitized placeholders). **Secrets are never committed here**; you fill them locally after install.

## Install (local / development)

```bash
node bin/loop-free.js install
```

or, after publishing to npm:

```bash
npx loop-free install
```

By default it writes to:

- Windows: `%USERPROFILE%\.config\opencode`
- Unix/macOS: `~/.config/opencode`

## What gets installed

- `agent/loop-free*.md`, `command/loop-free.md`, `loop/*.mjs`, `plugins`, `tui-plugins`, `skill/loop-adapter`, `skill/loop-engine`
- `opencode.jsonc` MCP server registry as a template (placeholder keys)
- `AGENTS.md` guidance

## Post-install secrets guidance

Fill placeholders directly in `%USERPROFILE%\.config\opencode\opencode.jsonc` (or `~/.config/opencode/opencode.jsonc`):

- context7 → `YOUR_CONTEXT7_API_KEY`
- github → `YOUR_GITHUB_PAT`
- postiz → `YOUR_POSTIZ_API_KEY`
- Framelink_Figma_MCP → `YOUR_FIGMA_API_KEY`

## Doctor (verify setup)

```bash
loop-free doctor
```

This reports missing skills, unconfigured MCP entries, and placeholders, as well as live connection status from `opencode mcp list`.

## Installing missing MCPs/skills

The installer only copies config + loop files. It does **not** download MCP npm packages (NPX/PXE) — they are resolved at runtime. OAuth servers (Vercel, Postman, Sentry) need a final browser consent: `opencode mcp auth <server>`.

## Publish

```bash
npm pack
npm publish --access public
gh repo create acrticsludge/loop-free --public --source=. --push
```

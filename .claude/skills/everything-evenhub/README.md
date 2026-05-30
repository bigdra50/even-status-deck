# everything-evenhub (vendored)

A repo-bundled copy of the
[`even-realities/everything-evenhub`](https://github.com/even-realities/everything-evenhub)
Claude Code plugin (v0.0.1, MIT — see [`LICENSE`](./LICENSE)). Bundling it here
means the skills travel with the repo: clone it on any machine and the skills
load with no plugin install or marketplace step.

## How it loads

This directory is a **skills-directory plugin**: `.claude-plugin/plugin.json` +
`skills/*/SKILL.md`. Because it lives under the repo's `.claude/skills/`, Claude
Code discovers it as a project-scope plugin named `everything-evenhub@skills-dir`
and the skills keep their namespace — invoke them as `everything-evenhub:glasses-ui`
(not flattened to `glasses-ui`).

First time in a fresh clone: accept the workspace trust dialog, then run
`/reload-plugins` (or relaunch) so the project-scope plugin is scanned and enabled.

## Skills

| Skill | Purpose |
| --- | --- |
| `quickstart` | Scaffold a new G2 app (Vite + TS + SDK + simulator) |
| `template` | Scaffold from a starter template (minimal/asr/image/text-heavy) |
| `glasses-ui` | Glasses display UI on the 576x288 canvas |
| `handle-input` | Touchpad / ring input, scroll, lifecycle, event routing |
| `device-features` | Mic audio, IMU, device/user info, local storage |
| `background-state` | `setBackgroundState` + `onBackgroundRestore` persistence |
| `font-measurement` | Pixel-accurate text layout sizing (LVGL) |
| `design-guidelines` | Display constraints, layout, icons, Unicode |
| `sdk-reference` | SDK API reference (methods, types, enums, events) |
| `cli-reference` | Even Hub CLI commands (login/init/qr/pack) |
| `build-and-deploy` | Validate `app.json`, build, pack `.ehpk`, submit |
| `simulator-automation` | Drive the simulator via its HTTP API |
| `test-with-simulator` | Launch/debug/screenshot with the desktop simulator |

## Local changes vs upstream

- `skills/template/SKILL.md`: quoted the `argument-hint` value so the YAML
  frontmatter parses (upstream leaves it unquoted, which `claude plugin validate`
  flags and which drops the skill's metadata at load time).

## Updating

Re-vendor from the upstream plugin, then re-apply the local change above:

```sh
SRC=~/.claude/plugins/marketplaces/everything-evenhub
cp "$SRC"/.claude-plugin/plugin.json .claude/skills/everything-evenhub/.claude-plugin/plugin.json
cp -R "$SRC"/skills/* .claude/skills/everything-evenhub/skills/
cp "$SRC"/LICENSE .claude/skills/everything-evenhub/LICENSE
claude plugin validate .claude/skills/everything-evenhub
```

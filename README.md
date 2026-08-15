# 🧩 Pi Extensions for the Pi Coding Agent

[![npm scope](https://img.shields.io/badge/npm-@moguw-blue)](https://www.npmjs.com/org/moguw)

Independently installable [Pi Coding Agent](https://pi.dev) extensions, managed as an npm workspace.
Every package is published separately under the `@moguw` npm scope — install only what you need.

## 🚀 Quick start

Install an extension permanently:

```bash
pi install npm:@moguw/pi-session-rename
```

Try one without adding it permanently:

```bash
pi -e npm:@moguw/pi-session-migrate
```

> [!IMPORTANT]
> Pi extensions run with your full user permissions. Review an extension before installing it from any third party.

## 📦 Choose an extension

### Session management

| Package | Use it for | Install |
| --- | --- | --- |
| [`pi-session-rename`](./extensions/pi-session-rename) | Automatically name Pi sessions from conversation context, with a manual `/rename` command. | `pi install npm:@moguw/pi-session-rename` |
| [`pi-session-migrate`](./extensions/pi-session-migrate) | Migrate a project's Pi sessions after the project moves to a new path, via `/migrate`. | `pi install npm:@moguw/pi-session-migrate` |
| [`pi-session-fork`](./extensions/pi-session-fork) | Fork the session into a Herdr pane/tab, and ask inline (in-context) or outline (out-of-context) side questions, via `/btw`. | `pi install npm:@moguw/pi-session-fork` |

### Agent tooling

| Package | Use it for | Install |
| --- | --- | --- |
| [`pi-interactive-shell`](./extensions/pi-interactive-shell) | Run interactive CLIs in observable Pi overlays with interactive, hands-free, dispatch, and monitor modes. | `pi install npm:@moguw/pi-interactive-shell` |

## 🔧 Advanced installation

Install this repository directly from GitHub as one Pi package:

```bash
pi install git:github.com/Mieluoxxx/pi-ext
```

The repository root auto-discovers every production extension under `extensions/`, so this enables all of them.

To load only selected extensions, replace the installed package entry in `~/.pi/agent/settings.json` with a resource filter:

```json
{
  "packages": [
    {
      "source": "git:github.com/Mieluoxxx/pi-ext",
      "extensions": [
        "extensions/pi-session-rename/src/index.ts",
        "extensions/pi-session-migrate/src/index.ts",
        "extensions/pi-interactive-shell/index.ts"
      ]
    }
  ]
}
```

Filters use resource paths relative to the repository root. Restart Pi or run `/reload` after changing the filter.

## 🧑‍💻 Local development

From the repository root:

```bash
npm install
npm run check
```

Try an extension from the repository root without installing it:

```bash
pi -e ./extensions/pi-session-rename
pi -e ./extensions/pi-session-migrate
pi -e ./extensions/pi-interactive-shell
```

## 🗂️ Repository structure

```text
extensions/   Independently published production Pi extensions
docs/         Repository designs and decisions
```

Each extension owns its package metadata, documentation, tests, and an explicit Pi entrypoint. Most use a thin `src/index.ts`; `pi-interactive-shell` keeps its upstream-compatible flat module layout.
The private repository root supplies workspace orchestration and is installable as one Git-backed Pi package.

## 📄 License

Each extension declares its own license in its package directory.

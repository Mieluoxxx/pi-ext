# pi-ext

Independently installable extensions for the Pi coding agent, managed as an npm workspace.

## Install

Install every production extension from GitHub:

```bash
pi install git:github.com/Mieluoxxx/pi-ext
```

Install only the session rename extension from npm:

```bash
pi install npm:@moguw/pi-session-rename
```

## Development

```bash
npm install
npm run check
```

Try the extension from the repository root:

```bash
pi -e ./extensions/pi-session-rename
```

## Repository layout

```text
extensions/  Independently published production Pi extensions
docs/        Repository designs and decisions
```

Each extension owns its package metadata, documentation, tests, and a thin `src/index.ts` Pi entrypoint. The private repository root supplies workspace orchestration and is installable as one Git-backed Pi package.

## License

Each extension declares its license in its package directory.

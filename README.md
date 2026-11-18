# SourceCraft Studio

Desktop GUI for SourceCraft CLI on Windows. Open a local project, edit UTF-8 files and run tasks with Codex or YCodex.

## Windows

Download `SourceCraft-Studio-Windows-Installer` from a successful [Windows build](https://github.com/Enot6669/Sourcecraft-cli/actions/workflows/windows.yml) and extract the installer. Install the [official SourceCraft CLI](https://sourcecraft.dev/portal/docs/en/sourcecraft/operations/cli-quickstart) separately.

Studio looks for `src.exe` in `PATH` and in `%LOCALAPPDATA%\Programs\src`. Use **Настройки CLI** to select a different executable, switch back to automatic detection or check sign-in. Sign in with `src auth login` in a terminal.

## Development and tests

Use Node.js 24.

```powershell
npm ci
npm test
npm run desktop:dev
npm run dist:win
```

The installer is written to `release/`. See [Windows smoke tests](tests/SMOKE_TEST.md) for the manual checks.

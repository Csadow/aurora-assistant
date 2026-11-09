# Aurora

Aurora is an experimental personal assistant for a local Linux desktop. It combines
chat, an editable Markdown memory vault, daily planning, and reviewed actions. A
local Ollama model can handle chat and tools; optional cloud connections require
separate setup and an explicit preview before information is sent.

This repository is a source snapshot of desktop **1.154.0**. It does not contain
personal notes, conversations, credentials, model weights, development artifacts,
or the original machine's Git history. The software is still being developed for
a single trusted desktop user. It has not been prepared as a general installer.

## What is included

- Markdown notes with links, history, search, and reviewed memory corrections.
- Tasks, weekly classes, daily planning, briefings, and review history.
- Local chat and agent workflows with scoped file, browser, and system tools.
- Exact action reviews, saved workflow checkpoints, recovery, and backups.
- An Electron desktop shell and an experimental offline Android source tree.

Automated tests cover many safety and recovery rules. They do not establish that
the local model will complete arbitrary tasks reliably. Cloud services and Google
Calendar need your own accounts; the app must never be exposed as a network service.

## Run the local web app

Requirements: Linux, Node.js 24 or newer, and a locally running Ollama instance.
Set `AURORA_MODEL` to a model you already have. The default is `qwen3.5:4b`;
the original developer currently uses `qwen3.5:9b` with thinking enabled.

```sh
git clone https://github.com/Csadow/aurora-assistant.git
cd aurora-assistant
AURORA_MODEL=qwen3.5:4b node scripts/start.mjs
```

Open `http://127.0.0.1:4717` on the same computer. On first start Aurora creates a
Markdown vault in `~/Documents/Aurora Memory` and app state in
`~/.local/share/aurora-assistant`. Set `AURORA_VAULT` and `AURORA_DATA` before the
first run if you want different locations. Keep those directories out of Git.
`AURORA_TIMEZONE` overrides the detected local timezone. The app binds to
loopback and assumes a single trusted OS account.

The Electron shell is started with `node scripts/start-desktop.mjs`. Desktop installation expects a
local Electron distribution: set `AURORA_ELECTRON_SOURCE` to its `dist` directory
before running `node scripts/install-desktop.mjs`. Review that installer first; it writes a
desktop entry and runtime files under your home directory. Voice, screen control,
and mobile builds have additional Linux/Android prerequisites.

## Development

```sh
node --test --test-concurrency=4 tests/*.test.mjs
node scripts/browser-test.mjs
```

The browser suite requires Chromium. Some scripts in `scripts/` are hardware,
account, or local-model trials and may change a temporary or personal workspace;
read a script before running it. The main backend tests use isolated fixtures.
See [mobile/README.md](mobile/README.md) for the experimental Android build.

Source layout: `src/` is the local service and workflow engine, `public/` is the
browser UI, `desktop/` is the Electron shell, `mobile/` is the Android source,
and `tests/` contains regression checks. `src/config.mjs` holds local defaults;
use environment variables and the app's settings for your own configuration.

## Data and safety

User notes, chat history, saved actions, credentials, backups, and unsaved drafts
belong outside the source tree. Back up your vault and app data before upgrading.
Action previews show the exact proposed effect; approving one action does not
authorize a later action. Local model output can be mistaken, so verify important
results against saved files and action history.

## License

Aurora's original source in this repository is available under the [MIT License](LICENSE).
External models, services, and tools have their own terms. No external character
art or model weights are included.

# Shusseki — agent setup

This repo is an **npm workspaces** monorepo. You need **Node** (v24.18.1 is
verified with Expo SDK 52; an LTS works too) and **npm** (ships with Node).
Bun is no longer used here (migrated in `docs/adr/0005` + `session.md`).

Useful invariants:
- Install deps: `npm install` (root; npm workspaces)
- Tests: `npm test` (Vitest, all workspaces)
- Typecheck: `npm run typecheck`
- Android build: `cd app && npx expo prebuild --platform android && cd android && ./gradlew assembleDebug`
- Quirks/troubleshooting: `arch-installation-quirks.md`

Install the agent skills globally (the `skills` CLI is an npm package; `npx`
pulls it on first use):

npx skills add https://github.com/vercel-labs/skills --skill find-skills
npx skills add https://github.com/obra/superpowers --skill test-driven-development
npx impeccable install (or get it from https://github.com/pbakaus/impeccable / https://impeccable.style)
npx skills add https://github.com/mattpocock/skills --skill improve-codebase-architecture
npx skills add https://github.com/anthropics/skills --skill skill-creator
npx skills add https://github.com/vercel-labs/agent-skills --skill vercel-react-native-skills
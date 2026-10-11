# AGENTS.md — MusicForStudio

Non-obvious knowledge for working in this project. Facts readable from the code are not repeated here.

## Environment & recovery

- This folder has NO git repository (`git status` fails). Never assume git history; "lost file" recovery uses `dist/assets/index-*.js` (previous build bundle, minified but complete) and `server/__pycache__/musicgen_server.cpython-311.pyc` (Python 3.11 bytecode — disassemble with `dis`/`marshal`, reconstruct, then diff `compile(src)` bytecode against the original to prove exactness).
- npm's allow-scripts policy blocks esbuild's postinstall → `vite build` fails confusingly. Fix: run `node node_modules/esbuild/install.js` after `npm install`.
- Preview's htmlPath mode cannot serve sibling files (404s on JS/CSS). Serve a Vite app via a detached dev server instead: `node -e "require('child_process').spawn('npx vite --port 5199 --strictPort',{detached:true,stdio:'ignore',shell:true}).unref()"`, then register_preview with the URL. Port 5173 is the project default (used by the user's own runs).
- Python console on this machine is cp1252; disassembly/tests printing unicode (docstrings with `→`) need `PYTHONIOENCODING=utf-8`.

## Architecture & data ownership

- `src/family.js` owns ALL member-record policy: validation (names, optional emails via `normalizeEmail`), passcode hashing/upgrade, session unlock, member switch, seeding/migration. Consumers must call its API (`setMemberProfile`, `switchToMember`, `openAddMember`) and never re-implement validation or dialog-opening recipes.
- The Add-member dialog lives INSIDE the login dialog (`#famAdd` opened via `#famAddLink` after `openLogin()` + 60ms). The shared entry point is `family.js: openAddMember()` — copy that recipe nowhere.
- Browser-native form validation on the family dialogs would silently swallow submit; the `<form>`s carry `novalidate` so `family.js`'s styled errors are authoritative. Keep that attribute when editing the dialogs.
- Owner record: stored in localStorage `mfs.members.v1`, seeded as `DreamHitcherS` (`OWNER_DISPLAY_NAME` in family.js). A one-time migration in `loadMembers()` renames stored owners still called "Owner". Passcode hash survives renames; default passcode `1234` (OWNER_DEFAULT_PASSCODE).
- Account UI lives in `src/account.js` as a SECTION inside the Settings view (no Account tab; main.js passes `{toast, repaint, openVoiceRecorder}` hooks and a `#accountPanel` host div). Modules must not import main.js — it owns `$`, `toast`, `setView`; extracted modules define their own helpers or take hooks.
- The Account section and the account chip both repaint the library on member switch via `initFamily`'s `onSwitch` callback — switch paths must go through `switchToMember()`/`setActiveMember()` so that fires.
- `dist/` is a disposable build artifact, never committed or restored — regenerate with `npx vite build`.

## App behavior quirks

- Whole views re-render on navigation; long multi-step `preview_evaluate` scripts race page reloads (Vite reloads on file saves mid-script) and get null element errors. Probe state first, run steps in small guarded chunks, and re-check before interacting.
- Login dialog auto-opens on load whenever the active member isn't unlocked (`initFamily` → `openLogin`). Tests that reset `mfs.session.v1` must reload before expecting UI state.
- The header fits its 9 tabs via the responsive ladder in `style.css` (>1500px labels, ≤1500px tight padding, ≤1440px icon-only with tooltips, tabs strip scrolls as last resort). Adding a 10th tab: re-check the 1500/1440 breakpoints against real tab widths.
- `server/musicgen_server.py` (recovered from .pyc) serves `/api/health` + `/api/generate`; browser client contract lives in `src/server.js` (`checkServer` expects `{ok:true,...}`, generate returns WAV bytes). ACE-Step flows differ (`/release_task` + `/query_result` polling).
- Anchor chip-navs (Settings / Learn / Workspace) share `anchorNavHtml` + `wireAnchorNav` in main.js: key doubles as hash namespace and `state.view` name; sections default to `#<key>-<id>` (Settings) or map via `sectionSel`/`data-anchor-section` (Learn lesson cards). Spies hang on `#content` under `el.__spyCleanups[key]` and are replaced on re-render — never add a second one. Only chip-backed sections are spied (Settings appearance/autoexport have no chips; highlight sticks to last anchor passed); the bottom edge pins the last chip. Hash routers are one declarative `hashRouters` map in init() (settings/workspace/learn + library/explore with `apply` state hooks); `#lesson=<id>` keeps its own richer landing (scroll+flash+toast) and syncs the chip. Library/Explore mirror their filter back to the hash on click.
- `#content` is the app's scroll container: `scrollIntoView` is a silent no-op — use the shared `scrollContentTo()` (rect-based; `offsetTop` breaks under positioned ancestors). Smooth scrolling is unreliable in embedded previews: always instant jumps. Native scroll events can stop dispatching in a degraded preview webview — verify spies with `el.dispatchEvent(new Event('scroll'))` before blaming app code. A degraded webview also stops firing `requestAnimationFrame` entirely: use `setTimeout` for post-paint work (the per-view scroll restore broke on rAF). The restore is keyed per view in `viewScrollPos` and a `#<view>=` hash on the incoming view always wins over the saved position.
- Player transport (shuffle/repeat) lives in `state.shuffle`/`state.repeat`, persisted in settings; playback order is `state.order` (view-scoped) falling back to `visibleOrder()`. `renderNowPlaying` is the single sync point for transport-button state AND Media Session metadata (`syncMediaSession`) — don't set `navigator.mediaSession` elsewhere. The `<audio>` element is JS-created inside `Player`, never in the DOM.

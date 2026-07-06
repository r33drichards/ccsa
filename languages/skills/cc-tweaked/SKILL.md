---
name: cc-tweaked
description: >-
  Reference for writing, debugging, and reviewing Lua programs for CC: Tweaked
  (ComputerCraft) — the Minecraft mod that adds programmable computers, turtles,
  pocket computers, and peripherals running CraftOS. Use this skill WHENEVER the
  task involves CC: Tweaked or ComputerCraft Lua: turtle automation (mining,
  building, farming), peripheral control (monitors, modems, speakers, drives,
  chests/inventories), rednet/modem networking, the event loop (os.pullEvent),
  the fs/term/shell APIs, startup scripts, or any `.lua` program meant to run on
  an in-game computer. Trigger this even when the user just says "CC", "CC:T",
  "CraftOS", "turtle program", "computercraft", names an API like turtle/fs/
  peripheral/rednet/redstone, or pastes CC Lua code — do not rely on memory for
  signatures, since CC: Tweaked's APIs differ from standard Lua and change
  between versions.
---

# CC: Tweaked (ComputerCraft) Lua

CC: Tweaked adds programmable computers to Minecraft, programmed in **Lua (Cobalt VM: Lua 5.1 + selected 5.2/5.3 features)**. Programs run under **CraftOS**. This skill is a distilled reference scraped from the official docs at https://tweaked.cc/. When you need an exact, exhaustive signature beyond what's here, fetch the canonical page `https://tweaked.cc/module/<name>.html` (or `/peripheral/`, `/library/`, `/event/`, `/guide/`, `/reference/`).

## The mental model (read this first)

1. **Event-driven, cooperative concurrency.** A program runs until it *yields* by waiting for an event. There is no preemption. The primitive is `os.pullEvent([filter])` (aborts on `terminate`) / `os.pullEventRaw` (you handle `terminate`). `sleep`, `read`, `rednet.receive`, etc. all yield internally. Run several loops at once with `parallel.waitForAny`/`waitForAll`. See `references/events.md`.
2. **Peripherals are wrapped tables.** Hardware (monitors, modems, speakers, chests) is reached via the `peripheral` API by side name (`"top"`, `"left"`, …) or wired-network name (`"monitor_0"`). `peripheral.wrap(name)` or `peripheral.find(type)` give you a table of methods. See `references/modules/peripheral.md`.
3. **Turtle/peripheral actions return `ok, err`** rather than throwing — check the result or `assert(turtle.forward())`.
4. **`fs` uses absolute paths**; convert relative paths with `shell.resolve`. `shell` is injected into programs, not a true global, so it isn't available inside `require`d libraries.
5. **Terminals are "Redirects".** `term`, monitors, and `window` objects all share the same method set; `term.redirect(target)` sends output elsewhere. See `references/modules/term.md`.

Minimal program shape:
```lua
local speaker = peripheral.find("speaker")
while true do
  local event, p1, p2, p3 = os.pullEvent()
  if event == "key" and p1 == keys.q then break end
  -- handle other events…
end
```

## How to use this skill

- For the **core APIs**, open the matching file in `references/modules/` or `references/peripherals/` before writing code that uses it. They contain full signatures, return shapes, gotchas, and examples.
- For **anything event-related**, read `references/events.md` (payload shapes for all 36 events).
- For **data shapes** (block/item details), startup behaviour, Lua-compat, and version gotchas, read `references/reference/reference-topics.md`.
- For **common workflows** (require/libraries, startup, GPS, audio, HTTP local IPs), read `references/guides/guides.md`.
- If you can run code, note CC Lua can't execute in this sandbox (it needs the mod or an emulator like CraftOS-PC); reason from the reference and write correct, idiomatic CraftOS Lua.

## Local reference codebases (full upstream source)

On the languages/skills sandbox, the **full source of four CC / CraftOS projects** is mounted **read-only** at `/opt/languages/codebases/` (browse with `fs.readdir('/opt/languages/codebases')`, read with `fs.readFile`). Use it as ground truth when the distilled reference above (or the docs at tweaked.cc) isn't enough — e.g. to check exact behaviour, an undocumented method, a peripheral's real implementation, or a Lua-compat edge case. Grep/read it; it is read-only, so keep scratch work under `/work`.

- **`codebases/craftos2/`** — [MCJack123/craftos2](https://github.com/MCJack123/craftos2), CraftOS-PC (the CC:Tweaked emulator, C++). This is what the `craftos` engine is built from, so it's the closest reference for how APIs/peripherals actually behave. Look under `src/` (`apis/`, `peripheral/`, `terminal/`).
- **`codebases/cobalt/`** — [cc-tweaked/Cobalt](https://github.com/cc-tweaked/Cobalt), the Lua VM (Java) CC:Tweaked runs on. Ground truth for the "Lua 5.1 + selected 5.2/5.3" quirks — string/number coercion, metatables, `load`/`pcall`, coroutine semantics.
- **`codebases/reconnected-docs/`** — [ReconnectedCC/docs](https://github.com/ReconnectedCC/docs), docs for the ReconnectedCC server: CC APIs, guides, and server-specific additions (ReconnectedChat, custom peripherals) you won't find on tweaked.cc.
- **`codebases/re-plethora/`** — [ReconnectedCC/Re-Plethora](https://github.com/ReconnectedCC/Re-Plethora), the Plethora peripherals / neural-interface mod (Java). Source for the extra modules and methods Plethora exposes to CC computers (manipulators, scanners, sensors, `modules`).

(Submodules aren't included — those paths are empty dirs. `codebases/README.md` lists the pinned upstream commit for each.)

## Reference file map

```
references/
  events.md                      All 36 events + payloads + patterns
  modules/
    turtle.md      fs.md   os.md   term.md   peripheral.md
    rednet.md      redstone.md     shell.md  textutils.md  http.md
    other-modules.md             _G, parallel, window, gps, settings,
                                 colors, keys, vector, paintutils,
                                 multishell, disk, io, commands, pocket, help
  peripherals/
    modem.md   speaker.md
    other-peripherals.md         monitor, drive, printer, redstone_relay,
                                 computer, command
    generic-peripherals.md       inventory, fluid_storage, energy_storage
  libraries/
    libraries.md                 cc.expect, cc.pretty, cc.strings,
                                 cc.completion, cc.shell.completion,
                                 cc.require, cc.audio.dfpwm, cc.image.nft,
                                 cc.base64
  reference/
    reference-topics.md          block/item/entity details, startup,
                                 exceptions, Lua compat, breaking changes
  guides/
    guides.md                    require, startup, GPS, speaker audio, local IPs
```

## Full API index (one-liners)

### Global APIs (`references/modules/`)
- **`_G`** — globals from bios.lua: `print`, `write`, `read`, `printError`, `sleep`, `_HOST`. → other-modules.md
- **`colors`/`colours`** — 16 colour constants + `combine`/`subtract`/`test`/`toBlit`. → other-modules.md
- **`commands`** — run Minecraft commands (command computer). → other-modules.md
- **`disk`** — disk-drive convenience by side. → other-modules.md
- **`fs`** — files, paths, handles. → fs.md
- **`gps`** — locate position via wireless modems. → other-modules.md
- **`help`** — built-in help topics. → other-modules.md
- **`http`** — HTTP(S) requests + WebSockets. → http.md
- **`io`** — Lua-style IO. → other-modules.md
- **`keys`** — keyboard key codes (for `key` event). → other-modules.md
- **`multishell`** — tabbed shells. → other-modules.md
- **`os`** — events, timers, IDs, time, run, shutdown. → os.md
- **`paintutils`** — pixels/lines/images on the term. → other-modules.md
- **`parallel`** — run functions concurrently. → other-modules.md
- **`peripheral`** — find/wrap/call peripherals. → peripheral.md
- **`pocket`** — pocket computer upgrades. → other-modules.md
- **`rednet`** — friendly modem messaging + DNS-like lookup. → rednet.md
- **`redstone`** (`rs`) — read/set redstone, analogue, bundled. → redstone.md
- **`settings`** — persisted config. → other-modules.md
- **`shell`** — CLI: run programs, path, aliases, completion. → shell.md
- **`term`** — write text, cursor, colours, blit, redirect. → term.md
- **`textutils`** — formatting + serialise/JSON. → textutils.md
- **`turtle`** — move, dig, place, inventory, fuel, craft. → turtle.md
- **`vector`** — 3D vector type. → other-modules.md
- **`window`** — a Redirect over a region (buffering/UIs). → other-modules.md

### Libraries — `require("cc.…")` (`references/libraries/libraries.md`)
`cc.audio.dfpwm` (audio codec), `cc.base64`, `cc.completion`, `cc.expect` (arg validation), `cc.image.nft` (terminal images), `cc.pretty` (pretty printer), `cc.require`, `cc.shell.completion`, `cc.strings` (wrap/split/pad).

### Peripherals (`references/peripherals/`)
- **`modem`** — channels, transmit, wired remote peripherals. → modem.md
- **`speaker`** — playNote/playSound/playAudio. → speaker.md
- **`monitor`** — external/tiled display (a Redirect). → other-peripherals.md
- **`drive`** — floppy disks / mountable media. → other-peripherals.md
- **`printer`** — print pages. → other-peripherals.md
- **`redstone_relay`** — remote redstone over a network. → other-peripherals.md
- **`computer`** — control another computer/turtle. → other-peripherals.md
- **`command`** — drive a command block. → other-peripherals.md

### Generic peripherals (`references/peripherals/generic-peripherals.md`)
- **`inventory`** — chests/barrels: `size`/`list`/`getItemDetail`/`pushItems`/`pullItems`.
- **`fluid_storage`** — tanks: `tanks`/`pushFluid`/`pullFluid`.
- **`energy_storage`** — `getEnergy`/`getEnergyCapacity` (Forge Energy).

### Events (`references/events.md`)
Input: `char`, `key`, `key_up`, `paste`, `mouse_click`, `mouse_up`, `mouse_scroll`, `mouse_drag`, `terminate`.
Scheduling: `timer`, `alarm`, `task_complete`.
Display: `term_resize`, `monitor_resize`, `monitor_touch`.
Hardware: `peripheral`, `peripheral_detach`, `redstone`, `disk`, `disk_eject`, `turtle_inventory`.
Network: `modem_message`, `rednet_message`.
HTTP/WS: `http_success`, `http_failure`, `http_check`, `websocket_success`, `websocket_failure`, `websocket_message`, `websocket_closed`.
Other: `speaker_audio_empty`, `file_transfer`, `computer_command`, `setting_changed`.

## Idioms & gotchas

- Always check turtle results: `if not turtle.forward() then ... end`. Movement fails silently (often out of fuel).
- Wrap long-running programs so `terminate` (Ctrl+T) can clean up: use `pcall` + `os.pullEventRaw`.
- Don't busy-loop polling redstone/inputs; wait on the relevant event (`os.pullEvent("redstone")`).
- `peripheral.find(type)` is location-independent and returns *wrapped* tables; multiple results need `{ peripheral.find(type) }`.
- For network item routing, both inventories must be on the **same wired-modem network**; address the target by its network name.
- `error("msg", 0)` suppresses the `file:line:` prefix for clean user-facing errors.
- Persisting data: open a file with `fs.open(path, "w")`, write `textutils.serialize(tbl)`, `close()`; read back with `unserialize`.
- Monitors and windows are Redirects — you can `term.redirect(mon)` and reuse all your `print`/`write` code.
- `require` needs the module on the package path and uses `.`-separated names; it is unavailable inside `os.loadAPI` libraries.

This reference reflects CC: Tweaked as documented on tweaked.cc (latest stable, MC 1.21.x line). Always prefer feature detection over hardcoding a CraftOS version.

# Other peripherals

Canonical docs at https://tweaked.cc/peripheral/<name>.html. (modem and speaker have their own files.)

## monitor

A block that acts as an external terminal; multiple can be tiled into one big display. A monitor is a `term.Redirect`, so all `term` methods work on the wrapped object. Plus:
- `setTextScale(scale)` / `getTextScale()` → text scale 0.5-5.0 (changes effective resolution).
- All term methods: `write`, `blit`, `clear`, `clearLine`, `setCursorPos`, `getSize`, `setTextColour`, `setBackgroundColour`, `setPaletteColour`, `isColour`, `scroll`, etc.
- Advanced (gold) monitors are touch-enabled and fire `monitor_touch` (`event, side, x, y`). Resizing fires `monitor_resize`.

```lua
local mon = peripheral.find("monitor")
mon.setTextScale(0.5)
mon.clear(); mon.setCursorPos(1,1); mon.write("Hello")
-- or redirect term output to it:
term.redirect(mon)
```

## drive (disk drive)

Read/write floppy disks and other mountable media (computers, music discs).
- `isDiskPresent()` → `boolean`
- `getDiskLabel()` / `setDiskLabel(label)`
- `hasData()` → `boolean`; `getMountPath()` → `string|nil` (where the disk is mounted, e.g. `"disk"`).
- `hasAudio()` → `boolean`; `getAudioTitle()` → `string|nil|false`; `playAudio()`; `stopAudio()`.
- `ejectDisk()`
- `getDiskID()` → `number|nil` (for floppy disks).

Disk insert/remove fires `disk` / `disk_eject` events.

## printer

Print text onto paper pages, optionally bound into books.
- `newPage()` → `boolean` — start a new page (needs paper + ink). 
- `endPage()` → `boolean` — finish and output the current page.
- `write(text)` — write at the cursor (no wrapping).
- `setCursorPos(x, y)` / `getCursorPos()` / `getPageSize()` → `width, height`.
- `setPageTitle([title])`
- `getInkLevel()` → `number`; `getPaperLevel()` → `number`.

## redstone_relay

A peripheral exposing the full `redstone` API on its own six sides (so a computer can read/write redstone remotely over a wired network). Methods mirror the `redstone` module: `getSides`, `setOutput`/`getOutput`/`getInput`, analogue variants, bundled variants, `testBundledInput`. Fires `redstone` events.

## computer

A computer or turtle wrapped as a peripheral (e.g. adjacent, or over a wired network).
- `turnOn()`, `shutdown()`, `reboot()`
- `getID()` → `number`
- `isOn()` → `boolean`
- `getLabel()` → `string|nil`

## command (command block)

Control an adjacent command block from a command computer.
- `getCommand()` / `setCommand(command)`
- `runCommand()` → `boolean, string|nil` — run the set command, returning success and output.

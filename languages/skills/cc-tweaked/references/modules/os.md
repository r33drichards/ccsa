# os

Interact with the current computer: events, timers, IDs, labels, time/date, shutdown.

Source: https://tweaked.cc/module/os.html

## Events (core of the CC concurrency model)

CC:Tweaked is event-driven. A program runs until it yields by waiting for an event; other coroutines run meanwhile.

- `pullEvent([filter])` → `event, param...` — yield until an event (optionally matching `filter`) fires. On a `terminate` event it aborts the program with "Terminated".
- `pullEventRaw([filter])` → `event, param...` — like `pullEvent` but does NOT abort on `terminate`; you handle it yourself (Ctrl+T won't stop the program).
- `queueEvent(name, ...)` — push a custom event onto the queue. Params may be booleans, numbers, strings, tables (no functions/metatables).

Example — event loop:
```lua
while true do
  local event, button, x, y = os.pullEvent("mouse_click")
  print("Button", button, "clicked at", x, y)
end
```

Example — multiplex events:
```lua
while true do
  local e = {os.pullEvent()}
  if e[1] == "mouse_click" then ...
  elseif e[1] == "key" then ... end
end
```

Example — trap terminate:
```lua
while true do
  local event = os.pullEventRaw()
  if event == "terminate" then print("Caught terminate!") end
end
```

## Timers and alarms

- `sleep(time)` — pause `time` seconds (rounded up to a 0.05s tick). Alias of `_G.sleep`.
- `startTimer(time)` → `number` (id) — fires a `timer` event after `time` seconds; the id is the event's first param.
- `cancelTimer(token)` — cancel a pending timer.
- `setAlarm(time)` → `number` (id) — fires an `alarm` event at in-game `time` in `[0.0, 24.0)`.
- `cancelAlarm(token)` — cancel an alarm.
- `clock()` → `number` — seconds the computer has been running (good for measuring elapsed real-ish time).

## Time and date

Locales: `"ingame"` (default), `"utc"`, `"local"`.
- `time([locale])` → time in `[0.0, 24.0)`. Also accepts a `date("*t")` table and converts it to a UNIX timestamp.
- `day([locale])` → days since world creation (ingame) or since 1970 (utc/local).
- `epoch([locale])` → ms since epoch. Note: ingame ms run fast — 1 real second = 72000 ingame ms; divide by 72000 for real seconds, by 3600 for ticks.
- `date([format [, time]])` → date string, or a table if format is `"*t"`/`"!*t"`. Uses C `strftime` formats; prefix `!` for UTC. The table has year/month/day/hour/min/sec/wday/yday/isdst and round-trips through `os.time`.

Example:
```lua
local t = os.epoch("local") / 1000          -- ms → s
local tbl = os.date("*t", t)
print(textutils.serialize(tbl))
```

## Computer identity

- `getComputerID()` / `computerID()` → `number`
- `getComputerLabel()` / `computerLabel()` → `string|nil`
- `setComputerLabel([label])` — set or clear (`nil`) the label.
- `version()` → `string` (e.g. `"CraftOS 1.9"`). Prefer feature detection over version comparison. See `_HOST` for host info.

## Running programs / power

- `run(env, path, ...)` → `boolean` — run program at exact `path` with env table and args. Does NOT resolve program names or provide the `shell` API — use `shell.run` for that. e.g. `os.run({}, "/rom/programs/shell.lua")`.
- `shutdown()` — power off immediately.
- `reboot()` — reboot immediately.

## Deprecated

- `loadAPI(path)` / `unloadAPI(name)` — pollutes `_G` and masks errors. Use `require` (see `cc.require`) instead.

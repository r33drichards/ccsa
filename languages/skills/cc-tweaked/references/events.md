# Events

CC:Tweaked is event-driven. Get events with `os.pullEvent([filter])` (aborts on `terminate`) or `os.pullEventRaw([filter])` (lets you handle `terminate`). The first return is the event name; the rest are payload values listed below. Push your own with `os.queueEvent(name, ...)`.

Canonical per-event docs at https://tweaked.cc/event/<name>.html.

## Input

| Event | Payload (after event name) |
|---|---|
| `char` | `character` (string, a typed character) |
| `key` | `keycode` (see `keys`), `isHeld` (boolean, true if a repeat) |
| `key_up` | `keycode` |
| `paste` | `text` (pasted via Ctrl/⌘V) |
| `mouse_click` | `button` (1=left,2=right,3=middle), `x`, `y` |
| `mouse_up` | `button`, `x`, `y` |
| `mouse_scroll` | `direction` (-1 up, 1 down), `x`, `y` |
| `mouse_drag` | `button`, `x`, `y` |
| `terminate` | (none) — fired on Ctrl+T held |

## Timers / scheduling

| Event | Payload |
|---|---|
| `timer` | `id` (matches `os.startTimer` / `sleep` internals) |
| `alarm` | `id` (matches `os.setAlarm`) |
| `task_complete` | `id`, `success`, `error_or_results...` — async task done |

## Terminal / display

| Event | Payload |
|---|---|
| `term_resize` | (none) — main terminal size changed |
| `monitor_resize` | `side` — a monitor was resized |
| `monitor_touch` | `side`, `x`, `y` — advanced monitor right-clicked |

## Peripherals / redstone / disk

| Event | Payload |
|---|---|
| `peripheral` | `side` — peripheral attached |
| `peripheral_detach` | `side` — peripheral detached |
| `redstone` | (none) — a redstone input changed |
| `disk` | `side` — disk inserted |
| `disk_eject` | `side` — disk removed |
| `turtle_inventory` | (none) — turtle's inventory changed |

## Networking

| Event | Payload |
|---|---|
| `modem_message` | `side`, `channel`, `replyChannel`, `message`, `distance` (nil for wired/ender) |
| `rednet_message` | `senderId`, `message`, `protocol` |

## HTTP / WebSocket

| Event | Payload |
|---|---|
| `http_success` | `url`, `response` (a Response handle) |
| `http_failure` | `url`, `errmsg`, `response` (or nil) |
| `http_check` | `url`, `success`, `errmsg` (from `http.checkURLAsync`) |
| `websocket_success` | `url`, `websocket` |
| `websocket_failure` | `url`, `errmsg` |
| `websocket_message` | `url`, `message`, `isBinary` |
| `websocket_closed` | `url`, `reason`, `code` |

## Other

| Event | Payload |
|---|---|
| `speaker_audio_empty` | `side` — speaker buffer drained; safe to `playAudio` again |
| `file_transfer` | `files` (a TransferredFiles object; call `:getFiles()`) — user drag-dropped files |
| `computer_command` | `args...` — `/computercraft queue` ran for this command computer |
| `setting_changed` | `name`, `value` — a setting changed via the `settings` API |

## Patterns

Dispatch loop:
```lua
while true do
  local e = { os.pullEvent() }
  local name = e[1]
  if name == "key" then ...
  elseif name == "mouse_click" then ...
  elseif name == "terminate" then return end
end
```

Timeout with a timer:
```lua
local timer = os.startTimer(5)
while true do
  local event, id = os.pullEvent()
  if event == "timer" and id == timer then break        -- timed out
  elseif event == "rednet_message" then ... break end
end
```

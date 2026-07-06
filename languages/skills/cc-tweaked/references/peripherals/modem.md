# modem (peripheral)

Send messages between computers over channels. Low-level and flexible; `rednet` is the friendly wrapper on top.

Source: https://tweaked.cc/peripheral/modem.html

## Channels & messages

Channels are integers 0-65535. Any modem can transmit on a channel, but only modems that have `open`ed it receive messages. Reserved-by-convention: `gps` uses 65534 (`gps.CHANNEL_GPS`); `rednet` uses channels equal to computer IDs.

Send with `transmit`; receive by handling the `modem_message` event.

## Modem types
- **Wireless**: any-to-any within 64 blocks; range grows linearly above y=96 up to 384 at world height.
- **Ender**: wireless with no range limit and cross-dimension.
- **Wired**: messages to other wired modems on the same Networking Cable network; also used to attach remote peripherals.

`isWireless()` → `boolean` distinguishes wireless/ender from wired.

## Core methods

- `open(channel)` — start listening on a channel.
- `isOpen(channel)` → `boolean`
- `close(channel)` — stop listening on one channel.
- `closeAll()` — close all channels.
- `transmit(channel, replyChannel, message)` — broadcast `message` on `channel`, suggesting `replyChannel` for responses. `message` may be any primitive or table (no functions/metatables).
- `isWireless()` → `boolean`

## modem_message event

`event, side, channel, replyChannel, message, distance` — `distance` is `nil` for wired/ender modems, otherwise blocks to sender.

Request/response pattern:
```lua
local modem = peripheral.find("modem") or error("No modem attached", 0)
modem.open(43)                          -- listen for replies
modem.transmit(15, 43, "Hello, world!") -- send on 15, reply to 43
local event, side, channel, replyChannel, message, distance
repeat
  event, side, channel, replyChannel, message, distance = os.pullEvent("modem_message")
until channel == 43
print(message)
```

## Wired-network remote peripherals

A wired modem exposes peripherals elsewhere on its cable network:
- `getNamesRemote()` → `{ string... }` — names of peripherals on the network.
- `isPresentRemote(name)` → `boolean`
- `getTypeRemote(name)` → `string...`
- `hasTypeRemote(name, type)` → `boolean|nil`
- `getMethodsRemote(name)` → `{ string... }`
- `callRemote(name, method, ...)` → method results.
- `getNameLocal()` → `string|nil` — this modem's own name on the network (used so other computers can address it).

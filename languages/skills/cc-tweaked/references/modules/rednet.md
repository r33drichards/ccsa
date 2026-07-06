# rednet

A friendly abstraction over the `modem` peripheral for computer-to-computer messaging.

Source: https://tweaked.cc/module/rednet.html

## How it works

Each computer needs a modem (on a side, or equipped as a turtle/pocket upgrade). Call `rednet.open(side)` on each, then `send`/`receive`/`broadcast`. Opening a modem listens on two channels: the computer's ID and the broadcast channel.

**Security**: rednet provides NO security. Others can eavesdrop or spoof messages. On untrusted multiplayer servers, encrypt/sign your messages yourself.

## Constants

- `CHANNEL_BROADCAST = 65535` — broadcast channel.
- `CHANNEL_REPEAT = 65533` — used to repeat messages.
- `MAX_ID_CHANNELS = 65500` — channels reserved for computer IDs (IDs ≥ this wrap to 0).

## Opening / closing

- `open(modem)` — open a named modem for rednet. Throws if no such modem. Trick: `peripheral.find("modem", rednet.open)` opens all modems.
- `close([modem])` — close one modem, or all if omitted.
- `isOpen([modem])` → `boolean`

## Messaging

- `send(recipient, message [, protocol])` → `boolean` — send to a specific computer ID. `message` may be numbers/booleans/strings/tables (no functions/metatables). Return only indicates rednet was open, NOT delivery.
- `broadcast(message [, protocol])` — send to every rednet computer on `CHANNEL_BROADCAST`.
- `receive([protocol_filter [, timeout]])` → `id, message, protocol` | `nil` (on timeout) — wait for a message. `protocol_filter` discards non-matching messages.

Examples:
```lua
rednet.open("back")
rednet.send(2, "Hello from rednet!")

-- receive with timeout
local id, msg = rednet.receive(nil, 5)
if not id then printError("No message received") else print(id, msg) end

-- wait specifically for computer #2
local id, msg
repeat id, msg = rednet.receive() until id == 2
```

## Protocols & service discovery (DNS-like)

A "protocol" is a string label on a message; `receive` can filter by it. Computers can advertise a protocol under a hostname so others can look them up.

- `host(protocol, hostname)` — advertise. `localhost` is reserved; duplicate name+protocol on a network throws. Responds to lookups via a background process.
- `unhost(protocol)` — stop advertising.
- `lookup(protocol [, hostname [, timeout=2]])` → `id...` (all hosts) or `id|nil` (when hostname given). `timeout` param added in 1.118.0.

```lua
local hosts = { rednet.lookup("chat") }       -- all chat hosts
local id = rednet.lookup("chat", "my_host")    -- specific host
```

## Internals

- `run()` — the background process that converts `modem_message` events into rednet messages. Started automatically; you normally don't call it.

## Related event

- `rednet_message` — fired when a rednet message arrives: `event, sender_id, message, protocol`.

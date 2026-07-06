# Guides

Condensed from https://tweaked.cc/guide/<name>.html.

## Reusing code with require

A library is a Lua file that returns a table of functions. Load it with `require`, which is available to programs (the shell sets up the package path):
```lua
-- mylib.lua
local M = {}
function M.greet(name) print("Hi " .. name) end
return M
```
```lua
-- program.lua
local mylib = require("mylib")     -- no .lua extension; relative to package.path
mylib.greet("world")
```
Notes:
- `require` caches modules — the file runs once; later requires return the same table.
- Module names use `.` as a path separator (`require("foo.bar")` → `foo/bar.lua`).
- Prefer `require` over the deprecated `os.loadAPI`.
- In a fully custom environment, build a `require` with `cc.require.make(env, dir)`.

## Running programs on computer startup

To auto-run on boot, create `/startup.lua` (or put files in `/startup/`, run alphabetically). Common uses: launch a GPS host, start a server, set the label. Example startup that opens rednet:
```lua
peripheral.find("modem", rednet.open)
shell.run("myserver")
```

## Setting up GPS

`gps.locate()` trilaterates the computer's position from GPS host computers broadcasting on `gps.CHANNEL_GPS` (65534).
- You need at least 4 GPS hosts in modem range (3 can work if unambiguous), each running `gps host <x> <y> <z>` with its true coordinates, each with a wireless/ender modem.
- Hosts should be spread out (not coplanar) and placed high for range.
- The locating computer needs a wireless/ender modem and just calls `gps.locate()`.

## Playing audio with speakers

`speaker.playAudio(samples)` streams 8-bit PCM (amplitudes -128..127) at 48kHz. Real audio is usually stored as DFPWM and decoded on the fly:
```lua
local dfpwm = require("cc.audio.dfpwm")
local speaker = peripheral.find("speaker")
local decoder = dfpwm.make_decoder()
for chunk in io.lines("data/example.dfpwm", 16 * 1024) do
  local buffer = decoder(chunk)
  while not speaker.playAudio(buffer) do
    os.pullEvent("speaker_audio_empty")   -- buffer full; wait
  end
end
```
Convert real audio to DFPWM ahead of time (e.g. with the `music`/online converters). Push large chunks to avoid stutter.

## Allowing access to local IPs

By default the HTTP API blocks local/loopback addresses for security. To reach a server on your LAN, the server admin must edit the ComputerCraft config (the `http` rules / `allow`/`deny` lists) to permit the relevant hosts. This is a server-config change, not something a program can override. See https://tweaked.cc/guide/local_ips.html.

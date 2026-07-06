-- corner.lua
-- A box-mine CORNER reporter. Place this program on computers A and B (the two
-- opposite corners of the box). Each run it reads its OWN gps position and
-- publishes a clean "x y z" line to the mutable paste store, into a slot named
-- after the computer's label (so label computer A "A" and computer B "B").
-- The boxmine turtle reads slots A and B, computes the box, and mines it.
--
-- This is a SINGLE-PASS program built for the poll-ccraft-lua harness: it does
-- its work once and returns, never loops or blocks, and fails soft (prints a
-- status line and returns instead of error()ing) so a transient GPS hiccup
-- shows up as readable status in the <label>-out slot rather than a stack.
--
-- It reads the store base URL and its slot name from the harness's own ".poll"
-- config, so there is nothing extra to configure: set those during the normal
-- poll first-run setup (output store base URL + label).
--
-- Requires: a WIRELESS/ENDER MODEM on the computer and a GPS constellation
-- (4+ non-coplanar gps hosts) in range.

local POLL = ".poll"

-- read the harness config to learn where to publish + under what slot name
if not fs.exists(POLL) then
  print("corner: no " .. POLL .. " (run me under the poll harness, or it can't")
  print("        find the store base / slot name). aborting this pass.")
  return "no-poll-config"
end
local h = fs.open(POLL, "r")
local poll = textutils.unserialize(h.readAll())
h.close()
if type(poll) ~= "table" or not poll.store then
  print("corner: " .. POLL .. " has no store base; reconfigure the harness.")
  return "bad-poll-config"
end

local store = poll.store:gsub("/+$", "")
local slot  = poll.label or os.getComputerLabel() or ("cc" .. os.getComputerID())
if slot:match("^cc%d+$") then
  print("corner: WARNING label looks auto-generated (" .. slot .. ").")
  print("        the turtle expects slots named A and B -- relabel this computer.")
end

-- find our position
if not gps then print("corner: no gps api?!"); return "no-gps" end
local x, y, z = gps.locate(3)
if not x then
  -- no fix: diagnose remotely so the -out slot says WHY.
  local modem = peripheral.find("modem", function(_, m) return m.isWireless and m.isWireless() end)
  if not modem then
    print("corner: NO WIRELESS MODEM attached -- that's the problem.")
    return "no-modem"
  end
  local CH = (gps and gps.CHANNEL_GPS) or 65534
  local reply = os.getComputerID()
  modem.open(reply)
  modem.transmit(CH, reply, "PING")
  local heard, timer = 0, os.startTimer(2)
  while true do
    local ev, p1, p2, p3, msg, dist = os.pullEvent()
    if ev == "modem_message" and p2 == reply and type(msg) == "table" and #msg == 3 then
      heard = heard + 1
      print(("corner: heard gps host at %s,%s,%s dist=%s"):format(
        tostring(msg[1]), tostring(msg[2]), tostring(msg[3]), tostring(dist)))
    elseif ev == "timer" and p1 == timer then
      break
    end
  end
  modem.close(reply)
  print(("corner: no fix; modem OK, gps hosts heard: %d (need 4+, non-coplanar)"):format(heard))
  return "no-fix-heard-" .. heard
end
local body = ("%d %d %d"):format(x, y, z)

-- publish to <store>/<slot>  (POST = create-or-overwrite on the paste store)
local url = store .. "/" .. slot
local r, err = http.post(url, body)
if not r then
  print(("corner: POST %s failed: %s"):format(url, tostring(err)))
  return "post-fail"
end
r.readAll(); r.close()

print(("corner %s published %s -> %s"):format(slot, body, url))
return body

-- poll-ccraft-lua : wget a program, run it, post results, loop.
-- Bootstrap:  wget <raw-url>?b startup   then   startup
-- First run prompts for program URL(s) + output store; saved to ".poll".
-- Program source and output both live on a mutable paste store
-- (PUT/POST /<id> = create-or-overwrite, GET /<id> = raw). Editing the
-- program slot hot-reloads it next loop; output overwrites "<label>-out".

local CFG = ".poll"
local LOG = "poll.log"

local function now() return os.epoch("utc") end

local function readCfg()
  if not fs.exists(CFG) then return nil end
  local h = fs.open(CFG, "r"); local t = textutils.unserialize(h.readAll()); h.close()
  return t
end
local function writeCfg(t)
  local h = fs.open(CFG, "w"); h.write(textutils.serialize(t)); h.close()
end

-- GET, cache-busted
local function fetch(url)
  local sep = url:find("?") and "&" or "?"
  local r, err = http.get(url .. sep .. "cb=" .. now())
  if not r then return nil, err end
  local body = r.readAll(); r.close()
  return body
end

-- POST to the store (= create-or-overwrite that slot) -> echoed url
local function putResult(base, id, content)
  local url = base .. "/" .. id
  local r, err = http.post(url, content)
  if not r then return nil, err end
  local resp = r.readAll(); r.close()
  resp = resp:gsub("%s+$", "")
  if resp == "" then resp = url end
  return resp
end

-- run code sandboxed; capture print/write + return value, with timeout.
-- pcall also catches CC's ~7s "too long without yielding" kill.
local function runCaptured(code, src, timeout)
  local buf = {}
  local function cap(...)
    local p = {}
    for i = 1, select("#", ...) do p[i] = tostring((select(i, ...))) end
    buf[#buf + 1] = table.concat(p, "\t")
  end
  local env = setmetatable(
    { print = cap, write = function(s) buf[#buf + 1] = tostring(s) end },
    { __index = _ENV })
  local fn, lerr = load(code, "=" .. src, "t", env)
  if not fn then return false, "load error: " .. tostring(lerr), buf end
  local ok, ret, done = nil, nil, false
  parallel.waitForAny(
    function() ok, ret = pcall(fn); done = true end,
    function() sleep(timeout) end)
  if not done then return false, "TIMEOUT after " .. timeout .. "s", buf end
  return ok, ret, buf
end

-- first-run setup
local cfg = readCfg()
if not cfg then
  term.clear(); term.setCursorPos(1, 1)
  print("poll-ccraft-lua  -  first-run setup")
  print("Program URL(s) to run each loop (comma-separate for several).")
  write("urls> ")
  local raw = read()
  local urls = {}
  for u in raw:gmatch("[^,%s]+") do urls[#urls + 1] = u end
  if #urls == 0 then print("no urls given, aborting"); return end
  write("output store base URL> ")
  local store = read():gsub("/+$", "")
  write("interval seconds [10]> ");    local iv = tonumber(read()) or 10
  write("run timeout seconds [25]> "); local to = tonumber(read()) or 25
  local defLbl = os.getComputerLabel() or ("cc" .. os.getComputerID())
  write("label [" .. defLbl .. "]> ")
  local lbl = read(); if lbl == "" then lbl = defLbl end
  os.setComputerLabel(lbl)
  cfg = { urls = urls, store = store, interval = iv, timeout = to, label = lbl }
  writeCfg(cfg)
  print("saved -> " .. CFG .. "  (delete it to reconfigure)")
end

-- main loop
local outId = cfg.label .. "-out"
print(("poll-ccraft-lua | %s | %d url(s) | every %ds -> %s/%s")
  :format(cfg.label, #cfg.urls, cfg.interval, cfg.store, outId))
while true do
  local out = {}
  out[#out + 1] = ("# %s  id=%d  t=%d"):format(cfg.label, os.getComputerID(), now())
  for i, url in ipairs(cfg.urls) do
    out[#out + 1] = ("--- [%d] %s"):format(i, url)
    local code, ferr = fetch(url)
    if not code then
      out[#out + 1] = "FETCH FAIL: " .. tostring(ferr)
    else
      local ok, ret, buf = runCaptured(code, "url" .. i, cfg.timeout)
      if #buf > 0 then out[#out + 1] = table.concat(buf, "\n") end
      if ok then
        if ret ~= nil then out[#out + 1] = "=> " .. tostring(ret) end
      else
        out[#out + 1] = "ERROR: " .. tostring(ret)
      end
    end
  end
  local text = table.concat(out, "\n")
  local url, err = putResult(cfg.store, outId, text)
  if url then
    print(("[%s] -> %s"):format(os.date("%T"), url))
    local h = fs.open(LOG, "a"); h.writeLine(now() .. " " .. url); h.close()
  else
    print("POST FAIL: " .. tostring(err))
  end
  sleep(cfg.interval)
end

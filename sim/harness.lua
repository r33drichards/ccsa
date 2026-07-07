-- Bootstrap run inside CraftOS-PC via `--script`.
-- Builds the world, installs the turtle+sim globals, runs the program under
-- test, runs the world's post-conditions, and writes a result file to the
-- RW-mounted /out directory (avoids the noisy headless terminal entirely).
--
-- Emulator mounts expected (set up by turtle-test.sh):
--   /sim  -> repo sim/      (ro)   engine.lua lives here
--   /out  -> host temp dir  (rw)   result.txt written here
--   /w    -> dir of world   (ro)
--   /p    -> dir of program (ro)
-- Args (via --args): "<worldPath> <programPath>" (emulator paths)

local function writeResult(linesOrFail)
  local out = fs.open("/out/result.txt", "w")
  for _, l in ipairs(linesOrFail) do out.writeLine(l) end
  out.close()
end

local function fail(msg)
  writeResult({ "SIM_RESULT: FAIL", "harness error: " .. tostring(msg) })
  os.shutdown()
end

-- Collect args whether CraftOS passes them split or as one string.
local raw = table.concat({ ... }, " ")
local parts = {}
for w in raw:gmatch("%S+") do parts[#parts + 1] = w end
local worldPath, progPath = parts[1], parts[2]

if not worldPath then fail("no world path given") end
if not progPath then fail("no program path given") end
if not fs.exists(worldPath) then fail("world not found: " .. worldPath) end
if not fs.exists(progPath) then fail("program not found: " .. progPath) end

local engine = dofile("/sim/engine.lua")

local wf, werr = loadfile(worldPath)
if not wf then fail("world load error: " .. tostring(werr)) end
local wok, world = pcall(wf)
if not wok then fail("world build error: " .. tostring(world)) end

local turtle, sim = engine.install(world)

-- Run the program under test.
local progOk, progErr
local pf, perr = loadfile(progPath)
if not pf then
  progOk, progErr = false, "program load error: " .. tostring(perr)
else
  progOk, progErr = pcall(pf)
end

-- World post-conditions (optional).
if progOk and type(world.test) == "function" then
  local tok, terr = pcall(world.test, sim)
  if not tok then progOk, progErr = false, "world.test error: " .. tostring(terr) end
end

-- Compose the result file.
local L = {}
local function emit(s) L[#L + 1] = s end
emit("== turtle-sim ==")
emit("world:   " .. worldPath)
emit("program: " .. progPath)
emit("")
for _, l in ipairs(sim.log) do emit(l) end
if #sim.log > 0 then emit("") end
local p = sim.pos()
emit(string.format("final pos:  %d,%d,%d  facing %s", p.x, p.y, p.z, sim.facing()))
emit("final fuel: " .. tostring(sim.fuel()))
emit(string.format("asserts:    %d passed, %d failed", sim.passed, sim.failed))
emit("")
if not progOk then emit("program error: " .. tostring(progErr)) end
local pass = progOk and sim.failed == 0
emit("SIM_RESULT: " .. (pass and "PASS" or "FAIL"))

writeResult(L)
os.shutdown()

-- prog.lua — the program pi-autoresearch optimizes. Starts as a naive attempt
-- that scores low; the loop edits it until every sim postcondition passes.
--
-- Naive v0: drain the input chest, but don't yet compress or deposit.
while turtle.suckUp() do end

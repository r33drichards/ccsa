-- Melon slice -> melon block compressor (stationary crafty turtle)
-- Input chest above: melon slices
-- Output chest below: melon blocks

local GRID = {1,2,3,5,6,7,9,10,11}   -- top-left 3x3 crafting grid slots

local function isGrid(slot)
    for _, g in ipairs(GRID) do
        if g == slot then return true end
    end
    return false
end

local function countItem(name)
    local total = 0
    for i = 1, 16 do
        local info = turtle.getItemDetail(i)
        if info and info.name == name then
            total = total + info.count
        end
    end
    return total
end

local function dropAll(name, direction)
    for i = 1, 16 do
        local info = turtle.getItemDetail(i)
        if info and info.name == name then
            turtle.select(i)
            if direction == "down" then
                turtle.dropDown()
            else
                turtle.dropUp()
            end
        end
    end
end

-- Find a non-grid slot that is empty or has the same item with space
local function findNonGridSpace(name)
    for j = 1, 16 do
        if not isGrid(j) then
            local ji = turtle.getItemDetail(j)
            if not ji then return j end
            if ji.name == name and ji.count < 64 then return j end
        end
    end
    return nil
end

-- Find a non-grid slot that has the given item
local function findNonGridWith(name)
    for j = 1, 16 do
        if not isGrid(j) then
            local ji = turtle.getItemDetail(j)
            if ji and ji.name == name and ji.count > 0 then return j end
        end
    end
    return nil
end

local function compress()
    while true do
        -- Step 1: Drain input chest above into turtle inventory
        turtle.select(1)
        while turtle.suckUp() do end

        local total = countItem("minecraft:melon_slice")
        if total == 0 then return end

        -- Step 2: Calculate how many blocks we can craft in one pass
        local k = math.min(math.floor(total / 9), 64)
        if k == 0 then
            -- Not enough for a full craft; drop leftovers back up and exit
            dropAll("minecraft:melon_slice", "up")
            return
        end

        -- Step 3a: Push excess from over-filled grid slots to non-grid slots
        for _, slot in ipairs(GRID) do
            local info = turtle.getItemDetail(slot)
            if info and info.name == "minecraft:melon_slice" and info.count > k then
                local excess = info.count - k
                while excess > 0 do
                    local dest = findNonGridSpace("minecraft:melon_slice")
                    if not dest then break end
                    local di = turtle.getItemDetail(dest)
                    local space = di and (64 - di.count) or 64
                    local move = math.min(excess, space)
                    turtle.select(slot)
                    turtle.transferTo(dest, move)
                    excess = excess - move
                end
            end
        end

        -- Step 3b: Pull from non-grid to fill under-filled grid slots
        for _, slot in ipairs(GRID) do
            local info = turtle.getItemDetail(slot)
            local current = (info and info.name == "minecraft:melon_slice") and info.count or 0
            if current < k then
                local needed = k - current
                while needed > 0 do
                    local src = findNonGridWith("minecraft:melon_slice")
                    if not src then break end
                    local si = turtle.getItemDetail(src)
                    local take = math.min(needed, si.count)
                    turtle.select(src)
                    turtle.transferTo(slot, take)
                    needed = needed - take
                end
            end
        end

        -- Step 4: Drop any remaining non-grid slices back up (craft needs outside empty)
        for i = 1, 16 do
            if not isGrid(i) then
                local info = turtle.getItemDetail(i)
                if info and info.name == "minecraft:melon_slice" then
                    turtle.select(i)
                    turtle.dropUp()
                end
            end
        end

        -- Step 5: Craft (output lands in selected slot 1)
        turtle.select(1)
        turtle.craft()

        -- Step 6: Drop melon blocks below into output chest
        dropAll("minecraft:melon", "down")

        -- Step 7: Drop any leftover slices back up into input chest
        dropAll("minecraft:melon_slice", "up")
    end
end

compress()
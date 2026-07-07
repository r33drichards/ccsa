# CC:Tweaked reference sources

Verbatim copies of the upstream **CC:Tweaked** Java source that defines the real
turtle inventory semantics, vendored so `sim/engine.lua` can be kept faithful to a
real turtle (and so the fidelity decisions are auditable side-by-side).

Source: [cc-tweaked/CC-Tweaked](https://github.com/cc-tweaked/CC-Tweaked) @ `1cf0ff299ec7`

| file | defines |
|------|---------|
| `TurtleSuckCommand.java` | `turtle.suck()` — pulls from the container in front |
| `TurtleDropCommand.java` | `turtle.drop()` — pushes the selected slot into the container |
| `InventoryUtil.java` | `storeItemsImpl` — fills the first compatible-or-empty slot, in slot order |
| `ContainerTransfer.java` | the `moveTo` transfer interface |
| `ForgeContainerTransfer.java` | `moveItem` — source scans slots from 0, moves one item type; dest fills from slot 0 |

## The invariant our engine mirrors

**Chests have fixed indexed slots, with gaps allowed.**

- `suck` (`moveItem`) takes the item type in the **lowest occupied slot**, up to one
  stack, and stores it into the turtle starting at the **selected slot**; the source
  slot it drains becomes an empty hole.
- `drop` (`storeItems`, offset 0) stores the selected item into the **first
  compatible-or-empty slot from index 0**.

So an item dropped right after a suck goes back into the very slot the suck just
emptied. A naive `suck → inspect → drop-back` search loop therefore **never
advances** — it grabs slot 1, returns it to slot 1, forever — exactly like a real
turtle. Our earlier compact-array chest model rotated instead, which let programs
pass the sim but loop on hardware; `sim/engine.lua` now uses the fixed-slot model.

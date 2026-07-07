---
name: turtle-sorter
description: Use when writing or auto-researching a stationary CC:Tweaked (CC:Tweaked) turtle that sorts the items in ADJACENT chests IN PLACE — consolidating same items into minimal stacks and ordering slots by item name — validated against a create_sort_sim arena.
---

# turtle-sorter

You are making a stationary turtle that tidies the items in the chests next to it,
leaving them in the same chests but better organized.

## What "sorted in place" means here

For each chest, the checks want three properties to hold afterwards:

- **conservation** — the same items in the same total amounts (nothing lost, added,
  or moved to a different chest).
- **consolidation** — each item packed into as few stacks as possible.
- **order** — the chest's slots run in a consistent item order.

Think about what invariant each of these is and what would violate it.

## The core constraint to reason about

A turtle cannot reach into a chest and rearrange its slots directly. Its only verbs
are moving items *between its own inventory and one adjacent inventory*. So "sort a
chest in place" has to be expressed in terms of those verbs — figure out what
sequence of them leaves the chest with the three properties above.

Two facts about the environment that are worth using:

- Picking items up tends to **coalesce** identical items for you.
- When you put items into an emptied chest, the **order you put them in** is the
  order they end up in.

## Things that will bite you (gotchas, not solutions)

- Work on **one chest at a time and finish it** before touching the next, or
  contents from different chests get mixed.
- Decide the ordering **before** you start returning items, not after.
- Some adjacent sides may have **no chest, or an empty one** — detect and skip
  gracefully rather than assuming items are there.
- A **double chest** is a single shared inventory spanning two blocks; you interact
  with it from one face, and it can hold more than a single chest.
- Any loop must make progress and terminate (the sim aborts runaway programs).

## How you'll know you're right

Submit a program, read which of conservation / consolidation / order failed for
which chest, and adjust. The failing assertions tell you exactly which property and
position to fix.

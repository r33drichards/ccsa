---
name: poll-ccraft-lua
description: Use when bootstrapping or hot-reloading a ComputerCraft (CC:Tweaked) computer or turtle you can't type into directly — a startup.lua that wgets a program each loop, runs it sandboxed, and posts results to a mutable paste store. Covers the one-time wget bootstrap line, the mutable "paste" store (PUT/GET/DELETE, hot-reload via overwrite) and how to deploy it on Railway, and the sandboxed run-with-timeout pattern.
---

# poll-ccraft-lua — wget a program, run it, post results, loop

## What this is

A `startup.lua` you put on a fresh CC computer/turtle once. Every loop it:
1. `http.get`s your program URL (cache-busted),
2. runs it in a sandbox (captures `print`/`write`, enforces a timeout),
3. POSTs the combined output to a paste store and prints the result URL,
4. sleeps and repeats.

First run prompts for the program URL(s), the output store, interval, and
timeout, and saves them to `.poll`, so reboots are free. This is how you
bootstrap a computer you have no console access to and then never type again.

The full harness is bundled at `assets/startup.lua` — deploy it verbatim (it
is also live on the paste store at `/startup`, so a fresh computer can
`wget https://paste-production.up.railway.app/startup?b startup` directly).
The rest of this doc is when and why; read the asset for the exact code.

## The store: one MUTABLE paste service for both program and output

Everything hinges on the store being **mutable** — you must edit the program
*in place* at a stable URL so the turtle picks up new code next loop. Immutable
pastes (fiche/ghostbin/pastebin, where each edit mints a new id) break
hot-reload. No off-the-shelf self-hosted pastebin does a clean
overwrite-at-a-stable-URL (Opengist=git push, Rustypaste=DELETE+reupload,
microbin=web-form, wastebin/paste.rs=no update), so host the tiny `paste`
service (Go, in `r33drichards/toolbox` under `paste/`):

```sh
curl -T program.lua  $STORE/kelp     # create OR overwrite (201/200), echoes URL
curl                 $STORE/kelp     # raw read, Cache-Control: no-store
curl -X DELETE       $STORE/kelp     # remove
```

`PUT` and `POST` both mean create-or-overwrite (so CC's `http.post(url, body)`
works for writing — CC has no `http.put` helper). `id` must match
`[A-Za-z0-9._-]{1,128}` (no `/`, no `..`). Reads are anonymous so a turtle's
`http.get` just works; writes are unauthenticated by default.

- **Program slot:** a stable name like `/kelp`. Edit it → hot-reload next loop.
- **Output slot:** the runner overwrites `/<label>-out` each loop, so the
  latest result is always at one stable URL you can GET. (GitHub Gist is a fine
  fallback for the *program* slot: `gh gist edit <id> --filename program.lua`,
  raw URL serves latest.) Always cache-bust the GET (`?cb=<epoch>`).

## Bootstrap a fresh computer (the one unavoidable manual step)

There is no way to type into a CC terminal from outside. Accept ONE human
keystroke session at the keyboard:

```
wget <raw-startup-url>?b startup
startup
```

Saving as `startup` survives reboots. After that, edit the program slot in the
store and the running loop hot-reloads it — never again.

## The sandboxed run-with-timeout pattern (what `runCaptured` does)

The heart of `assets/startup.lua`. The fetched program is loaded into a
restricted env so its `print`/`write` are captured instead of hitting the
terminal:

```lua
local env = setmetatable(
  { print = cap, write = function(s) buf[#buf+1] = tostring(s) end },
  { __index = _ENV })
local fn = load(code, "=" .. src, "t", env)
```

It then runs under `parallel.waitForAny(function() pcall(fn) end, function() sleep(timeout) end)`
so a hang — or CC's ~7s "too long without yielding" kill — turns into a clean
`TIMEOUT` line instead of bricking the loop. The captured buffer, the return
value, and any error all get posted to `<label>-out`.

The consequence for the **program you host** is the important part:

- It must be **single-pass**: do its work once and return. It must NOT loop or
  block — the harness is the loop, and anything still running at `timeout` is
  killed. A self-looping program just gets aborted every cycle.
- Use `print(...)` for anything you want to see remotely; that's what lands in
  the output slot and becomes your dashboard for a computer you can't watch.
- Fail soft: a missing peripheral should `print` a status line and `return`,
  not `error`, so a transient hiccup shows up as readable status rather than an
  `ERROR:` stack every loop.

`assets/corner.lua` is a worked example — the box-mine GPS corner reporter
(also live at `/corner` on the store): each run it reads its own gps position
and publishes an `x y z` line to a slot named after the computer's label —
written to this contract (one pass, one status line, soft failure).

## Deploying the `paste` store on Railway

Source: `r33drichards/toolbox` repo, `paste/` (stdlib-only Go, scratch image).

1. New Railway service in the project → deploy from the repo with **root
   directory `paste/`**. (Critical: `railway up` archives the *git repo root*,
   so without a root-directory setting it builds the wrong Dockerfile. Either
   set the service's Root Directory to `paste`, or `railway up` from a copy of
   just the `paste/` files outside the repo.)
2. **Add a Volume mounted at `/data`.** Without it the store is ephemeral and
   slots vanish on redeploy. (Railway volumes mount at runtime; build-time
   writes to `/data` do not persist.)
3. **The container must run as root** — Railway mounts the volume at `/data`
   root-owned, so a non-root user gets `500 write error`. The Dockerfile has no
   `USER` directive for this reason.
4. Generate a domain on port `8080`; optionally set `PUBLIC_URL` so `PUT`
   echoes the right URL. Other env: `PORT`, `DATA_DIR`, `MAX_BYTES`.
5. To require write auth, set `WRITE_TOKEN` and add the Bearer check shown in
   `paste/README.md`; reads stay anonymous so `http.get` keeps working.

## Live instance

The deployed store is **`https://paste-production.up.railway.app`**. Read a
slot with `GET /<id>` (anonymous, `Cache-Control: no-store`); create or
overwrite with `PUT`/`POST /<id>` (echoes the URL, `201`/`200`). Use it as the
store base in both the harness first-run setup and any hosted program.

Hosted program slots currently on it:

- `/boxmine` — the box-mine turtle program (reads corner slots, mines the AABB
  boustrophedon, resumable). Turtle bootstrap: `wget <base>/boxmine bm; bm`.
- `/corner` — the single-pass GPS corner reporter for computers A and B;
  publishes `x y z` to its label-named slot (`/A`, `/B`) each poll loop.

Edit a slot in place (`PUT` the same id) and the running loop hot-reloads it.

## Red flags — stop and re-read

- Hosting the *program* on an immutable paste (fiche/ghostbin/pastebin) → can't
  hot-reload; the turtle re-runs stale code forever.
- Polling without `?cb=<epoch>` → you fetch stale code from a proxy/CDN.
- Writing the hosted program as a `while true` loop → it gets killed at the
  timeout every cycle. Hosted programs are single-pass; the harness loops.
- Deploying `paste` without a Railway Volume at `/data` → slots vanish on deploy.
- Deploying `paste` as a non-root user → `500 write error` on the root-owned
  volume. Run as root.
- `railway up` from inside the toolbox repo without a Root Directory setting →
  it builds the repo-root Dockerfile (mcp-v8), not `paste/`. Deploy from a copy
  of just the `paste/` files, or set the service Root Directory.
- Expecting to type into the CC terminal remotely → impossible; plan the one
  manual `wget … startup` line.

## Bundled files

- `assets/startup.lua` — the harness. Serve it at a raw URL and `wget` it
  once (live copy: `https://paste-production.up.railway.app/startup`).
- `assets/corner.lua` — example single-pass polled program (live copy:
  `https://paste-production.up.railway.app/corner`).

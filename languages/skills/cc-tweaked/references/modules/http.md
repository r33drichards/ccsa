# http

Make HTTP(S) requests and open WebSockets. Must be enabled in the server config; local IPs are blocked by default (see guide: https://tweaked.cc/guide/local_ips.html).

Source: https://tweaked.cc/module/http.html

## Synchronous requests (block until done)

- `get(url [, headers [, binary]])` or `get(request_table)` → `Response` | `nil, string, Response|nil`
- `post(url, body [, headers [, binary]])` or `post(request_table)` → `Response` | `nil, string, Response|nil`

On failure (404, timeout, …) the first return is `nil`, the second is an error message, and the third is the failing `Response` if available.

Request table form (preferred, most flexible):
```
{ url = string, body? = string, headers? = { [string]=string },
  binary? = boolean, method? = string, redirect? = boolean, timeout? = number }
```
- `method`: e.g. `"PATCH"`, `"DELETE"`, `"PUT"` (PATCH/TRACE since 1.86.0).
- `redirect`: follow redirects, default true.
- `timeout`: seconds (since 1.105.0).
- Since 1.109.0 the response body is raw bytes, not UTF-8 decoded.

```lua
local res = http.get("https://example.tweaked.cc")
print(res.readAll())
res.close()

local res = http.post{ url = "https://api.example.com/x", body = body,
  headers = { ["Content-Type"] = "application/json" } }
```

## Asynchronous

- `request(url [, body [, headers [, binary]]])` or `request(request_table)` — returns immediately; queues `http_success` (`event, url, Response`) or `http_failure` (`event, url, errmsg, Response|nil`).
- `checkURL(url)` → `boolean | nil, string` — synchronous "is this URL allowed?".
- `checkURLAsync(url)` — async; queues an `http_check` event.

## WebSockets

- `websocket(url [, headers])` or `websocket(request_table)` → `Websocket` | `false, string` — synchronous open.
- `websocketAsync(...)` — async; queues `websocket_success` (`event, url, Websocket`) or `websocket_failure`.

## Response (a ReadHandle + extras)

A `Response` supports the `fs.ReadHandle` read methods (`read`, `readLine`, `readAll`, `seek`, `close`) plus:
- `getResponseCode()` → `number, string` — status code and message.
- `getResponseHeaders()` → `{ [string]=string }`.

## Websocket type

- `send(message [, binary])` — send a string.
- `receive([timeout])` → `string, boolean(isBinary)` | `nil` on timeout/close.
- `close()` — close the connection.
- Events: `websocket_message` (`event, url, message, isBinary`), `websocket_closed`.

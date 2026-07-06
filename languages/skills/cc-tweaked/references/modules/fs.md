# fs

Interact with the computer's files and filesystem: read/write files, manipulate paths, query and move files.

Source: https://tweaked.cc/module/fs.html

## Important notes

- All `fs` functions use **absolute paths** and ignore the shell's current directory. Use `shell.resolve(path)` to convert a relative path to absolute.
- **Mounts**: other filesystems mount inside the computer. `getDrive` returns `"hdd"` for `/`, `"rom"` for `rom/`, `"disk"`/`"disk1"`/… for disk drives. The rom and treasure disks are read-only.
- Filesystems have limited capacity; writes that exceed it fail. See `getCapacity`/`getFreeSpace`.

## Path manipulation

- `combine(path, ...)` → `string` — join path parts, adding separators. e.g. `fs.combine("/rom/programs", "../apis", "parallel.lua")` → `rom/apis/parallel.lua`. Supports multiple args (1.95.0+).
- `getName(path)` → `string` — final path segment. `fs.getName("rom/startup.lua")` → `startup.lua`.
- `getDir(path)` → `string` — parent directory. `fs.getDir("rom/startup.lua")` → `rom`.

## Querying

- `exists(path)` → `boolean`
- `isDir(path)` → `boolean`
- `isReadOnly(path)` → `boolean`
- `getSize(path)` → `number` (bytes). Throws if path missing.
- `getDrive(path)` → `string|nil` — mount name (`hdd`, `rom`, …).
- `getFreeSpace(path)` → `number | "unlimited"`
- `getCapacity(path)` → `number | nil` (nil for read-only drives).
- `isDriveRoot(path)` → `boolean` — true if path is a mount root (`/`, disk folders, rom).
- `attributes(path)` → `{ size, isDir, isReadOnly, created, modified }`. `created`/`modified` are ms since UNIX epoch (pass to `os.date`).
- `list(path)` → `{ string... }` — files in a directory. Throws if missing.
- `find(path)` → `{ string... }` — wildcard search. `*` matches any chars, `?` (1.106.0+) matches one char; both match within a single path segment only. e.g. `fs.find("rom/help/*.md")`.
- `complete(path, location [, include_files [, include_dirs]])` or `complete(path, location, options)` → `{ string... }` — completion candidates for `read`. Options table: `{ include_files, include_dirs, include_hidden }`. Directory candidates appear twice (with and without trailing slash).

## Directory / file manipulation

- `makeDir(path)` — create directory and any missing parents.
- `move(path, dest)` — move file/dir; creates parent dirs as needed.
- `copy(path, dest)` — copy file/dir; creates parent dirs as needed.
- `delete(path)` — delete file or dir (recursively for dirs).

## Opening files

`open(path, mode)` → `handle` | `nil, string`

Modes: `"r"` read, `"w"` write (erases), `"a"` append, `"r+"` update (read+write, preserves data), `"w+"` update (erases). Append `"b"` for binary mode, which makes `read`/`write` operate on single bytes as numbers.

Example — read all:
```lua
local file = fs.open("/rom/help/intro.txt", "r")
local contents = file.readAll()
file.close()
print(contents)
```

Example — write (always close, or changes may be lost):
```lua
local file = fs.open("out.txt", "w")
file.write("Just testing some code")
file.close()
```

## File handle methods

Handles come in three shapes: `ReadHandle` (`"r"`), `WriteHandle` (`"w"`/`"a"`), `ReadWriteHandle` (`"r+"`/`"w+"`). Methods are accessed as fields, e.g. `file.readLine()`.

Read methods (ReadHandle / ReadWriteHandle):
- `read([count])` — read `count` bytes (string), or one byte. In binary mode with no count, returns a number. `nil`/empty at EOF.
- `readAll()` → `string|nil` — rest of the file.
- `readLine([withTrailing])` → `string|nil` — one line; `\r` stripped; `nil` at EOF.

Write methods (WriteHandle / ReadWriteHandle):
- `write(contents)` — write a string (or a byte number in binary mode).
- `writeLine(text)` — write a line + newline.
- `flush()` — save without closing.

Both:
- `seek([whence [, offset]])` → `number` | `nil, string` — `whence` is `"set"`/`"cur"`(default)/`"end"`. Available on all handles since 1.109.0.
- `close()` — free the handle; no further reads/writes.

## Tips

- For reading lines, `io.lines(path)` is a convenient alternative.
- Non-binary handles use the raw bytes of the file (since 1.109.0), not UTF-8 re-encoding.

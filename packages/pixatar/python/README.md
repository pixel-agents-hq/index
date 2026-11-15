# pixatar for Python

Deterministic [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) avatars as PNG files, for Python projects. A seed (any text, or a `px.` seed code) always makes the same character, drawn as a 20×20 avatar on a background colour derived from the seed (or on a transparent background), or as its 128×96 sprite sheet.

```python
import pixatar

png = pixatar.avatar_png("octocat", scale=8)  # bytes: a 160x160 PNG
open("octocat.png", "wb").write(png)
```

The Python package doesn't draw anything itself. It runs the [avatar npm package](..)'s own `pixatar` command in a Node process, and talks to it over stdin and stdout. Each PNG is the exact file the JavaScript package makes for the same seed, byte for byte. The tests check this against the JavaScript package's pinned values. The Python side has no dependencies.

## Requirements

- **Python 3.10+**
- **Node.js 22+** on the machine that makes the avatars (`node --version`)
- **The `pixatar` command**, from the avatar npm package `@pixel-index/pixatar` (see [Installing](#installing))

The client is pure Python, and the CLI is plain JavaScript with no native code, so they should work on Linux, macOS and Windows. CI tests them on Linux.

## Installing

### 1. The pixatar command

The npm package isn't published yet (see [PUBLISHING.md](../PUBLISHING.md)). Until it is, build it from this repository:

```sh
git clone --recurse-submodules https://github.com/pixel-agents-hq/index
cd index
npm ci
npm pack --workspace @pixel-index/pixatar          # builds it, writes pixel-index-pixatar-<version>.tgz
npm install --global ./pixel-index-pixatar-*.tgz   # puts `pixatar` on the PATH
pixatar --version
```

To keep the CLI's version pinned with your project instead of installed globally, install the tarball locally and point the client at it:

```sh
npm install ./pixel-index-pixatar-0.0.0.tgz
export PIXATAR_CLI="node $PWD/node_modules/@pixel-index/pixatar/dist/cli.js"
```

### 2. The Python client

```sh
pip install "pixatar @ git+https://github.com/pixel-agents-hq/index#subdirectory=packages/pixatar/python"
```

In a `requirements.txt`, use the same `pixatar @ git+…` line, pinned to a commit with `@<ref>` after the repository URL (the same commit you built the CLI from). Without git, use an archive URL instead: `pixatar @ https://github.com/pixel-agents-hq/index/archive/<ref>.zip#subdirectory=packages/pixatar/python`.

### Where the client finds the command

In order:

1. the `command` you pass: `Pixatar("node /opt/pixatar/dist/cli.js")` or `Pixatar(["node", "/opt/pixatar/dist/cli.js"])`
2. the `PIXATAR_CLI` environment variable, split like a shell command
3. `pixatar` on the `PATH`

If none of these is there, the first call raises `PixatarError` with code `cli-not-found`.

## Usage

### Module functions

These share one client, started on first use and closed when Python exits:

```python
import pixatar

pixatar.avatar_png("octocat")                           # 20x20, on its background colour
pixatar.avatar_png("octocat", scale=8)                  # 160x160 (scale 1 to 64)
pixatar.avatar_png("octocat", background="transparent") # transparent around the head
pixatar.sheet_png("octocat", scale=2)                   # the 256x192 sprite sheet, always transparent

character = pixatar.info("octocat")
character.seed               # 'px.ASMByrHtCcOa…': this exact character, forever
character.background         # '#a896e8'
character.avatar_background  # 'color' or 'transparent', as the seed code says
character.profile            # the Pixel Agents character profile (a dict)
```

### A client of your own

Use a client of your own to choose the command, or to control when the Node process starts and stops:

```python
from pixatar import Pixatar

with Pixatar("node /opt/pixatar/dist/cli.js") as px:
    for user in users:
        path = f"avatars/{user.id}.png"
        with open(path, "wb") as f:
            f.write(px.avatar_png(user.email, scale=4))
```

A client starts one Node process on its first call and reuses it for every call after. Calls are thread-safe: threads share the process and take turns. If the process dies, that call raises `PixatarError('cli-exited')` and the next call starts a new process. `close()` stops it.

### Seeds

- **Free text** is any string, of any length. `"octocat"`, an email address, a user id. The same text always makes the same character.
- **A seed code** (`px.` followed by base64url) *is* the character, written down. `info(text).seed` gives a text's code.
- A string starting with `px.` is read as a seed code. To use text that happens to start with `px.`, pass `text=True`.

The two kinds behave differently across versions:

- **A seed code keeps its character across pixatar versions**, for as long as Pixel Agents keeps the parts it names.
- **Free text can deal a different character after a vendor bump** that adds parts (a new theme, say). The release notes say so when that happens.

So to keep a user's avatar stable for good, store `info(text).seed` once and draw from that code from then on.

A seed code also records whether its avatar is transparent. `background=` overrides that for one call.

### In a web app

Avatars are deterministic, so cache them freely. For example, with Flask:

```python
from flask import Flask, Response
import pixatar

app = Flask(__name__)

@app.get("/avatars/<path:seed>.png")
def avatar(seed):
    png = pixatar.avatar_png(seed, scale=8)
    return Response(png, mimetype="image/png", headers={"Cache-Control": "public, max-age=31536000, immutable"})
```

### Errors

Everything raises `pixatar.PixatarError`, with a `code` and a `message`:

| `code` | when |
| --- | --- |
| `invalid-seed` | a `px.` seed that isn't a valid seed code |
| `unknown-part` | a seed code naming a part this wardrobe doesn't have (made by a newer version) |
| `invalid-request` | a bad argument: `scale` outside 1 to 64, `background` not `'color'` / `'transparent'` |
| `cli-not-found` | no pixatar command to run (see [Where the client finds the command](#where-the-client-finds-the-command)) |
| `cli-exited` | the command stopped; `message` includes what it printed (an old Node, say) |
| `internal-error` | a bug in pixatar: please report it |

The client keeps working after any of them.

### Versions

```python
pixatar.default_client().version()
# {'version': '0.0.0', 'vendor': {'version': '1.5.0', 'commit': '226a5c9…'}}
```

`vendor` is the Pixel Agents build the CLI draws with. Pin the npm package's version (as in the local install above) so text seeds keep dealing the characters you've seen.

## Performance

The first call starts Node and loads the wardrobe, about 0.2 s. After that, each avatar takes a few milliseconds (about 7 ms for a 160×160 PNG on a small Intel NUC). Reuse one client: the module functions already do. Don't start a `pixatar` process per avatar.

## Deploying

The machine needs Node 22+ and the CLI next to Python. For example, in Docker:

```dockerfile
# install the CLI with npm, then take only Node and the CLI into the Python image
# (both images are Debian bookworm, so the node binary runs as it is)
FROM node:22-bookworm-slim AS pixatar
COPY pixel-index-pixatar-0.0.0.tgz /tmp/
RUN npm install --prefix /opt/pixatar /tmp/pixel-index-pixatar-0.0.0.tgz

FROM python:3.13-slim-bookworm
COPY --from=pixatar /usr/local/bin/node /usr/local/bin/node
COPY --from=pixatar /opt/pixatar /opt/pixatar
ENV PIXATAR_CLI="node /opt/pixatar/node_modules/@pixel-index/pixatar/dist/cli.js"
# an archive URL, as the slim image has no git; pin <ref> to the commit the tarball came from
RUN pip install "pixatar @ https://github.com/pixel-agents-hq/index/archive/<ref>.zip#subdirectory=packages/pixatar/python"
```

The npm package holds everything it draws with, wardrobe art included. It needs no network access and writes no files.

## The protocol

`pixatar serve` reads one JSON request per line on stdin, and writes one JSON response per line on stdout, in order, until stdin closes. Any language can use it the same way:

```json
{"id": 1, "op": "avatar", "seed": "octocat", "scale": 8, "background": "transparent", "text": false}
{"id": 1, "ok": true, "seed": "px.…", "background": "#a896e8", "avatarBackground": "transparent", "png": "<base64>"}
{"id": 2, "ok": false, "error": {"code": "invalid-seed", "message": "…"}}
```

`op` is `avatar`, `sheet` (`png`, and no `background` field), `info` (`profile` instead of `png`) or `version`. Every field but `op` and `seed` is optional. `id` is echoed back on the response.

The command also works one-shot, from a shell:

```sh
pixatar avatar octocat --scale 8 --out octocat.png
pixatar sheet octocat > sheet.png
pixatar info octocat
```

## Testing

The tests run the client against a real CLI, and check that it gets the JavaScript package's pinned codes, colours and PNG hashes:

```sh
npm run build --workspace @pixel-index/pixatar
pip install './packages/pixatar/python[test]'
cd packages/pixatar/python && PIXATAR_CLI="node $PWD/../dist/cli.js" pytest
```

CI's **Python avatar client** job runs them on the oldest and newest supported Python, with the CLI installed from the npm tarball onto the PATH, the way a Python project would install it.

## Licence

MIT. The characters, wardrobe and renderer are [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents)' (MIT), and the npm package ships its licence. Its character art is based on [JIK-A-4's Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack) pack.

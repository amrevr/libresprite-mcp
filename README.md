# libresprite-mcp

A Claude Code plugin that lets Claude draw, animate and export pixel art with
[LibreSprite](https://github.com/LibreSprite/LibreSprite), the GPL-2.0 fork of Aseprite,
through LibreSprite's own built-in MCP server.

LibreSprite runs headless in a Docker container. A small Bun bridge (`bridge.js`, no
dependencies) inside the same container starts it, then relays MCP JSON-RPC between the
container's stdin/stdout and the server's Streamable HTTP endpoint on the container's
loopback. No port is published and the container runs with `--network none`.

```
Claude Code ──stdio──> docker run -i libresprite-mcp
                         bun bridge.js ──HTTP 127.0.0.1:9000/mcp──> libresprite --batch seed.png --script mcp-server.js
                         /work = your project directory
```

## Tools

The 11 tools of LibreSprite's server, passed through unchanged: `sprite_info`,
`sprite_image`, `pixel_get`, `pixel_set`, `palette_get`, `palette_set`, `layers_list`,
`sprite_save`, `sprite_save_as`, `command_info`, `run_command`.

Two tools added by the bridge:

- `sprite_new {w, h, colorMode?}`: a blank transparent sprite (rgb, grayscale or indexed,
  1-4096 px a side). Headless LibreSprite can't run `NewFile` (it needs a dialog), so the
  bridge writes a seed PNG and restarts LibreSprite on it. The previous document is closed
  without saving.
- `export_sheet {path?, inline?}`: saves the sprite as `.ase` (default `/work/sprite.ase`),
  then runs `libresprite --batch <ase> --sheet <name>.png --data <name>.json` and returns the
  three paths, plus the sheet as image content when `inline` is true. (`ExportSpriteSheet`
  over MCP writes nothing, because it takes the output path from prefs.)

The skill `skills/libresprite-pixel-art` teaches Claude the workflow: palette discipline,
silhouette then shading, frame conventions, critique passes with `sprite_image`, and export.

## Build

```sh
docker build -t libresprite-mcp .
# another LibreSprite commit (full SHA):
docker build --build-arg LIBRESPRITE_COMMIT=<sha> -t libresprite-mcp .
```

The build stage compiles LibreSprite (pinned to `2be695f986ee210cb6bd0c210093b6f08686717f`)
on Debian trixie with CMake 4.4.3 from Kitware's release tarball (trixie's apt CMake is 3.31,
LibreSprite needs 4.1 or newer); `ninja libresprite` takes about 2 minutes on aarch64. The
runtime stage is `debian:trixie-slim` with the binary, its `data/` directory, the shared
libraries it links and Bun 1.4.3. The CMake download picks the host architecture, so amd64
should work too (only aarch64 has been built).

**Status:** `docker build` has not completed end to end yet: the first attempt ran out of
disk in the build host's Docker data store. The build steps match a recipe that did build
LibreSprite (in a chroot), and the tests pass against that build with the same bridge, but
the runtime stage's library list and `test/run.sh` are unverified until the image builds.

## Test

```sh
./test/run.sh            # runs bun test inside the image
```

`test/bridge.test.js` drives the bridge over stdio: initialize, `tools/list` (13 tools),
`sprite_new` 16x16, `pixel_set`/`pixel_get`, `run_command NewFrame` twice, `export_sheet`,
then decodes the sheet and checks it is 48x16 with each pixel in the right frame. Other tests
check that the bridge exits with code 0 and stops LibreSprite on stdin EOF, and that a
command stuck in a dialog times out instead of hanging the bridge.

## Run by hand

```sh
cd my-game
docker run --rm -i --network none -v "$PWD":/work libresprite-mcp
```

Then type JSON-RPC lines, for example
`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sprite_info","arguments":{}}}`.
Close stdin (Ctrl-D) to stop.

## Install in Claude Code (not done for you)

Clone the repo (`git clone https://github.com/amrevr/libresprite-mcp`) and build the image first.
Then, from the directory that contains the clone, either load the plugin for one session:

```sh
claude --plugin-dir ./libresprite-mcp
```

or install it from this directory, which is also a one-plugin marketplace:

```sh
claude plugin marketplace add ./libresprite-mcp
claude plugin install libresprite-mcp@libresprite-mcp
```

The plugin's `.mcp.json` starts a server called `libresprite` with
`docker run --rm -i --network none -v ${CLAUDE_PROJECT_DIR}:/work libresprite-mcp`, so
`/work` is the project you run Claude Code in.

## Security

- LibreSprite's MCP server has no authentication. It listens on `127.0.0.1` inside the
  container only; nothing is published to the host, and `--network none` leaves the
  container with loopback only, so nothing outside the container can reach it.
- The container can read and write the whole mounted project directory (`/work`): any path
  Claude passes to `sprite_save_as` or `export_sheet` is written there. It sees no other
  host files.
- On Linux hosts the container runs as root, so files it writes are owned by root. Add
  `--user <uid>:<gid>` to the `docker run` args in `.mcp.json` if that matters (the image
  may then need a writable `HOME`, e.g. `-e HOME=/tmp`; untested).

## Limits

- One document at a time. `sprite_new` replaces it; open an existing file with
  `run_command OpenFile {"filename": "/work/x.ase"}` (not covered by the tests).
- Headless LibreSprite cannot show dialogs. A command that opens one (`NewFile`,
  `NewFrameTag`, most `*Properties`) blocks it; after 30 s
  (`LIBRESPRITE_TIMEOUT_MS`) the bridge stops LibreSprite and unsaved changes are lost.
- `NewLayer` makes a layer with no cels, so `pixel_set` on it fails; frame tags can't be made.
- Drawing is one pixel per call; large sprites are slow to draw.
- Sheets are one row, with the CLI's default options.
- Requests are handled one at a time.

## Licence

This repository's own code (the bridge, tests, Dockerfile, plugin files and skill) is under
the MIT licence; see `LICENSE`. MIT was chosen as the suggested default and can be changed
before publishing.

LibreSprite is GPL-2.0. This repo contains none of its code: the Dockerfile downloads and
builds it, and the bridge runs it as a separate process and talks to it over HTTP and the
command line, without linking it. A built image does contain the LibreSprite binary, so if
you distribute the image, the GPL-2.0 terms apply to that binary: ship or offer its source
(the pinned commit above).

## Credits

- [LibreSprite](https://github.com/LibreSprite/LibreSprite) (GPL-2.0) and its built-in MCP
  server, `data/scripts/mcp-server.js`.
- The skill's pixel-art concepts (palette discipline, frame and tag conventions, small-sprite
  workflow, critique passes, export steps) come from
  [willibrandon/pixel-plugin](https://github.com/willibrandon/pixel-plugin) (MIT). No code is
  copied; the skill is rewritten for this tool set.

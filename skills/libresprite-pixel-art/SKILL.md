---
name: libresprite-pixel-art
description: Make, animate and export small pixel-art sprites with the LibreSprite MCP tools (sprite_new, pixel_set, pixels_set, run_command, export_sheet and friends). Use when the user asks for a sprite, icon, tile, mascot, pixel art, a walk/idle cycle, frames, a palette, or a sprite sheet, or mentions LibreSprite or Aseprite files (.ase).
---

# Pixel art with LibreSprite

The `libresprite` MCP server drives a headless LibreSprite in Docker. Tools act on one
active document. Paths are container paths: `/work` is the user's project directory, so
`/work/art/hero.ase` is `art/hero.ase` in the project. Save everything you want to keep
under `/work`; the scratch sprite from `sprite_new` lives in `/tmp` and is lost.

## Tools at a glance

| Need | Tool |
|---|---|
| Blank canvas | `sprite_new {w, h, colorMode?}` (rgb, grayscale, indexed). Closes the current doc without saving |
| What is open | `sprite_info`, `layers_list` |
| Look at it | `sprite_image {frame?}` returns a PNG; use it after every pass |
| Draw | `pixel_set {x, y, color, frame?, layer?}`, read back with `pixel_get` |
| Draw many | `pixels_set {pixels: [{x, y, color}]}` or `{rows: ["..ab"], palette: {a: "#.."}, x?, y?}`, up to 10000 per call, all-or-nothing bounds check |
| Palette | `palette_get`, `palette_set {index, color}` (cannot grow the palette) |
| Frame timing | `frame_duration {ms, frame?}` (all frames by default); reloads the sprite, so the active frame is 0 afterwards |
| Frames, layers, flips, resize... | `command_info {name}` first, then `run_command {name, params}` |
| Save | `sprite_save_as {path}` (.ase keeps frames and layers, .png flattens one frame) |
| Sprite sheet | `export_sheet {path?, inline?}` writes `<name>.ase`, `<name>.png` (one row) and `<name>.json` |

Colors are `#RRGGBB` or `#RRGGBBAA`. Coordinates, frames and layers are 0-based.
Edits are not undoable: `sprite_save_as` a backup before a big change.

Commands checked headless: `NewFrame` (`content`: current duplicates the active frame,
empty adds a blank one), `RemoveFrame` and `Flip` (`orientation`: horizontal or vertical).
`NewLayer` runs, but the new layer has no cels, so `pixel_set` on it fails: draw on layer 0.
`ExportSpriteSheet` writes nothing headless: use `export_sheet`.
Anything that opens a dialog (`NewFile`, `NewFrameTag`, most `*Properties`) blocks headless LibreSprite: after 30s the bridge stops it and every unsaved
change is lost. Use only the commands above unless the user accepts that risk, and
`sprite_save_as` before trying anything else.

## Workflow

1. **Plan before pixels.** Agree the size (16x16 icon, 32x32 character, 16x16 tile), the
   palette and, for animation, the frame list. Write the plan in one or two lines.
2. **Pick a small palette and keep to it.** 4-8 colors for a 16x16 sprite, up to ~16 for 32x32.
   Build ramps (dark, mid, light per material) and shift hue along the ramp (shadows cooler,
   highlights warmer) instead of only changing brightness. For indexed sprites, set the
   palette with `palette_set` first; `pixel_set` only accepts palette colors there.
3. **Silhouette first.** Block the shape in one flat color, check `sprite_image`, and fix the
   outline before adding detail. A readable silhouette matters more than detail at this size.
4. **Then shading.** One light direction (usually top-left). Add shadow, then highlight, then a
   few accent pixels. Avoid pillow shading (darkening every edge evenly) and lone noisy pixels.
5. **Outline choice.** A dark outline (not pure black: the darkest ramp color) reads well on any
   background; selective outlines (lighter on the lit side) look softer.
6. **Animate from a finished frame.** `run_command NewFrame` duplicates the active frame, so
   finish frame 0, duplicate, then change only what moves. Keep counts small: idle 2-4 frames,
   walk 4-8, attack 3-6. Keep the feet line and the sprite's center steady across frames.
7. **Critique pass.** After each stage, look at `sprite_image` for every frame and check:
   stray pixels, jaggies on curves (keep line steps even: 1-1-2-2, not 1-3-1),
   too many colors (`palette_get`), banding, and whether the sprite still reads at 1x.
   Fix, then look again. Tell the user what you changed.
8. **Export.** `export_sheet {path: "/work/<name>.ase"}` gives the .ase source, a one-row
   PNG sheet (frame width = sprite width) and JSON frame data with durations. Pass
   `inline: true` to see the sheet. Report the three project-relative paths.

## Conventions

- Name files after the subject and action: `hero-walk.ase`, `coin-spin.ase`.
- Frame tags cannot be created headless (`NewFrameTag` needs a dialog); when a sprite holds several animations,
  put each one in its own .ase/sheet instead.
- Keep the background transparent unless the user asks for one.

Concepts here (palette discipline, frame counts, critique passes, export steps) are adapted
from willibrandon/pixel-plugin (MIT), rewritten for this tool set.

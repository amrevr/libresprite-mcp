// Draws docs/architecture.{ase,gif,png} and docs/architecture-sheet.png through this
// plugin's own MCP tools: it speaks stdio JSON-RPC to the server, exactly as Claude Code
// does, and every pixel goes through pixels_set. Run from the repo root:
//   bun docs/diagram/draw.js                    # the published image, via docker
//   bun docs/diagram/draw.js bun bridge.js      # any other server command
// The layout is computed here; LibreSprite does the drawing, timing, resize and export.
import { renameSync, rmSync, readdirSync } from "node:fs";

const W = 320, H = 160;
const argv = process.argv.slice(2);
const server = argv.length ? argv
  : ["docker", "run", "--rm", "-i", "--network", "none", "-v", process.cwd() + ":/work", "ghcr.io/amrevr/libresprite-plugin:0.1.0"];

// ---------- palette (index 0 stays transparent; 1 is the background) ----------

const PAL = [
  "#000000", "#1a1c2c", "#262b44", "#0f101a", "#566c86", "#f4f4f4", "#94b0c2", "#da7756",
  "#41a6f6", "#f2d7a6", "#d95b9a", "#ffcd75", "#ff9b3d", "#38b764", "#73eff7", "#333c57",
];
const [, BG, PANEL, SHADOW, LINE, TEXT, DIM, CLAUDE, DOCKER, BUN, LS, WORK, REQ, RES, HELPER, RULE] = PAL.keys();

// ---------- a hand-drawn font: 3 px wide (1-2 for punctuation, 5 for m and w), 5 px caps, 1 px descenders ----------

const G = {
  A: ".#.|#.#|###|#.#|#.#", B: "##.|#.#|##.|#.#|##.", C: ".##|#..|#..|#..|.##", D: "##.|#.#|#.#|#.#|##.",
  E: "###|#..|##.|#..|###", F: "###|#..|##.|#..|#..", G: ".##|#..|#.#|#.#|.##", H: "#.#|#.#|###|#.#|#.#",
  I: "###|.#.|.#.|.#.|###", J: "..#|..#|..#|#.#|.#.", K: "#.#|#.#|##.|#.#|#.#", L: "#..|#..|#..|#..|###",
  M: "#.#|###|###|#.#|#.#", N: "##.|#.#|#.#|#.#|#.#", O: ".#.|#.#|#.#|#.#|.#.", P: "##.|#.#|##.|#..|#..",
  Q: ".#.|#.#|#.#|##.|.##", R: "##.|#.#|##.|#.#|#.#", S: ".##|#..|.#.|..#|##.", T: "###|.#.|.#.|.#.|.#.",
  U: "#.#|#.#|#.#|#.#|###", V: "#.#|#.#|#.#|.#.|.#.", W: "#.#|#.#|###|###|#.#", X: "#.#|#.#|.#.|#.#|#.#",
  Y: "#.#|#.#|.#.|.#.|.#.", Z: "###|..#|.#.|#..|###",
  a: "...|.##|#.#|#.#|.##", b: "#..|##.|#.#|#.#|##.", c: "...|.##|#..|#..|.##", d: "..#|.##|#.#|#.#|.##",
  e: "...|.#.|###|#..|.##", f: ".##|.#.|###|.#.|.#.", g: "...|.##|#.#|.##|..#|##.", h: "#..|##.|#.#|#.#|#.#",
  i: ".#.|...|##.|.#.|###", j: "..#|...|..#|..#|..#|##.", k: "#..|#.#|##.|##.|#.#", l: "##.|.#.|.#.|.#.|###",
  m: ".....|####.|#.#.#|#.#.#|#.#.#", n: "...|##.|#.#|#.#|#.#", o: "...|.#.|#.#|#.#|.#.", p: "...|##.|#.#|#.#|##.|#..",
  q: "...|.##|#.#|#.#|.##|..#", r: "...|#.#|##.|#..|#..", s: "...|.##|##.|..#|##.", t: ".#.|###|.#.|.#.|.##",
  u: "...|#.#|#.#|#.#|.##", v: "...|#.#|#.#|#.#|.#.", w: ".....|#...#|#...#|#.#.#|.#.#.", x: "...|#.#|.#.|.#.|#.#",
  y: "...|#.#|#.#|.##|..#|##.", z: "...|###|.##|#..|###",
  0: "###|#.#|#.#|#.#|###", 1: ".#.|##.|.#.|.#.|###", 2: "##.|..#|.#.|#..|###", 3: "##.|..#|.#.|..#|##.",
  4: "#.#|#.#|###|..#|..#", 5: "###|#..|##.|..#|##.", 6: "###|#..|###|#.#|###", 7: "###|..#|.#.|.#.|.#.",
  8: "###|#.#|###|#.#|###", 9: "###|#.#|###|..#|##.",
  ".": ".|.|.|.|#", ":": ".|#|.|#|.", ",": ".|.|.|.|#|#", "-": "...|...|###|...|...", "_": "...|...|...|...|...|###",
  "/": "..#|..#|.#.|#..|#..", "(": ".#|#.|#.|#.|.#", ")": "#.|.#|.#|.#|#.", "+": "...|.#.|###|.#.|...",
  "=": "...|###|...|###|...", ">": "#..|.#.|..#|.#.|#..", "<": "..#|.#.|#..|.#.|..#", " ": "..|..|..|..|..",
};
const glyph = (ch) => {
  if (!G[ch]) throw new Error("no glyph for " + JSON.stringify(ch));
  return G[ch].split("|");
};
const textWidth = (s) => [...s].reduce((w, ch) => w + glyph(ch)[0].length + 1, -1);

// ---------- a tiny canvas of palette indices ----------

const canvas = () => new Uint8Array(W * H).fill(BG);
const put = (c, x, y, i) => { if (x >= 0 && y >= 0 && x < W && y < H) c[y * W + x] = i; };
const fill = (c, x, y, w, h, i) => { for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) put(c, x + dx, y + dy, i); };
const hline = (c, x0, x1, y, i, dash = 0) => { for (let x = x0; x <= x1; x++) if (!dash || (x - x0) % dash < dash - 2) put(c, x, y, i); };
const vline = (c, x, y0, y1, i, dash = 0) => { for (let y = y0; y <= y1; y++) if (!dash || (y - y0) % dash < dash - 2) put(c, x, y, i); };
function text(c, x, y, s, i) {
  for (const ch of s) {
    const g = glyph(ch);
    g.forEach((row, dy) => [...row].forEach((p, dx) => p === "#" && put(c, x + dx, y + dy, i)));
    x += g[0].length + 1;
  }
  return x;
}
const center = (c, x, w, y, s, i) => text(c, x + Math.floor((w - textWidth(s)) / 2), y, s, i);
// A panel with clipped corners and a 1 px drop shadow.
function box(c, x, y, w, h, outline, bg = PANEL) {
  fill(c, x + 1, y + h, w, 1, SHADOW); fill(c, x + w, y + 1, 1, h, SHADOW);
  fill(c, x + 1, y + 1, w - 2, h - 2, bg);
  hline(c, x + 1, x + w - 2, y, outline); hline(c, x + 1, x + w - 2, y + h - 1, outline);
  vline(c, x, y + 1, y + h - 2, outline); vline(c, x + w - 1, y + 1, y + h - 2, outline);
}
function head(c, x, y, dir, i) { // a 5 px arrowhead with its tip at (x, y); dir 1 right, -1 left, 2 down
  for (let k = 0; k < 3; k++)
    for (let d = -k; d <= k; d++) dir === 2 ? put(c, x + d, y - k, i) : put(c, x - dir * k, y + d, i);
}
const PACKET = ["#######", "##...##", "#.#.#.#", "#..#..#", "#######"];
function packet(c, x, y, i) { PACKET.forEach((row, dy) => [...row].forEach((p, dx) => put(c, x + dx, y + dy, p === "#" ? i : SHADOW))); }

// ---------- the scene ----------

const LANE_REQ = 68, LANE_RES = 76; // request lane (rightwards) and result lane (leftwards)
const CL = { x: 4, y: 50, w: 50, h: 44 }, BR = { x: 102, y: 40, w: 64, h: 60 }, LSB = { x: 206, y: 40, w: 104, h: 60 };
const WK = { x: 150, y: 114, w: 160, h: 40 };

function scene() {
  const c = canvas();
  text(c, text(c, 4, 3, "libresprite-plugin", LS) + 4, 3, "one tool call, end to end", DIM);

  // Claude Code, with a little terminal
  box(c, CL.x, CL.y, CL.w, CL.h, CLAUDE);
  box(c, CL.x + 18, CL.y + 6, 20, 12, DIM, SHADOW);
  text(c, CL.x + 21, CL.y + 9, ">", CLAUDE); hline(c, CL.x + 25, CL.x + 27, CL.y + 13, TEXT);
  center(c, CL.x, CL.w, CL.y + 23, "Claude", TEXT);
  center(c, CL.x, CL.w, CL.y + 31, "Code", TEXT);

  // the container
  hline(c, 97, 315, 14, DOCKER, 5); hline(c, 97, 315, 131, DOCKER, 5);
  vline(c, 97, 14, 131, DOCKER, 5); vline(c, 315, 14, 131, DOCKER, 5);
  text(c, text(c, 102, 19, "docker run", DOCKER) + 4, 19, "--network none", TEXT);
  text(c, 102, 27, "no ports, loopback only", DIM);

  // bridge.js (Bun) and its helper tools
  box(c, BR.x, BR.y, BR.w, BR.h, BUN);
  center(c, BR.x, BR.w, BR.y + 4, "bridge.js", TEXT);
  center(c, BR.x, BR.w, BR.y + 11, "(Bun)", BUN);
  hline(c, BR.x + 3, BR.x + BR.w - 4, BR.y + 19, RULE);
  text(c, BR.x + 4, BR.y + 22, "helpers", DIM);
  ["sprite_new", "pixels_set", "export_sheet"].forEach((s, k) => {
    fill(c, BR.x + 4, BR.y + 31 + k * 8, 2, 2, HELPER);
    text(c, BR.x + 8, BR.y + 29 + k * 8, s, HELPER);
  });

  // LibreSprite and its built-in server
  box(c, LSB.x, LSB.y, LSB.w, LSB.h, LS);
  center(c, LSB.x, LSB.w, LSB.y + 4, "LibreSprite", TEXT);
  center(c, LSB.x, LSB.w, LSB.y + 11, "--batch", LS);
  center(c, LSB.x, LSB.w, LSB.y + 19, "+ mcp-server.js", DIM);
  hline(c, LSB.x + 3, LSB.x + LSB.w - 4, LSB.y + 27, RULE);
  ["pixel_set  palette_set", "run_command NewFrame", "sprite_save_as  ..."].forEach((s, k) =>
    text(c, LSB.x + 6, LSB.y + 31 + k * 8, s, k === 2 ? DIM : TEXT));

  // /work: the project, mounted across the container wall
  box(c, WK.x, WK.y, WK.w, WK.h, WORK);
  fill(c, WK.x + 6, WK.y + 5, 4, 1, WORK); fill(c, WK.x + 6, WK.y + 6, 9, 6, WORK); // folder
  text(c, text(c, WK.x + 19, WK.y + 6, "/work", WORK) + 4, WK.y + 6, "= your project", TEXT);
  text(c, WK.x + 6, WK.y + 19, ".ase  sheet.png  sheet.json", TEXT);
  text(c, WK.x + 6, WK.y + 29, "files owned by you", DIM);

  // stdio: Claude Code <-> bridge
  arrows(c, CL.x + CL.w + 1, BR.x - 2);
  center(c, CL.x + CL.w, BR.x - CL.x - CL.w, LANE_REQ - 10, "stdio", TEXT);
  center(c, CL.x + CL.w, BR.x - CL.x - CL.w, LANE_RES + 5, "JSON-RPC", DIM);
  // HTTP: bridge <-> LibreSprite, on the container's loopback
  arrows(c, BR.x + BR.w + 1, LSB.x - 2);
  center(c, BR.x + BR.w, LSB.x - BR.x - BR.w, LANE_REQ - 10, "HTTP", TEXT);
  center(c, BR.x + BR.w, LSB.x - BR.x - BR.w, LANE_RES + 5, "127.0.0.1", DIM);
  center(c, BR.x + BR.w, LSB.x - BR.x - BR.w, LANE_RES + 12, ":9000/mcp", DIM);

  // export_sheet: the bridge runs the LibreSprite CLI, which writes the sheet into /work
  vline(c, BR.x + 8, BR.y + BR.h + 1, WK.y + 8, LINE); hline(c, BR.x + 8, WK.x - 2, WK.y + 8, LINE);
  head(c, WK.x - 2, WK.y + 8, 1, LINE);
  text(c, BR.x + 12, BR.y + BR.h + 4, "libresprite --sheet", BUN);
  // sprite_save_as: LibreSprite writes .ase / .png / .gif into /work
  vline(c, LSB.x + 84, LSB.y + LSB.h + 1, WK.y - 2, LINE); head(c, LSB.x + 84, WK.y - 2, 2, LINE);
  text(c, LSB.x + 80 - textWidth("sprite_save_as"), LSB.y + LSB.h + 4, "sprite_save_as", DIM);

  // legend
  packet(c, 6, 101, REQ); text(c, 16, 101, "request", DIM);
  packet(c, 6, 110, RES); text(c, 16, 110, "result", DIM);
  fill(c, 8, 121, 2, 2, HELPER); text(c, 16, 119, "bridge-side tool", DIM);
  return c;
}

function arrows(c, x0, x1) {
  hline(c, x0, x1, LANE_REQ, LINE); head(c, x1, LANE_REQ, 1, LINE);
  hline(c, x0, x1, LANE_RES, LINE); head(c, x0, LANE_RES, -1, LINE);
}

// One request out and its result back.
const STEPS = [
  { caption: "Claude calls pixels_set", draw: (c) => { packet(c, 59, LANE_REQ - 2, REQ); glow(c, CL, CLAUDE); } },
  { caption: "one JSON-RPC line on stdin", draw: (c) => packet(c, 78, LANE_REQ - 2, REQ) },
  { caption: "bridge POSTs to /mcp", draw: (c) => packet(c, 182, LANE_REQ - 2, REQ) },
  { caption: "LibreSprite sets the pixels", draw: (c) => { glow(c, LSB, LS); sparkle(c); } },
  { caption: "JSON result over HTTP", draw: (c) => packet(c, 180, LANE_RES - 2, RES) },
  { caption: "result line on stdout", draw: (c) => { packet(c, 66, LANE_RES - 2, RES); glow(c, CL, RES); } },
];
const glow = (c, b, i) => { hline(c, b.x, b.x + b.w - 1, b.y - 2, i, 4); hline(c, b.x, b.x + b.w - 1, b.y + b.h + 1, i, 4); };
function sparkle(c) { // a few freshly set pixels next to the tool list
  for (const [dx, dy, i] of [[0, 0, REQ], [3, 0, WORK], [0, 3, RES], [3, 3, HELPER], [6, 3, LS]]) fill(c, LSB.x + 88 + dx, LSB.y + 6 + dy, 2, 2, i);
}

function frames() {
  return STEPS.map((s, i) => {
    const c = scene();
    s.draw(c);
    text(c, text(c, 4, 138, `step ${i + 1}:`, LS) + 4, 138, s.caption, TEXT);
    text(c, 4, 147, "drawn by Claude through this plugin", DIM);
    return c;
  });
}

// ---------- MCP over stdio ----------

const proc = Bun.spawn(server, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
const reader = proc.stdout.getReader();
let buf = "", nextId = 0;
async function rpc(method, params) {
  const id = ++nextId;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  proc.stdin.flush();
  for (;;) {
    const nl = buf.indexOf("\n");
    if (nl >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (msg.id === id) return msg;
      continue;
    }
    const { value, done } = await reader.read();
    if (done) throw new Error("server closed stdout");
    buf += new TextDecoder().decode(value);
  }
}
async function call(name, args = {}) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error || r.result.isError) throw new Error(name + ": " + JSON.stringify(r.error || r.result.content));
  console.error(`  ${name} ${JSON.stringify(args).slice(0, 70)} -> ${r.result.content[0].text.split("\n")[0].slice(0, 70)}`);
  return r.result.content;
}
// Sends the pixels that differ between two frames, in pixels_set batches.
async function paint(from, to, frame) {
  const px = [];
  for (let i = 0; i < W * H; i++) if (from[i] !== to[i]) px.push({ x: i % W, y: (i / W) | 0, color: PAL[to[i]] });
  for (let k = 0; k < px.length; k += 10000) await call("pixels_set", { pixels: px.slice(k, k + 10000), frame });
}

const t0 = performance.now();
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "draw.js", version: "1" } });
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

await call("sprite_new", { w: W, h: H, colorMode: "indexed" });
for (let i = 1; i < PAL.length; i++) await call("palette_set", { index: i, color: PAL[i] });
await call("run_command", { name: "BackgroundFromLayer" }); // opaque layer filled with entry 1
const fs = frames();
await paint(canvas(), fs[0], 0);
for (let f = 1; f < fs.length; f++) {
  await call("run_command", { name: "NewFrame" }); // duplicates the previous frame
  await paint(fs[f - 1], fs[f], f);
}
await call("frame_duration", { ms: 600 });
await call("frame_duration", { ms: 900, frame: 3 });

await call("sprite_save_as", { path: "docs/architecture.ase" });
await call("export_sheet", { path: "docs/diagram/out/architecture-sheet.ase" });
// 2x nearest neighbour for the README, by LibreSprite itself
await call("run_command", { name: "SpriteSize", params: { "use-ui": "false", width: String(W * 2), height: String(H * 2), "resize-method": "nearest-neighbor" } });
await call("sprite_save_as", { path: "docs/architecture.gif" });
await call("sprite_save_as", { path: "docs/diagram/out/frame.png" }); // one PNG per frame: frame1.png ...
proc.stdin.end();
await proc.exited;

renameSync("docs/diagram/out/architecture-sheet.png", "docs/architecture-sheet.png");
renameSync(`docs/diagram/out/frame${fs.length}.png`, "docs/architecture.png");
rmSync("docs/diagram/out", { recursive: true });
console.error(`done in ${((performance.now() - t0) / 1000).toFixed(0)} s:`, readdirSync("docs").filter((f) => f.startsWith("architecture")).join(", "));

// stdio <-> Streamable HTTP bridge for LibreSprite's built-in MCP server.
// Runs inside the container: starts LibreSprite headless on loopback, relays
// newline-delimited JSON-RPC from stdin to http://127.0.0.1:<port>/mcp and the
// replies back to stdout, and adds helper tools (sprite_new, pixels_set, frame_duration, export_sheet).
// Bun only, no dependencies. Everything not JSON-RPC goes to stderr.
import { deflateSync } from "node:zlib";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const BIN = process.env.LIBRESPRITE_BIN || "/opt/libresprite/libresprite";
const SCRIPT = join(dirname(BIN), "data/scripts/mcp-server.js");
const WORK = process.env.WORK_DIR || "/work";
const SEED_DIR = "/tmp/libresprite-mcp";
const TIMEOUT_MS = Number(process.env.LIBRESPRITE_TIMEOUT_MS) || 30000;
const MAX_BATCH = 10000; // pixels per pixels_set call
const CONCURRENCY = 8; // pixel_set requests in flight: httplib serves with >= 8 threads; more queue up and stall
const log = (...a) => console.error("[bridge]", ...a);

let child = null;
let url = null;
let session = null; // Mcp-Session-Id, if the server ever hands one out
let protocol = null; // negotiated MCP-Protocol-Version
let internalId = 0;

// ---------- LibreSprite process ----------

async function start(seed) {
  await stop();
  child = Bun.spawn([BIN, "--batch", seed, "--script", SCRIPT], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  session = null;
  const proc = child;
  url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("LibreSprite did not print 'Listening' within 30s")), 30000);
    const pump = async (stream) => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of stream) {
        const text = dec.decode(chunk, { stream: true });
        process.stderr.write(text); // app output never reaches stdout (the JSON-RPC channel)
        buf += text;
        const m = /Listening on (http:\/\/\S+\/mcp)/.exec(buf);
        if (m) { clearTimeout(timer); resolve(m[1]); buf = ""; }
        else if (buf.length > 65536) buf = buf.slice(-4096);
      }
    };
    pump(proc.stdout);
    pump(proc.stderr);
    proc.exited.then((code) => { clearTimeout(timer); reject(new Error("LibreSprite exited with code " + code + " before listening")); });
  });
  log("LibreSprite listening on", url, "with", seed);
}

async function stop() {
  if (!child) return;
  const proc = child;
  child = null;
  url = null;
  proc.kill("SIGKILL"); // headless LibreSprite ignores SIGTERM; it holds nothing worth flushing
  await proc.exited;
}

// ---------- HTTP relay ----------

// POSTs one JSON-RPC message and returns the JSON-RPC messages it produced
// (none for a 202, one for a JSON body, any number for an SSE body).
async function post(msg) {
  if (!url) throw new Error("LibreSprite is not running; call sprite_new to start a sprite");
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (protocol) headers["MCP-Protocol-Version"] = protocol;
  if (session) headers["Mcp-Session-Id"] = session;
  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(msg), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    if (e.name !== "TimeoutError") throw e;
    // A command that opens a dialog blocks LibreSprite's only thread forever headless.
    await stop();
    throw new Error(`LibreSprite stopped responding for ${TIMEOUT_MS / 1000}s (a command probably opened a dialog) and was stopped. Unsaved changes are lost; call sprite_new to start again.`);
  }
  const sid = res.headers.get("mcp-session-id");
  if (sid) session = sid;
  if (res.status === 202) return [];
  const body = await res.text();
  if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
    return body.split(/\r?\n\r?\n/).map((ev) =>
      ev.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n")
    ).filter(Boolean).map((d) => JSON.parse(d));
  }
  try {
    return [JSON.parse(body)];
  } catch {
    throw new Error("HTTP " + res.status + ": " + body.slice(0, 500));
  }
}

// Calls one of the server's tools from inside the bridge.
async function callTool(name, args) {
  const id = "bridge-" + ++internalId;
  const replies = await post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const r = replies.find((m) => m.id === id);
  if (!r) throw new Error(name + ": no reply");
  if (r.error) throw new Error(name + ": " + r.error.message);
  if (r.result.isError) throw new Error(r.result.content.map((c) => c.text).join("\n"));
  return r.result;
}

// ---------- helper tools ----------

const crc32 = (bytes) => Bun.hash.crc32(bytes) >>> 0;

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// A fully transparent PNG (index 0 / alpha 0) in the requested color mode.
export function blankPng(w, h, mode) {
  const [colorType, bpp] = { rgb: [6, 4], grayscale: [4, 2], indexed: [3, 1] }[mode];
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr.set([8, colorType, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr)];
  if (mode === "indexed") {
    // 16 entries: 0 is transparent, 1-15 a gray ramp to replace with palette_set
    const plte = new Uint8Array(16 * 3);
    for (let i = 1; i < 16; i++) plte.fill(Math.round(((i - 1) * 255) / 14), i * 3, i * 3 + 3);
    parts.push(chunk("PLTE", plte), chunk("tRNS", new Uint8Array([0])));
  }
  parts.push(chunk("IDAT", deflateSync(new Uint8Array((w * bpp + 1) * h))), chunk("IEND", new Uint8Array(0)));
  return Buffer.concat(parts);
}

const resolve = (p) => (isAbsolute(p) ? p : join(WORK, p));
const text = (t) => ({ content: [{ type: "text", text: t }] });

const HELPERS = {
  sprite_new: {
    description: "Creates a blank, fully transparent sprite and makes it the active document (LibreSprite's NewFile needs a dialog, so this replaces it). The previous document is closed WITHOUT saving: sprite_save_as it first if you need it. The new sprite lives in /tmp; save your work with sprite_save_as to a path under /work (the user's project directory). Indexed sprites get a 16-entry palette (0 transparent, 1-15 a gray ramp) to overwrite with palette_set.",
    inputSchema: {
      type: "object",
      properties: {
        w: { type: "integer", description: "width in pixels (1-4096)" },
        h: { type: "integer", description: "height in pixels (1-4096)" },
        colorMode: { type: "string", enum: ["rgb", "grayscale", "indexed"], description: "default rgb" },
      },
      required: ["w", "h"],
    },
    async run({ w, h, colorMode = "rgb" }) {
      for (const [k, v] of [["w", w], ["h", h]])
        if (!Number.isInteger(v) || v < 1 || v > 4096) throw new Error(k + " must be an integer from 1 to 4096");
      if (!["rgb", "grayscale", "indexed"].includes(colorMode)) throw new Error("colorMode must be rgb, grayscale or indexed");
      mkdirSync(SEED_DIR, { recursive: true });
      const seed = join(SEED_DIR, `untitled-${w}x${h}-${colorMode}.png`);
      await Bun.write(seed, blankPng(w, h, colorMode));
      await start(seed);
      return text(`opened a blank ${w}x${h} ${colorMode} sprite (1 layer, 1 frame). Save it with sprite_save_as under /work.`);
    },
  },
  pixels_set: {
    description: `Sets many pixels in one call (each one is a pixel_set). Give either pixels, a list of {x, y, color}, or rows plus palette: rows is a list of strings drawn from (x, y) down, one character per pixel, palette maps each character to a color, and characters missing from palette (e.g. "." or " ") are left untouched. All coordinates are checked against the sprite before anything is drawn. At most ${MAX_BATCH} pixels per call. Colors are #RRGGBB or #RRGGBBAA; on indexed sprites they must be palette colors.`,
    inputSchema: {
      type: "object",
      properties: {
        pixels: { type: "array", items: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" }, color: { type: "string" } }, required: ["x", "y", "color"] } },
        rows: { type: "array", items: { type: "string" }, description: "one string per row, one character per pixel" },
        palette: { type: "object", additionalProperties: { type: "string" }, description: 'character -> color, e.g. {"#": "#000000", "o": "#ff8800"}' },
        x: { type: "integer", description: "left column of rows (default 0)" },
        y: { type: "integer", description: "top row of rows (default 0)" },
        frame: { type: "integer", description: "0-based frame (default: the active frame)" },
        layer: { type: "integer", description: "0-based layer (default: the active layer)" },
      },
    },
    async run({ pixels, rows, palette = {}, x = 0, y = 0, frame, layer }) {
      if (!pixels === !rows) throw new Error("give either pixels or rows (with palette)");
      if (rows) {
        if (!Array.isArray(rows) || !rows.every((r) => typeof r === "string")) throw new Error("rows must be a list of strings");
        if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error("x and y must be integers");
        pixels = [];
        rows.forEach((row, dy) => [...row].forEach((ch, dx) => {
          if (Object.hasOwn(palette, ch)) pixels.push({ x: x + dx, y: y + dy, color: palette[ch] });
        }));
      }
      if (!Array.isArray(pixels)) throw new Error("pixels must be a list of {x, y, color}");
      if (pixels.length > MAX_BATCH) throw new Error(`${pixels.length} pixels is more than the ${MAX_BATCH} allowed per call; split the batch`);
      const { width, height } = JSON.parse((await callTool("sprite_info", {})).content[0].text);
      for (const p of pixels) {
        if (!Number.isInteger(p?.x) || !Number.isInteger(p?.y) || p.x < 0 || p.y < 0 || p.x >= width || p.y >= height)
          throw new Error(`pixel ${JSON.stringify(p)} is out of bounds (sprite is ${width}x${height}); nothing was drawn`);
        if (typeof p.color !== "string" || !/^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(p.color))
          throw new Error(`pixel ${JSON.stringify(p)} needs a #RRGGBB or #RRGGBBAA color; nothing was drawn`);
      }
      const where = {};
      if (frame !== undefined) where.frame = frame;
      if (layer !== undefined) where.layer = layer;
      // LibreSprite answers about one request per 10 ms pump tick, but handles every request queued
      // by then in the same tick, so keep several in flight. Last write per pixel wins, as in order.
      const last = [...new Map(pixels.map((p) => [p.x + "," + p.y, p])).values()];
      let next = 0;
      const worker = async () => {
        while (next < last.length) {
          const p = last[next++];
          await callTool("pixel_set", { x: p.x, y: p.y, color: p.color, ...where });
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      return text(`set ${pixels.length} pixels`);
    },
  },
  frame_duration: {
    description: "Sets how long frames are shown, in milliseconds (LibreSprite's FrameProperties needs a dialog). The bridge saves the sprite to /tmp, rewrites the durations in that .ase and reopens it, so, as after sprite_new, the document lives in /tmp (sprite_save_as it under /work) and the active frame is 0 again. GIF saves and export_sheet's JSON use these durations.",
    inputSchema: {
      type: "object",
      properties: {
        ms: { type: "integer", description: "duration in milliseconds (1-65535)" },
        frame: { type: "integer", description: "0-based frame (default: every frame)" },
      },
      required: ["ms"],
    },
    async run({ ms, frame }) {
      if (!Number.isInteger(ms) || ms < 1 || ms > 65535) throw new Error("ms must be an integer from 1 to 65535");
      const tmp = join(SEED_DIR, `durations-${++internalId}.ase`);
      await callTool("sprite_save_as", { path: tmp });
      // .ase: frame count is a WORD at 6, frames start at 128, each frame header is
      // DWORD size, WORD magic, WORD chunks, WORD duration (little-endian).
      const b = readFileSync(tmp), dv = new DataView(b.buffer, b.byteOffset, b.length);
      const n = dv.getUint16(6, true);
      if (frame !== undefined && (!Number.isInteger(frame) || frame < 0 || frame >= n))
        throw new Error(`frame must be an integer from 0 to ${n - 1}`);
      for (let i = 0, off = 128; i < n; off += dv.getUint32(off, true), i++) {
        if (dv.getUint16(off + 4, true) !== 0xf1fa) throw new Error("unexpected .ase layout; durations unchanged");
        if (frame === undefined || frame === i) dv.setUint16(off + 8, ms, true);
      }
      await Bun.write(tmp, b);
      await start(tmp);
      return text(`set ${frame === undefined ? "every frame" : "frame " + frame} to ${ms} ms`);
    },
  },
  export_sheet: {
    description: "Saves the active sprite as .ase, then renders all frames into a one-row sprite sheet PNG plus JSON frame data next to it (<name>.png, <name>.json). Relative paths are under /work, the user's project directory. Returns the three paths, and the sheet image itself when inline is true.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: ".ase path to write (default /work/sprite.ase)" },
        inline: { type: "boolean", description: "also return the sheet PNG as image content (default false)" },
      },
    },
    async run({ path = "sprite.ase", inline = false }) {
      const ase = resolve(path);
      if (!/\.(ase|aseprite)$/i.test(ase)) throw new Error("path must end in .ase or .aseprite");
      mkdirSync(dirname(ase), { recursive: true });
      await callTool("sprite_save_as", { path: ase });
      const base = ase.replace(/\.[^./]+$/, "");
      const png = base + ".png", json = base + ".json";
      // ExportSpriteSheet over MCP takes its output path from prefs, so use the CLI instead.
      const r = Bun.spawnSync([BIN, "--batch", ase, "--sheet", png, "--data", json], { stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0 || !existsSync(png) || !existsSync(json))
        throw new Error(`sheet export failed (exit ${r.exitCode}): ${r.stdout}${r.stderr}`.trim());
      const out = text(JSON.stringify({ ase, png, json }, null, 2));
      if (inline) out.content.push({ type: "image", mimeType: "image/png", data: readFileSync(png).toString("base64") });
      return out;
    },
  },
};

const helperList = Object.entries(HELPERS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema }));

// ---------- stdin loop ----------

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");

async function handle(msg) {
  const isRequest = msg.id !== undefined && typeof msg.method === "string";
  try {
    const helper = msg.method === "tools/call" && HELPERS[msg.params?.name];
    if (helper) {
      try {
        send({ jsonrpc: "2.0", id: msg.id, result: await helper.run(msg.params.arguments || {}) });
      } catch (e) {
        send({ jsonrpc: "2.0", id: msg.id, result: { ...text(String(e.message || e)), isError: true } });
      }
      return;
    }
    for (const reply of await post(msg)) {
      if (reply.id === msg.id && reply.result) {
        if (msg.method === "initialize") protocol = reply.result.protocolVersion;
        if (msg.method === "tools/list") reply.result.tools = [...reply.result.tools, ...helperList];
      }
      send(reply);
    }
  } catch (e) {
    log(e.message);
    if (isRequest) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e.message || e) } });
  }
}

if (import.meta.main) {
  mkdirSync(SEED_DIR, { recursive: true });
  const seed = join(SEED_DIR, "untitled-32x32-rgb.png");
  await Bun.write(seed, blankPng(32, 32, "rgb"));
  await start(seed);
  // As PID 1 in a container, SIGTERM has no default handler: stop the app ourselves.
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => stop().then(() => process.exit(0)));

  // Requests run one at a time: there is one document and sprite_new restarts the app.
  let queue = Promise.resolve();
  for await (const line of console) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    queue = queue.then(() => handle(msg));
  }
  // stdin closed: finish what is queued, stop LibreSprite, exit cleanly.
  await queue;
  await stop();
  process.exit(0);
}

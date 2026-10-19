// Runs inside the image: bun test test/  (see test/run.sh)
import { test, expect, afterAll } from "bun:test";
import { inflateSync } from "node:zlib";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

const BRIDGE = join(import.meta.dir, "..", "bridge.js");
const WORK = mkdtempSync("/tmp/lsmcp-work-");
const spawned = [];
afterAll(() => spawned.forEach((p) => p.kill()));

function startBridge(env = {}) {
  const proc = Bun.spawn(["bun", BRIDGE], {
    stdin: "pipe", stdout: "pipe", stderr: "inherit",
    env: { ...process.env, WORK_DIR: WORK, ...env },
  });
  spawned.push(proc);
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "", n = 0;
  async function rpc(method, params = {}) {
    const id = ++n;
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
      if (done) throw new Error("bridge closed stdout");
      buf += dec.decode(value, { stream: true });
    }
  }
  const call = async (name, args = {}) => {
    const r = await rpc("tools/call", { name, arguments: args });
    if (r.error || r.result.isError) throw new Error(name + ": " + JSON.stringify(r));
    return r.result.content;
  };
  return { proc, rpc, call };
}

// Minimal PNG decoder: 8-bit RGBA or RGB, non-interlaced. Returns {w, h, px(x,y) -> "#rrggbbaa"}.
function decodePng(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  let off = 8, w, h, ct, idat = [];
  while (off < bytes.length) {
    const len = dv.getUint32(off), type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = dv.getUint32(off + 8); h = dv.getUint32(off + 12); ct = data[9];
      expect(data[8]).toBe(8); expect(data[12]).toBe(0);
    }
    if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  const bpp = { 6: 4, 2: 3 }[ct];
  if (!bpp) throw new Error("unsupported PNG color type " + ct);
  const raw = inflateSync(Buffer.concat(idat)), stride = w * bpp;
  const out = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= bpp ? out[y * stride + i - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y > 0 ? out[(y - 1) * stride + i - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      out[y * stride + i] = (x + pred) & 255;
    }
  }
  const hex = (v) => v.toString(16).padStart(2, "0");
  return {
    w, h,
    px(x, y) {
      const i = y * stride + x * bpp;
      return "#" + hex(out[i]) + hex(out[i + 1]) + hex(out[i + 2]) + (bpp === 4 ? hex(out[i + 3]) : "ff");
    },
  };
}

test("round trip: new sprite, pixels, frames, sprite sheet", async () => {
  const { proc, rpc, call } = startBridge();
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  expect(init.result.serverInfo.name).toBe("libresprite-mcp");

  const names = (await rpc("tools/list")).result.tools.map((t) => t.name);
  expect(names.length).toBe(15);
  expect(names).toContain("sprite_new");
  expect(names).toContain("pixels_set");
  expect(names).toContain("frame_duration");
  expect(names).toContain("export_sheet");

  await call("sprite_new", { w: 16, h: 16 });
  const info = JSON.parse((await call("sprite_info"))[0].text);
  expect([info.width, info.height, info.colorMode, info.frameCount]).toEqual([16, 16, "rgb", 1]);

  await call("pixel_set", { x: 1, y: 1, color: "#ff0000" });
  expect((await call("pixel_get", { x: 1, y: 1 }))[0].text).toBe("#ff0000ff");
  await call("run_command", { name: "NewFrame" }); // duplicates the frame, red pixel included
  await call("run_command", { name: "NewFrame" });
  await call("pixel_set", { x: 5, y: 5, color: "#00ff00", frame: 1 });
  await call("pixel_set", { x: 9, y: 9, color: "#0000ff", frame: 2 });
  expect((await call("pixel_get", { x: 5, y: 5, frame: 1 }))[0].text).toBe("#00ff00ff");

  // batch: rows + palette (". " untouched), then a pixel list
  await call("pixels_set", { rows: ["ab", ".a"], palette: { a: "#112233", b: "#445566" }, x: 12, y: 12, frame: 2 });
  await call("pixels_set", { pixels: [{ x: 15, y: 0, color: "#000000" }, { x: 15, y: 0, color: "#778899" }], frame: 2 }); // last wins
  const px = async (x, y) => (await call("pixel_get", { x, y, frame: 2 }))[0].text;
  expect([await px(12, 12), await px(13, 12), await px(12, 13), await px(13, 13), await px(15, 0)])
    .toEqual(["#112233ff", "#445566ff", "#00000000", "#112233ff", "#778899ff"]);
  // out of bounds, bad colors and oversized batches are rejected before anything is drawn
  for (const args of [
    { pixels: [{ x: 0, y: 0, color: "#ffffff" }, { x: 16, y: 0, color: "#ffffff" }], frame: 2 },
    { pixels: [{ x: 0, y: 0, color: "red" }], frame: 2 },
    { pixels: Array.from({ length: 10001 }, () => ({ x: 0, y: 0, color: "#ffffff" })) },
    { rows: ["a"], pixels: [] },
  ]) expect((await rpc("tools/call", { name: "pixels_set", arguments: args })).result.isError).toBe(true);
  expect(await px(0, 0)).toBe("#00000000");

  await call("frame_duration", { ms: 250 });
  await call("frame_duration", { ms: 40, frame: 1 });
  expect((await rpc("tools/call", { name: "frame_duration", arguments: { ms: 40, frame: 3 } })).result.isError).toBe(true);
  expect((await call("pixel_get", { x: 5, y: 5, frame: 1 }))[0].text).toBe("#00ff00ff"); // pixels survive the reload

  const content = await call("export_sheet", { path: "anim/hero.ase", inline: true });
  const paths = JSON.parse(content[0].text);
  expect(paths).toEqual({ ase: WORK + "/anim/hero.ase", png: WORK + "/anim/hero.png", json: WORK + "/anim/hero.json" });
  expect(content[1].type).toBe("image");

  const sheet = decodePng(readFileSync(paths.png));
  expect([sheet.w, sheet.h]).toEqual([48, 16]);
  const T = "#00000000";
  expect([sheet.px(1, 1), sheet.px(17, 1), sheet.px(33, 1)]).toEqual(["#ff0000ff", "#ff0000ff", "#ff0000ff"]);
  expect([sheet.px(5, 5), sheet.px(21, 5), sheet.px(37, 5)]).toEqual([T, "#00ff00ff", T]);
  expect([sheet.px(9, 9), sheet.px(25, 9), sheet.px(41, 9)]).toEqual([T, T, "#0000ffff"]);
  expect(Buffer.from(content[1].data, "base64").equals(readFileSync(paths.png))).toBe(true);
  expect(Object.values(JSON.parse(readFileSync(paths.json, "utf8")).frames).map((f) => f.duration)).toEqual([250, 40, 250]);

  // the other color modes open too
  for (const mode of ["grayscale", "indexed"]) {
    await call("sprite_new", { w: 8, h: 4, colorMode: mode });
    expect(JSON.parse((await call("sprite_info"))[0].text).colorMode).toBe(mode);
  }
  expect((await call("palette_get"))[0].text).toStartWith('["#00000000","#000000ff"');

  // bad input is a tool error, not a crash
  const bad = await rpc("tools/call", { name: "sprite_new", arguments: { w: 0, h: 4 } });
  expect(bad.result.isError).toBe(true);

  proc.stdin.end();
  expect(await proc.exited).toBe(0);
}, 120000);

const libresprites = () =>
  readdirSync("/proc").filter((p) => /^\d+$/.test(p)).filter((p) => {
    try { return readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0")[0].endsWith("/libresprite"); } catch { return false; }
  });

test("exits cleanly on stdin EOF and stops LibreSprite", async () => {
  const { proc, rpc } = startBridge();
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  expect(libresprites().length).toBeGreaterThan(0);
  proc.stdin.end();
  const code = await Promise.race([proc.exited, Bun.sleep(10000).then(() => "timeout")]);
  expect(code).toBe(0);
  expect(libresprites()).toEqual([]);
}, 60000);

test("a command that opens a dialog times out instead of hanging the bridge", async () => {
  const { proc, rpc, call } = startBridge({ LIBRESPRITE_TIMEOUT_MS: "3000" });
  const r = await rpc("tools/call", { name: "run_command", arguments: { name: "NewFrameTag" } });
  expect(r.error.message).toContain("stopped responding");
  expect(libresprites()).toEqual([]);
  await call("sprite_new", { w: 4, h: 4 }); // recovers
  expect(JSON.parse((await call("sprite_info"))[0].text).width).toBe(4);
  proc.stdin.end();
  expect(await proc.exited).toBe(0);
}, 60000);

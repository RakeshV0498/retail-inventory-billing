// Generates simple solid PNG icons with no dependencies (zlib only).
import zlib from "node:zlib";
import fs from "node:fs";

function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, { maskable }) {
  const bg = [4, 120, 87], fg = [255, 255, 255];
  const raw = Buffer.alloc((size * 3 + 1) * size);
  const pad = maskable ? size * 0.28 : size * 0.2;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      // white "receipt" block with a green stripe
      const inBox = x > pad && x < size - pad && y > pad && y < size - pad;
      const stripe = inBox && y > size * 0.42 && y < size * 0.5;
      const c = inBox && !stripe ? fg : bg;
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
fs.mkdirSync("public/icons", { recursive: true });
fs.writeFileSync("public/icons/icon-192.png", png(192, {}));
fs.writeFileSync("public/icons/icon-512.png", png(512, {}));
fs.writeFileSync("public/icons/icon-maskable-512.png", png(512, { maskable: true }));
console.log("icons written");

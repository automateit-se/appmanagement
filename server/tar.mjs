// Writes a minimal POSIX tar archive in memory - Docker's "put archive" endpoint takes files only as tar.

function header(name, size, mode) {
  const h = Buffer.alloc(512, 0);
  const put = (str, off, len) => h.write(str, off, len, 'utf8');
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  if (Buffer.byteLength(name) > 100) throw new Error('tar: file name too long');
  put(name, 0, 100);
  put(oct(mode, 8), 100, 8);
  put(oct(0, 8), 108, 8); // uid root
  put(oct(0, 8), 116, 8); // gid root
  put(oct(size, 12), 124, 12);
  put(oct(Math.floor(Date.now() / 1000), 12), 136, 12);
  put('        ', 148, 8); // checksum placeholder (spaces while summing)
  put('0', 156, 1); // regular file
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

/** files: [{ name, content: string|Buffer, mode = 0o600 }] -> Buffer */
export function makeTar(files) {
  const blocks = [];
  for (const f of files) {
    const data = Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content), 'utf8');
    blocks.push(header(f.name, data.length, f.mode ?? 0o600), data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

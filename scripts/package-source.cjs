// Produce a source-only ZIP from an explicit allowlist; never package runtime data.
const fs = require('node:fs');
const path = require('node:path');
const { deflateRawSync } = require('node:zlib');
const root = path.resolve(__dirname, '..');
const files = [];
function collect(relative) {
  const full = path.join(root, relative);
  const stat = fs.lstatSync(full);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(full).sort()) {
      if (name.startsWith('.') || ['exports', 'node_modules'].includes(name)) continue;
      collect(`${relative}/${name}`);
    }
  } else if (/\.(?:html|css|js|cjs|mjs|sql|png|jpg|jpeg|svg|webp|ico|md)$/.test(relative)) {
    files.push(relative);
  }
}
for (const directory of ['public', 'server', 'netlify/functions', 'netlify/database/migrations', 'scripts']) collect(directory);
for (const name of ['package.json', 'package-lock.json', 'netlify.toml', '.gitignore', 'README.md', 'scripts-check.cjs']) files.push(name);
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const locals = [], central = [];
let offset = 0;
for (const name of [...new Set(files)].sort()) {
  const filename = Buffer.from(name);
  const data = fs.readFileSync(path.join(root, name));
  if (!/\.(?:png|jpg|jpeg|webp|ico)$/.test(name) && /(?:github_pat_[a-zA-Z0-9_]+|ghp_[a-zA-Z0-9]+|sk-proj-[a-zA-Z0-9_-]+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(data.toString('utf8'))) {
    throw new Error('Source archive stopped: potential credential detected.');
  }
  const compressed = deflateRawSync(data);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(33, 12); // ZIP epoch: 1980-01-01.
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  locals.push(local, filename, compressed);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  local.copy(entry, 6, 4, 30);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, filename);
  offset += local.length + filename.length + compressed.length;
}
const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(central.length / 2, 8);
end.writeUInt16LE(central.length / 2, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
const destination = path.join(root, 'server/exports/nancy-profit-health-source.zip');
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, Buffer.concat([...locals, directory, end]));
console.log(`Packaged ${central.length / 2} source files.`);

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/data';
const MAGIC = Buffer.from('ACHADINHOS-DATA-BACKUP-v1\n');
const [action, archive, confirmation] = process.argv.slice(2);

function keyFromEnvironment() {
  const value = process.env.DATA_BACKUP_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error('Defina DATA_BACKUP_KEY com 64 caracteres hexadecimais (32 bytes).');
  }
  return Buffer.from(value, 'hex');
}

function scan(directory, relative = '') {
  const entries = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const full = path.join(directory, name);
    const rel = relative ? `${relative}/${name}` : name;
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`Link simbólico recusado: ${rel}`);
    if (stat.isDirectory()) entries.push({ path: rel, directory: true }, ...scan(full, rel));
    else if (stat.isFile()) entries.push({ path: rel, data: fs.readFileSync(full).toString('base64') });
    else throw new Error(`Tipo de arquivo não suportado: ${rel}`);
  }
  return entries;
}

function exportData() {
  if (!archive) throw new Error('Uso: node scripts/data-volume.mjs export <arquivo criptografado>');
  const key = keyFromEnvironment();
  const payload = Buffer.from(JSON.stringify({ format: 1, createdAt: new Date().toISOString(), entries: scan(ROOT) }));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const output = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
  fs.writeFileSync(archive, output, { mode: 0o600, flag: 'wx' });
  console.log(`Backup criptografado criado: ${archive} (${JSON.parse(payload).entries.length} itens).`);
}

function restoreData() {
  if (!archive || confirmation !== '--confirm-volume-replacement') {
    throw new Error('Uso: node scripts/data-volume.mjs restore <arquivo> --confirm-volume-replacement');
  }
  const key = keyFromEnvironment();
  const buffer = fs.readFileSync(archive);
  if (buffer.length < MAGIC.length + 28 || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Formato de backup inválido.');
  }
  const iv = buffer.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = buffer.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(buffer.subarray(MAGIC.length + 28)), decipher.final()]);
  const snapshot = JSON.parse(plain.toString('utf8'));
  if (snapshot.format !== 1 || !Array.isArray(snapshot.entries)) throw new Error('Conteúdo de backup inválido.');

  const seen = new Set();
  const entries = snapshot.entries.map(item => {
    if (!item || typeof item.path !== 'string' || item.path.startsWith('/') || item.path.includes('\\') ||
        item.path.split('/').some(part => !part || part === '.' || part === '..') || seen.has(item.path)) {
      throw new Error('Caminho inválido ou duplicado no backup.');
    }
    seen.add(item.path);
    if (item.directory === true) return { path: item.path, directory: true };
    if (typeof item.data !== 'string') throw new Error(`Arquivo inválido no backup: ${item.path}`);
    return { path: item.path, data: Buffer.from(item.data, 'base64') };
  });

  const resolvedRoot = path.resolve(ROOT);
  for (const item of entries) {
    const destination = path.resolve(resolvedRoot, item.path);
    if (!destination.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('Caminho fora do volume recusado.');
  }

  const stage = path.join(resolvedRoot, `.restore-stage-${crypto.randomUUID()}`);
  const rollback = path.join(resolvedRoot, `.before-restore-${crypto.randomUUID()}`);
  const excluded = new Set([path.basename(stage), path.basename(rollback)]);
  const copyTree = (from, to) => {
    fs.mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(from)) {
      if (from === resolvedRoot && excluded.has(name)) continue;
      const source = path.join(from, name);
      const target = path.join(to, name);
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink()) throw new Error(`Link simbólico recusado: ${source}`);
      if (stat.isDirectory()) copyTree(source, target);
      else if (stat.isFile()) fs.copyFileSync(source, target);
      else throw new Error(`Tipo de arquivo não suportado: ${source}`);
    }
  };
  const clearTree = directory => {
    for (const name of fs.readdirSync(directory)) {
      if (directory === resolvedRoot && excluded.has(name)) continue;
      fs.rmSync(path.join(directory, name), { recursive: true, force: true });
    }
  };
  const moveContents = from => {
    for (const name of fs.readdirSync(from)) fs.renameSync(path.join(from, name), path.join(resolvedRoot, name));
  };
  fs.mkdirSync(stage, { mode: 0o700 });
  fs.mkdirSync(rollback, { mode: 0o700 });
  try {
    for (const item of entries) {
      const destination = path.join(stage, ...item.path.split('/'));
      if (item.directory) fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      else {
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        fs.writeFileSync(destination, item.data, { mode: 0o600, flag: 'wx' });
      }
    }
    copyTree(resolvedRoot, rollback);
    try {
      clearTree(resolvedRoot);
      moveContents(stage);
    } catch (error) {
      clearTree(resolvedRoot);
      moveContents(rollback);
      throw error;
    }
    console.log(`Volume restaurado. Cópia anterior preservada em ${rollback}; remova-a somente após validar o serviço.`);
  } finally {
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
  }
}

try {
  if (action === 'export') exportData();
  else if (action === 'restore') restoreData();
  else throw new Error('Ação inválida. Use export ou restore.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

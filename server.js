const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const cors = require('cors');
const multer = require('multer');
const checkDiskSpace = require('check-disk-space').default;
const crypto = require('crypto');

const ROOT = __dirname;
const configPath = path.join(ROOT, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const app = express();
const PORT = config.port || 3001;
const sessions = new Map();

let emulatorProcess = null;
let currentGame = null;
let startedAt = null;

// ==================== HELPERS ====================

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

const AUTH_HASH = hashPassword(config.password || 'changeme');

function ensureDirs() {
  for (const dir of [config.baseDir, config.gamesDir, config.savesDir, config.biosDir]) {
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function getBaseDir() {
  const base = path.resolve(config.baseDir || path.join(os.homedir(), 'PS2'));
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
  return base;
}

function isInsideBase(resolved) {
  const base = getBaseDir();
  const rel = path.relative(base, resolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function normalizePath(requestPath) {
  const base = getBaseDir();
  if (!requestPath || requestPath === '/' || requestPath === '\\') return base;

  const decoded = decodeURIComponent(requestPath);
  const resolved = path.isAbsolute(decoded)
    ? path.resolve(decoded)
    : path.resolve(base, decoded);

  if (!isInsideBase(resolved)) {
    throw new Error('Akses ditolak: di luar direktori yang diizinkan');
  }
  return resolved;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function scanGames(dir) {
  const games = [];
  const exts = (config.gameExtensions || ['.iso']).map((e) => e.toLowerCase());

  function walk(folder) {
    if (!fs.existsSync(folder)) return;
    const items = fs.readdirSync(folder, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(folder, item.name);
      try {
        if (item.isDirectory()) {
          walk(full);
        } else {
          const ext = path.extname(item.name).toLowerCase();
          if (exts.includes(ext)) {
            const stat = fs.statSync(full);
            games.push({
              name: item.name,
              path: full,
              size: stat.size,
              sizeFormatted: formatBytes(stat.size),
              mtime: stat.mtime,
              mtimeFormatted: new Date(stat.mtime).toLocaleString('id-ID'),
              ext,
            });
          }
        }
      } catch (_) { /* skip */ }
    }
  }

  walk(dir);
  games.sort((a, b) => a.name.localeCompare(b.name));
  return games;
}

/**
 * Cek PCSX2 untuk Windows: cari file .exe sesuai config.pcsx2Path.
 * Kalau path relatif, dianggap relatif terhadap folder project (ROOT) —
 * jadi cukup copy folder "PCSX2" (hasil portable PCSX2) ke dalam folder ini.
 */
function checkPcsx2() {
  const configuredPath = config.pcsx2Path || 'PCSX2\\pcsx2-qt.exe';
  const exePath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(ROOT, configuredPath);

  if (fs.existsSync(exePath) && fs.statSync(exePath).isFile()) {
    return { installed: true, command: exePath };
  }
  return { installed: false, command: null, expectedPath: exePath };
}

function checkBios() {
  const biosDir = config.biosDir;
  if (!biosDir || !fs.existsSync(biosDir)) {
    return { ok: false, files: [], message: 'Folder BIOS tidak ditemukan' };
  }
  const files = fs.readdirSync(biosDir).filter((f) => /\.(bin|rom)$/i.test(f));
  return {
    ok: files.length > 0,
    files,
    message: files.length > 0 ? 'BIOS terdeteksi' : 'Belum ada file BIOS (.bin)',
  };
}

function buildLaunchCommand(gamePath) {
  const pcsx2 = checkPcsx2();
  if (!pcsx2.installed) {
    throw new Error('PCSX2 tidak ditemukan di: ' + pcsx2.expectedPath + '. Copy folder PCSX2 portable ke sini.');
  }

  const bios = checkBios();
  if (!bios.ok) throw new Error('BIOS belum dikonfigurasi. Letakkan file BIOS di: ' + config.biosDir);

  const cmd = pcsx2.command;
  const args = [...(config.pcsx2Args || []), gamePath];
  return { cmd, args };
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        const target = normalizePath(config.gamesDir);
        cb(null, target);
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      cb(null, path.basename(file.originalname));
    },
  }),
  limits: { fileSize: (config.maxUploadMB || 4500) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = (config.gameExtensions || []).map((e) => e.toLowerCase());
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Tipe file tidak didukung: ' + ext));
  },
});

// ==================== MIDDLEWARE ====================

ensureDirs();

// SharedArrayBuffer (Play!.js) — hanya untuk halaman emulator
function needsIsolation(req) {
  return req.path.startsWith('/playjs')
    || req.path === '/emulator.html'
    || req.path === '/assets/emulator.js'
    || req.path.startsWith('/api/game-file');
}

app.use((req, res, next) => {
  if (needsIsolation(req)) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  next();
});

app.use(cors());
app.use(express.json());

// Hanya sajikan file statis yang memang untuk frontend.
// TIDAK menyajikan seluruh ROOT (agar config.json, server.js, dan
// folder PCSX2 tidak bisa diakses/diunduh langsung lewat browser).
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(ROOT, 'login.html')));
app.get('/emulator.html', (req, res) => res.sendFile(path.join(ROOT, 'emulator.html')));
app.use('/assets', express.static(path.join(ROOT, 'assets')));
app.use('/playjs', express.static(path.join(ROOT, 'playjs'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
  },
}));

// ==================== AUTH ====================

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (hashPassword(password || '') !== AUTH_HASH) {
    return res.status(401).json({ error: 'Password salah' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { created: Date.now() });
  res.json({ success: true, token });
});

app.get('/api/auth', requireAuth, (req, res) => {
  res.json({ authenticated: true });
});

app.post('/api/logout', requireAuth, (req, res) => {
  const token = req.headers['x-auth-token'];
  sessions.delete(token);
  res.json({ success: true });
});

// ==================== STATUS & CONFIG ====================

app.get('/api/status', requireAuth, (req, res) => {
  const pcsx2 = checkPcsx2();
  const bios = checkBios();
  res.json({
    running: emulatorProcess !== null && !emulatorProcess.killed,
    currentGame,
    startedAt,
    pid: emulatorProcess?.pid || null,
    pcsx2,
    bios,
    gamesDir: config.gamesDir,
    savesDir: config.savesDir,
    biosDir: config.biosDir,
    playJsEnabled: config.playJsEnabled !== false,
  });
});

app.get('/api/storage', requireAuth, async (req, res) => {
  try {
    const dir = config.gamesDir || getBaseDir();
    const info = await checkDiskSpace(dir);
    const used = info.size - info.free;
    res.json({
      path: dir,
      total: info.size,
      used,
      free: info.free,
      percentageUsed: parseFloat(((used / info.size) * 100).toFixed(2)),
      totalFormatted: formatBytes(info.size),
      usedFormatted: formatBytes(used),
      freeFormatted: formatBytes(info.free),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== GAMES ====================

app.get('/api/games', requireAuth, (req, res) => {
  try {
    const gamesDir = normalizePath(config.gamesDir);
    const games = scanGames(gamesDir);
    res.json({ games, gamesDir });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/launch', requireAuth, (req, res) => {
  try {
    const { path: gamePath } = req.body || {};
    if (!gamePath) return res.status(400).json({ error: 'Path game diperlukan' });

    const resolved = normalizePath(gamePath);
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File tidak ditemukan' });

    if (emulatorProcess && !emulatorProcess.killed) {
      return res.status(409).json({ error: 'PCSX2 masih berjalan. Stop dulu sebelum launch game lain.' });
    }

    const { cmd, args } = buildLaunchCommand(resolved);

    emulatorProcess = spawn(cmd, args, {
      detached: false,
      stdio: 'ignore',
      windowsHide: false,
    });

    currentGame = { name: path.basename(resolved), path: resolved };
    startedAt = new Date().toISOString();

    emulatorProcess.on('exit', () => {
      emulatorProcess = null;
      currentGame = null;
      startedAt = null;
    });

    emulatorProcess.on('error', (err) => {
      emulatorProcess = null;
      currentGame = null;
      startedAt = null;
      console.error('PCSX2 error:', err.message);
    });

    res.json({ success: true, pid: emulatorProcess.pid, game: currentGame });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stop', requireAuth, (req, res) => {
  if (!emulatorProcess || emulatorProcess.killed) {
    return res.json({ success: true, message: 'Tidak ada emulator yang berjalan' });
  }
  try {
    // taskkill /T agar proses anak (PCSX2 sebenarnya) ikut tertutup di Windows
    execSync(`taskkill /PID ${emulatorProcess.pid} /T /F`, { stdio: 'ignore' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload', requireAuth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File terlalu besar (maks ${config.maxUploadMB}MB)` });
      }
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'Tidak ada file' });
    res.json({
      success: true,
      file: {
        name: req.file.filename,
        path: req.file.path,
        size: req.file.size,
        sizeFormatted: formatBytes(req.file.size),
      },
    });
  });
});

app.delete('/api/delete', requireAuth, (req, res) => {
  try {
    const target = normalizePath(req.query.path);
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'File tidak ditemukan' });
    if (emulatorProcess && currentGame?.path === target) {
      return res.status(409).json({ error: 'Game sedang berjalan, stop dulu' });
    }
    fs.unlinkSync(target);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== GAME FILE (HTTP Range for Play!.js) ====================

app.get('/api/game-file', requireAuth, (req, res) => {
  try {
    const resolved = normalizePath(req.query.path);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return res.status(404).json({ error: 'File tidak ditemukan' });
    }

    const stat = fs.statSync(resolved);
    const total = stat.size;
    const range = req.headers.range;

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      if (start >= total || end >= total || start > end) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.status(416).end();
      }
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', chunkSize);
      fs.createReadStream(resolved, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', total);
      fs.createReadStream(resolved).pipe(res);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== FILES (browse saves/bios) ====================

app.get('/api/files', requireAuth, (req, res) => {
  try {
    const dir = normalizePath(req.query.path || config.savesDir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return res.status(404).json({ error: 'Folder tidak ditemukan' });
    }
    const base = getBaseDir();
    const items = fs.readdirSync(dir, { withFileTypes: true });
    const directories = [];
    const files = [];

    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const full = path.join(dir, item.name);
      try {
        const stat = fs.statSync(full);
        const info = {
          name: item.name,
          path: full,
          size: stat.size,
          sizeFormatted: formatBytes(stat.size),
          mtimeFormatted: new Date(stat.mtime).toLocaleString('id-ID'),
          isDirectory: item.isDirectory(),
        };
        if (item.isDirectory()) directories.push(info);
        else files.push(info);
      } catch (_) { /* skip */ }
    }

    directories.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      currentPath: dir,
      basePath: base,
      canGoUp: dir !== base,
      parentPath: dir !== base ? path.dirname(dir) : null,
      directories,
      files,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', platform: os.platform() });
});

// ==================== START ====================

app.listen(PORT, '0.0.0.0', () => {
  const pcsx2 = checkPcsx2();
  console.log(`
==============================================
  PS2 Server Web
  http://localhost:${PORT}
  Games    : ${config.gamesDir}
  PCSX2    : ${pcsx2.installed ? pcsx2.command : 'TIDAK DITEMUKAN'}
  Play!.js : ${config.playJsEnabled !== false ? 'enabled' : 'disabled'}
==============================================
  `);
});

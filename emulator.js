import Play from '/playjs/Play.js';

const token = localStorage.getItem('ps2_token');
if (!token) {
  window.location.href = 'login.html';
}

const params = new URLSearchParams(window.location.search);
const gamePath = params.get('game');
if (!gamePath) {
  window.location.href = 'index.html';
}

class DiscImageDevice {
  constructor(module) {
    this.module = module;
    this.doneFlag = false;
    this.file = null;
  }

  read(dstPtr, offset, size) {
    if (!this.file) throw new Error('No file set.');
    this.doneFlag = false;
    const subsection = this.file.slice(offset, offset + size);
    subsection.arrayBuffer().then((value) => {
      this.module.HEAPU8.set(new Uint8Array(value), dstPtr);
      this.doneFlag = true;
    });
  }

  getFileSize() {
    if (!this.file) throw new Error('No file set.');
    return this.file.size;
  }

  isDone() {
    return this.doneFlag;
  }

  setFile(file) {
    this.file = file;
  }
}

class RangeFile {
  constructor({ url, name, size }) {
    this.url = url;
    this.name = name;
    this.size = size;
  }

  slice(start, end) {
    const url = this.url;
    const authToken = token;
    return {
      async arrayBuffer() {
        const headers = { 'X-Auth-Token': authToken };
        if (end > start) {
          headers.Range = `bytes=${start}-${end - 1}`;
        }
        const res = await fetch(url, { headers });
        if (!res.ok && res.status !== 206) {
          throw new Error(`Gagal memuat data game (${res.status})`);
        }
        return res.arrayBuffer();
      },
    };
  }
}

function setLoading(status, detail, pct) {
  document.getElementById('loading-status').textContent = status;
  document.getElementById('loading-detail').textContent = detail || '';
  if (pct != null) {
    document.getElementById('loading-progress').style.width = `${pct}%`;
  }
}

function hideLoading() {
  document.getElementById('loading-screen').classList.add('hidden');
}

async function verifyAuth() {
  const res = await fetch('/api/auth', { headers: { 'X-Auth-Token': token } });
  if (!res.ok) {
    localStorage.removeItem('ps2_token');
    window.location.href = 'login.html';
    throw new Error('Unauthorized');
  }
}

async function fetchGameInfo(path) {
  const res = await fetch('/api/games', { headers: { 'X-Auth-Token': token } });
  if (!res.ok) throw new Error('Gagal memuat daftar game');
  const data = await res.json();
  const game = data.games.find((g) => g.path === path);
  if (!game) throw new Error('Game tidak ditemukan di library');
  return game;
}

async function initEmulator() {
  await verifyAuth();
  setLoading('Memuat info game...', 'Mencari file ISO di library', 10);

  const game = await fetchGameInfo(gamePath);
  document.getElementById('game-title').textContent = game.name;

  const fileUrl = `/api/game-file?path=${encodeURIComponent(game.path)}`;
  const rangeFile = new RangeFile({
    url: fileUrl,
    name: game.name,
    size: game.size,
  });

  setLoading('Memuat Play!.js WASM...', 'Ini bisa memakan waktu 10–30 detik', 25);

  const moduleOverrides = {
    canvas: document.getElementById('outputCanvas'),
    locateFile: (p) => `/playjs/${p}`,
    mainScriptUrlOrBlob: '/playjs/Play.js',
    setStatus(text) {
      if (text) setLoading('Memuat Play!.js WASM...', text, 40);
    },
  };

  const PlayModule = await Play(moduleOverrides);
  PlayModule.FS.mkdir('/work');
  PlayModule.discImageDevice = new DiscImageDevice(PlayModule);
  PlayModule.ccall('initVm', '', [], []);

  setLoading('Menyiapkan game...', `Memuat ${game.name} (${game.sizeFormatted})`, 70);

  const ext = game.name.substring(game.name.lastIndexOf('.')).toLowerCase();
  if (ext === '.elf') {
    setLoading('Memuat ELF...', 'Mengunduh file ke memori emulator', 80);
    const res = await fetch(fileUrl, { headers: { 'X-Auth-Token': token } });
    if (!res.ok) throw new Error('Gagal mengunduh ELF');
    const data = new Uint8Array(await res.arrayBuffer());
    const stream = PlayModule.FS.open(game.name, 'w+');
    PlayModule.FS.write(stream, data, 0, data.length, 0);
    PlayModule.FS.close(stream);
    PlayModule.bootElf(game.name);
  } else {
    PlayModule.discImageDevice.setFile(rangeFile);
    PlayModule.bootDiscImage(game.name);
  }

  setLoading('Game dimulai!', 'Klik canvas untuk fokus keyboard', 100);
  setTimeout(hideLoading, 600);

  const canvas = document.getElementById('outputCanvas');
  canvas.focus();
  canvas.addEventListener('click', () => canvas.focus());

  const fpsEl = document.getElementById('fps-counter');
  fpsEl.classList.remove('hidden');
  setInterval(() => {
    if (typeof PlayModule.getFrames === 'function') {
      const frames = PlayModule.getFrames();
      PlayModule.clearStats();
      fpsEl.textContent = `${frames} f/s`;
    }
  }, 1000);
}

document.getElementById('toggle-controls').addEventListener('click', () => {
  document.getElementById('controls-panel').classList.toggle('hidden');
});

document.getElementById('fullscreen-btn').addEventListener('click', () => {
  const stage = document.querySelector('.emulator-stage');
  if (!document.fullscreenElement) {
    stage.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
});

initEmulator().catch((err) => {
  setLoading('Error', err.message, 0);
  document.querySelector('.emu-loading .spinner')?.classList.add('hidden');
});

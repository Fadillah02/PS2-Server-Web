const API = '/api';
let currentView = 'games';
let statusPoll = null;
let currentFolder = '';
let currentUploadFile = null;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

async function apiFetch(url, opts) {
  const token = sessionStorage.getItem('token') || localStorage.getItem('token');
  const headers = { ...(opts?.headers || {}) };
  if (token) headers['x-auth-token'] = token;
  return fetch(url, { ...opts, headers });
}

async function init() {
  const token = sessionStorage.getItem('token') || localStorage.getItem('token');
  if (!token) { window.location.href = 'login.html'; return; }

  const res = await apiFetch(API + '/auth');
  if (!res.ok) { window.location.href = 'login.html'; return; }

  document.getElementById('app').classList.remove('hidden');
  document.getElementById('loading-screen').classList.add('hidden');

  setupToolbar();
  setupConfirmModal();
  document.getElementById('stop-btn').addEventListener('click', stopEmulator);
  document.getElementById('btn-games').addEventListener('click', () => showGamesView());
  document.getElementById('btn-saves').addEventListener('click', () => browseFolder('saves'));
  document.getElementById('btn-bios').addEventListener('click', () => browseFolder('bios'));
  document.getElementById('btn-logout').addEventListener('click', logout);

  await refreshAll();
  statusPoll = setInterval(refreshStatus, 5000);
}

async function logout() {
  clearInterval(statusPoll);
  await apiFetch(API + '/logout', { method: 'POST' });
  sessionStorage.removeItem('token');
  localStorage.removeItem('token');
  window.location.href = 'login.html';
}

function setupToolbar() {
  document.getElementById('stop-btn').addEventListener('click', stopEmulator);
  const uploadInput = document.getElementById('upload-input');
  uploadInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) uploadGame(e.target.files[0]);
  });
  document.getElementById('upload-btn').addEventListener('click', () => uploadInput.click());
  document.getElementById('search-input').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('.game-card').forEach(c => {
      c.style.display = c.dataset.name?.toLowerCase().includes(q) ? '' : 'none';
    });
  });
}

function setupConfirmModal() {
  document.getElementById('confirm-cancel').addEventListener('click', () => {
    document.getElementById('confirm-overlay').classList.add('hidden');
  });
  document.getElementById('confirm-yes').addEventListener('click', async () => {
    const cb = window._confirmCb;
    document.getElementById('confirm-overlay').classList.add('hidden');
    if (cb) await cb();
  });
}

function confirmAction(msg, cb) {
  document.getElementById('confirm-msg').textContent = msg;
  window._confirmCb = cb;
  document.getElementById('confirm-overlay').classList.remove('hidden');
}

async function refreshAll() {
  await Promise.all([refreshStatus()]);
  if (currentView === 'games') loadGames();
}

async function refreshStatus() {
  try {
    const res = await apiFetch(API + '/status');
    const data = await res.json();

    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const stopBtn = document.getElementById('stop-btn');
    const gameInfo = document.getElementById('current-game');

    if (data.running) {
      statusDot.className = 'status-dot running';
      statusText.textContent = 'PCSX2 Berjalan';
      stopBtn.disabled = false;
      gameInfo.textContent = data.currentGame?.name || 'Game tidak diketahui';
      gameInfo.className = 'current-game visible';
    } else {
      statusDot.className = 'status-dot stopped';
      statusText.textContent = 'PCSX2 Tidak Berjalan';
      stopBtn.disabled = true;
      gameInfo.className = 'current-game hidden';
    }
  } catch (err) {
    console.error('Status refresh error:', err);
  }
}

function showGamesView() {
  currentView = 'games';
  document.getElementById('page-title').innerHTML = '<i class="fas fa-compact-disc"></i> Library Game';
  document.getElementById('games-grid').classList.remove('hidden');
  document.getElementById('files-view').classList.add('hidden');
  document.getElementById('upload-btn').classList.remove('hidden');
  loadGames();
}

async function loadGames() {
  const grid = document.getElementById('games-grid');
  grid.innerHTML = '<div class="loading"><div class="spinner"></div><p>Memuat daftar game...</p></div>';

  try {
    const res = await apiFetch(API + '/games');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    grid.innerHTML = '';
    if (!data.games || data.games.length === 0) {
      grid.innerHTML = '<div class="empty-state"><i class="fas fa-folder-open"></i><p>Belum ada game. Upload file .iso / .chd / .bin</p></div>';
      return;
    }

    data.games.forEach(game => {
      const card = document.createElement('div');
      card.className = 'game-card';
      card.dataset.name = game.name;

      const browserBtn = game.playJsEnabled !== false
        ? `<button class="btn btn-browser btn-play-browser" title="Play di Browser"><i class="fas fa-globe"></i> Play di Browser</button>`
        : '';

      card.innerHTML = `
        <div class="game-cover"><i class="fas fa-compact-disc"></i><span class="game-ext">${escapeHtml(game.ext)}</span></div>
        <div class="game-name">${escapeHtml(game.name)}</div>
        <div class="game-meta">${escapeHtml(game.sizeFormatted)}</div>
        <div class="game-actions">
          ${browserBtn}
          <button class="btn btn-native btn-play-native" title="Launch PCSX2"><i class="fas fa-desktop"></i> Launch PCSX2</button>
          <button class="btn btn-secondary btn-del" title="Hapus"><i class="fas fa-trash"></i></button>
        </div>`;
      const browserEl = card.querySelector('.btn-play-browser');
      if (browserEl) browserEl.addEventListener('click', (e) => { e.stopPropagation(); playInBrowser(game); });
      card.querySelector('.btn-play-native').addEventListener('click', (e) => { e.stopPropagation(); launchGame(game); });
      card.querySelector('.btn-del').addEventListener('click', (e) => { e.stopPropagation(); deleteGame(game); });
      grid.appendChild(card);
    });
  } catch (err) {
    grid.innerHTML = `<div class="error-state"><i class="fas fa-exclamation-circle"></i><p>${escapeHtml(err.message)}</p></div>`;
  }
}

async function launchGame(game) {
  showToast('Meluncurkan ' + game.name + ' via PCSX2...', 'success');
  try {
    const res = await apiFetch(API + '/launch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: game.path }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast('PCSX2 berjalan: ' + game.name, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function stopEmulator() {
  try {
    const res = await apiFetch(API + '/stop', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast('Emulator dihentikan', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function playInBrowser(game) {
  window.location.href = '/emulator.html?game=' + encodeURIComponent(game.path) + '&token=' + (sessionStorage.getItem('token') || localStorage.getItem('token'));
}

async function deleteGame(game) {
  confirmAction('Hapus ' + game.name + '?', async () => {
    try {
      const res = await apiFetch(API + '/delete?path=' + encodeURIComponent(game.path), { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      showToast('Game dihapus', 'success');
      loadGames();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

async function uploadGame(file) {
  showToast('Mengupload ' + file.name + '...', 'success');
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await apiFetch(API + '/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast('Upload berhasil: ' + data.file.name, 'success');
    loadGames();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function browseFolder(type) {
  currentView = 'files';
  const title = type === 'saves' ? 'Saves' : 'BIOS';
  document.getElementById('page-title').innerHTML = `<i class="fas fa-folder"></i> ${title}`;
  document.getElementById('games-grid').classList.add('hidden');
  document.getElementById('files-view').classList.remove('hidden');
  document.getElementById('upload-btn').classList.add('hidden');
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('error-state').classList.add('hidden');

  const container = document.getElementById('files-content');
  container.innerHTML = '<div class="loading"><div class="spinner"></div><p>Memuat...</p></div>';

  try {
    const res = await apiFetch(API + '/files?path=' + (type === 'saves' ? '' : 'bios'));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    renderFiles(container, data);
  } catch (err) {
    container.innerHTML = `<div class="error-state"><i class="fas fa-exclamation-circle"></i><p>${escapeHtml(err.message)}</p></div>`;
  }
}

function renderFiles(container, data) {
  if (!data.directories.length && !data.files.length) {
    container.innerHTML = '<div class="empty-state"><i class="fas fa-folder-open"></i><p>Folder kosong</p></div>';
    return;
  }

  let html = '';
  if (data.canGoUp) {
    html += `<div class="file-item file-folder" onclick="browseFolder('saves')">
      <i class="fas fa-level-up-alt"></i><span>../ (Kembali)</span></div>`;
  }
  data.directories.forEach(d => {
    html += `<div class="file-item file-folder" onclick="browseFolder('saves')">
      <i class="fas fa-folder"></i><span>${escapeHtml(d.name)}</span></div>`;
  });
  data.files.forEach(f => {
    html += `<div class="file-item file-file">
      <i class="fas fa-file"></i><span>${escapeHtml(f.name)}</span>
      <span class="file-size">${escapeHtml(f.sizeFormatted)}</span></div>`;
  });
  container.innerHTML = html;
}

function showToast(msg, type) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast ' + (type || 'success');
  toast.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.add('hidden'), 4000);
}

document.addEventListener('DOMContentLoaded', init);

# PS2 Server Web

Web dashboard untuk mengelola dan menjalankan game PS2 via PCSX2 dari browser.

## Fitur
- Upload game ISO / CHD / BIN via browser
- Jalankan langsung di PCSX2 (native)
- Play di browser via Play!.js (eksperimental)
- Kelola save files & BIOS

## Yang Dibutuhkan

| Software | Fungsi | Link |
|----------|--------|------|
| **Node.js** | Menjalankan server web | [nodejs.org](https://nodejs.org) |
| **PCSX2** | Emulator PS2 (portable) | [pcsx2.net](https://pcsx2.net) |
| **BIOS PS2** | File BIOS PS2 (legal: dump dari PS2 sendiri) | — |
| **Game ISO** | File game PS2 (.iso / .chd) | — |

> **Catatan:** Play!.js (emulator browser) sudah termasuk dalam dashboard, tidak perlu install terpisah.

## Cara Install

### 1. Install Node.js
Download dan install Node.js dari [nodejs.org](https://nodejs.org) (versi LTS).

### 2. Download PCSX2
- Download **PCSX2 portable** dari [pcsx2.net](https://pcsx2.net)
- Extract ke folder: `PCSX2\` (di dalam folder dashboard ini, samping `server.js`)

Atau letakkan di mana saja dan sesuaikan `pcsx2Path` di `config.json`.

### 3. Siapkan Folder Game & BIOS
Buat folder:
```
C:\PS2\
├── isos\     ← letakkan file game .iso / .chd di sini
├── saves\    ← save files (otomatis)
└── bios\     ← letakkan file BIOS .bin di sini
```

### 4. Install Dependencies
```
npm install
```

### 5. Jalankan
```
npm start
```
Buka browser: **http://localhost:3001**

Default password: `changeme` (bisa diubah di `config.json`)

## Struktur Folder

```
PS2 Server Web/
├── server.js              ← Server backend
├── index.html             ← Dashboard utama
├── login.html             ← Halaman login
├── emulator.html          ← Play!.js emulator
├── emulator.js            ← Script emulator
├── config.json            ← Konfigurasi (password, path, dll)
├── package.json           ← Dependencies Node.js
├── assets/
│   ├── script.js          ← Frontend logic
│   └── styles.css         ← Styling
├── PCSX2/                 ← PCSX2 portable (download sendiri)
├── playjs/                ← Play!.js files (built-in)
└── PANDUAN.md             ← File ini
```

## Konfigurasi

Edit `config.json`:

```json
{
  "port": 3001,
  "password": "changeme",
  "playJsEnabled": true,
  "baseDir": "C:\\PS2",
  "gamesDir": "C:\\PS2\\isos",
  "savesDir": "C:\\PS2\\saves",
  "biosDir": "C:\\PS2\\bios",
  "pcsx2Path": "PCSX2\\pcsx2-qt.exe",
  "pcsx2Args": ["-batch"],
  "gameExtensions": [".iso", ".chd", ".cso", ".bin", ".elf", ".gz"],
  "maxUploadMB": 4500
}
```

## Catatan Hak Cipta

Repo ini hanya berisi **kode sumber dashboard** (server.js, HTML, CSS, JS) dan **Play!.js** (emulator browser open source).

**Yang perlu Anda sediakan sendiri:**
- **PCSX2** — emulator terpisah, unduh dari [pcsx2.net](https://pcsx2.net)
- **BIOS PS2** — tidak disertakan (wajib dump dari console sendiri)
- **Game ISO** — file game Anda sendiri

**Tidak ada konten berhak cipta yang dibundel.**

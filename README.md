# Ecobox

A self-hosted audiobook and media player web application. Stream your audio library from any device with playback position sync, chapters, bookmarks, and audio effects.

## Features

- Browse and play audio files (.mp3, .m4a, .m4b, .aac, .ogg, .opus, .wav, .flac)
- Automatic playback position saving and resume
- Chapter support (ID3 chapters, DAISY audiobooks)
- Bookmarks with labels
- Audio effects (6-band EQ, compressor, reverb, high-pass filter)
- Playback speed control (0.5x - 2x)
- Sleep timer
- Radio stream support (.radio files)
- **Book reading (text-to-speech)** — convert EPUB/DOCX/TXT into books read aloud, using your browser's built-in voice (free, local), a fully local on-server engine (ELF, or Piper with your own neural voices), or a cloud voice service (ElevenLabs, Azure, Google)
- File upload and sync
- Mobile-friendly interface

## Requirements

- Node.js 18+
- npm
- `pandoc` (optional) — only needed for the book reading feature, to convert EPUB/DOCX into readable text (`apt install pandoc`). TXT files convert without it.

## Quick Start

1. **Clone and install dependencies**
   ```bash
   git clone <repo-url>
   cd ecobox-web
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   ```

   Edit `.env`:
   ```
   MEDIA_ROOT=/path/to/your/audiobooks
   DATABASE_URL=file:./data/ecobox.db
   PORT=3000
   ```

3. **Initialize database**
   ```bash
   npm run db:push
   ```

4. **Run development server**
   ```bash
   npm run dev
   ```

   Open http://localhost:3000

## Running on Windows

Ecobox runs natively on Windows — no WSL, no container. Everything works, including
the local **ELF** speech engine, which ships a second, Windows-native build of the
engine alongside the Linux one.

**Requirements**

- **Node.js 22 LTS.** Not newer: `better-sqlite3` 11.x has no prebuilt binary for
  Node 26 and won't compile against its V8 headers either, so the install fails.
  On Node 22 it installs from a prebuilt binary with no compiler needed.
- **ffmpeg** on `PATH` — required by the local TTS engines (ELF, Piper), which
  transcode their WAV output to MP3. `winget install Gyan.FFmpeg`.
- **pandoc** (optional) — only for converting EPUB/DOCX books. `winget install
  JohnMacFarlane.Pandoc`. TXT books convert without it.

**Setup**

```powershell
git clone <repo-url>
cd ecobox-web
pnpm install

copy .env.example .env
```

Edit `.env`. Use **forward slashes** in paths — Windows accepts them everywhere and
they sidestep any question of backslash escaping in `.env` values:

```
MEDIA_ROOT=C:/Users/you/Audiobooks
DATABASE_URL=file:./data/ecobox.db
PORT=3000
```

Then build and run:

```powershell
pnpm run build
.\start-windows.ps1
```

`start-windows.ps1` is the Windows counterpart of the systemd unit used on Linux:
SvelteKit's Node adapter reads its configuration from the process environment and
does not load `.env` on its own, so the script loads it and then starts `node build`.
Re-run `pnpm run build` after any source change — the server serves the last build.

To run it on boot, register the script as a service with
[NSSM](https://nssm.cc/) or a Task Scheduler task set to "run whether user is logged
on or not".

**Text-to-speech on Windows**

- **ELF** works out of the box. `elf/lib-win32/` holds the original 32-bit Windows
  ECI runtime and `elf/bin/eci_synth.exe` is committed, so there is nothing to build.
- **Piper** works too, but its virtualenv is per-machine and not committed. Create it
  with `python -m venv piper1\venv` then
  `piper1\venv\Scripts\python -m pip install piper-tts`, and import voices in Settings.
- The cloud services (ElevenLabs, Azure, Google) and Web Speech behave identically to
  Linux.

## Production Deployment

1. **Build the application**
   ```bash
   npm run build
   ```

2. **Set production environment**
   ```bash
   export MEDIA_ROOT=/path/to/your/audiobooks
   export DATABASE_URL=file:/var/lib/ecobox/ecobox.db
   export PORT=3000
   export ORIGIN=https://ecobox.example.com
   ```

3. **Run the server**
   ```bash
   node build
   ```

### Running with PM2

```bash
pm2 start build/index.js --name ecobox
pm2 save
```

### Systemd Service

Create `/etc/systemd/system/ecobox.service`:
```ini
[Unit]
Description=Ecobox Media Server
After=network.target

[Service]
Type=simple
User=ecobox
WorkingDirectory=/opt/ecobox
Environment=MEDIA_ROOT=/mnt/media/audiobooks
Environment=DATABASE_URL=file:/var/lib/ecobox/ecobox.db
Environment=PORT=3000
Environment=ORIGIN=https://ecobox.example.com
ExecStart=/usr/bin/node build/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable ecobox
sudo systemctl start ecobox
```

## Caddy 2 Reverse Proxy

Add to your Caddyfile:

```caddy
ecobox.example.com {
    reverse_proxy localhost:3000
}
```

With basic auth:
```caddy
ecobox.example.com {
    basicauth {
        # Generate hash: caddy hash-password
        username $2a$14$hashedpasswordhere
    }
    reverse_proxy localhost:3000
}
```

Reload Caddy:
```bash
sudo systemctl reload caddy
```

## Usage

### File Browser

- Navigate folders by clicking on them
- Click audio files to play
- Use search bar to filter current directory
- Sort by name, size, or date

### Playback

- **Space**: Play/pause
- **Left/Right arrows**: Seek backward/forward
- **Up/Down arrows**: Volume control
- Tap/click seek bar to jump to position
- Use chapter list to navigate chapters

### Special Folder Types

**Chaptered Folders**: Create a `.CHAPTERED` file in a folder to treat all audio files as chapters of a single book. Playback continues automatically between files.

**DAISY Audiobooks**: Folders containing `ncc.html`, `ncc.xml`, or `Navigation.xml` are recognized as DAISY books with full chapter navigation.

**Radio Streams**: Create a `.radio` file with JSON content:
```json
{
  "url": "https://stream.example.com/radio.mp3",
  "name": "My Radio Station"
}
```

### Book Reading (Text-to-Speech)

Ecobox can read written books aloud. Upload an **EPUB**, **DOCX**, or **TXT** file (or use the **Convert** action in the file browser) and Ecobox turns it into a book that's narrated sentence by sentence, with saved reading position, find-in-book, and chapter navigation — just like the audio player.

You choose how the narration is produced in **Settings → reading / TTS service**:

**Local (default — no setup, no API keys)**

The `webspeech` service uses your browser's built-in **Web Speech** voices. It's free, runs entirely on your device, and works out of the box — no keys, no accounts, nothing to configure. The available voices depend on your operating system and browser. Caveats: it can't reliably keep playing in the background or on the lock screen (a browser limitation, worst on iOS), and changing voice or speed mid-sentence re-reads the current sentence.

**Fully local server voices (no internet, no API key)**

Two engines synthesize on the server itself — no account, no key, nothing leaves the machine — and, unlike Web Speech, they support proper **background / lock-screen playback**:

- **ELF** — a compact voice that ships built into Ecobox. Just pick it in **Settings → TTS service** and choose a voice (English, Spanish, French, German, Italian, Portuguese, Finnish).
- **Piper** — a neural engine (more natural-sounding) that runs on-server. Ecobox ships the engine but **no voices** — you import the ones you want (see below).

**Importing a Piper voice**

A Piper voice is two files: the model (`<name>.onnx`) and its config (`<name>.onnx.json`). Download a pair from the [Piper voices catalogue](https://huggingface.co/rhasspy/piper-voices) (any quality — low / medium / high), or use your own, then:

1. Open **Settings → Voices & AI services**.
2. Set **Service** to **Piper (on this server)**.
3. Click **Import voice…** and select **both** files at once — the `.onnx` *and* its `.onnx.json`.
4. The voice appears in the list below — select it. No restart needed.

Notes:

- Select **both** files together; importing just one is rejected.
- The model's filename must be plain — letters, numbers, `.`, `-`, `_`, no spaces. Rename the `.onnx` (and match its `.onnx.json`) if needed.
- Multi-speaker voices work too — each speaker shows up as its own selectable voice.
- Imported voices are stored under `data/piper-voices/` (override with the `PIPER_VOICES_DIR` env var), so they're never bundled with the app and survive upgrades. Remove one with the delete button next to it.

**If you want higher-quality cloud voices**

Server-synthesized services produce more natural narration and support proper **background / lock-screen playback**:

- **ElevenLabs** — most natural voices; requires an API key
- **Azure** — requires an API key + region
- **Google** — requires an API key
- **Azure Edge** (`azure-edge`) — keyless Microsoft Edge read-aloud voices (experimental, no account needed)

To use a key-based service, open **Settings → TTS service**, pick the provider, and paste in your API key (and region, for Azure). Keys are stored server-side and are **never sent back to the browser**. Synthesized audio is cached on disk, so re-reading a passage doesn't call the API again.

You can also seed keys from the environment instead of the UI:

```
ELEVENLABS_API_KEY=...
AZURE_SPEECH_KEY=...
AZURE_SPEECH_REGION=...      # e.g. eastus
GOOGLE_TTS_API_KEY=...
```

**Which should I pick?** For zero setup, the local Web Speech voice or the built-in ELF engine work for free. For natural-sounding narration without any account or internet, import a **Piper** voice. For the best cloud voices (or if you'd rather not manage voice files), add an API key for one of the cloud services. All of them except Web Speech also handle background / lock-screen playback — and you can switch services at any time without losing your reading position.

> Converting EPUB/DOCX requires the `pandoc` system binary (see Requirements). If it's missing, conversion of those formats fails safely and the original file is kept; TXT files don't need it.

### Uploading Files

Click the upload button in the file browser to upload files or sync folders from your device.

## Database Management

```bash
# Open database GUI
npm run db:studio

# Generate migration after schema changes
npm run db:generate

# Apply migrations
npm run db:migrate
```

## License

MIT

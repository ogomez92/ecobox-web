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
- File upload and sync
- Mobile-friendly interface

## Requirements

- Node.js 18+
- npm

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

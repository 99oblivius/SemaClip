# Data Directory

## Structure

```
data/
├── training/          # Streams used for model development and calibration
│   ├── video.mp4      # VOD file (gitignored)
│   ├── chat.json      # Twitch chat transcript (TwitchDownloader format)
│   └── README.md
└── testing/           # Held-out streams for evaluation (never used in training)
    ├── video.mp4
    ├── chat.json
    └── README.md
```

## Current Training Data

| VOD | Streamer | Game | Duration | Chat Messages | Avg Msg/Hz |
|---|---|---|---|---|---|
| [2827417958](https://www.twitch.tv/videos/2827417958) | SoulCamera | Overwatch | 5.8h | 110 | ~19 |

This is an intentionally sparse test case — a small streamer with very low chat engagement (~1 message every 3 minutes). This stress-tests the architecture's ability to rely on voice signal when chat is unreliable.

## Adding Data

### Download a VOD
```bash
yt-dlp -f "720p+Audio_Only" -o "data/<split>/video.mp4" "<twitch_url>"
```

### Download chat
```bash
# Requires TwitchDownloaderCLI
TwitchDownloaderCLI chatdownload -u <vod_id> -o data/<split>/chat.json --embed-images
```

Download from: https://github.com/lay295/TwitchDownloader/releases

### Chat JSON Structure
The chat file is a JSON object with the following keys:

| Key | Type | Description |
|---|---|---|
| `comments` | list | Array of chat messages with timestamps, commenter info, and message content |
| `video` | dict | VOD metadata (title, duration, game, timestamps) |
| `streamer` | dict | Streamer info (name, id) |
| `embeddedData` | dict | Emote, badge, and bit data for offline rendering |

Each comment in the `comments` array contains:
- `content_offset_seconds`: time offset from VOD start
- `commenter`: user display name and ID
- `message`: message body with fragments (text + emotes)
- `created_at`: UTC timestamp

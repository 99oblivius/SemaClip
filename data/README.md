# Data Directory

## Structure

```
data/
├── training/          # Streams used for development and calibration
│   ├── video.mp4      # VOD file (gitignored)
│   ├── chat.json      # Twitch chat transcript
│   └── README.md
└── testing/           # Intended as held-out evaluation data — see its README, it is
    │                  # no longer clean (jfk.wav is the CI fixture, ironmouse_4h has
    │                  # already been used for validation)
    ├── fixtures/jfk.wav         # 11s speech fixture, the engine E2E input in CI
    └── ironmouse_4h/
        ├── video.mp4
        └── chat.json
```

Files here are placed by hand. Nothing in the repo downloads them.

## Current data

| VOD | Streamer | Game | Duration | Chat Messages | Avg Msg/h |
|---|---|---|---|---|---|
| [2827417958](https://www.twitch.tv/videos/2827417958) | SoulCamera | Overwatch | 5.8h | 110 | ~19 |

This is an intentionally sparse test case — a small streamer with very low chat
engagement (~1 message every 3 minutes). This stress-tests the architecture's ability
to rely on the voice signal when chat is unreliable.

`data/testing/ironmouse_4h` is the opposite: 4.01h with 17,473 comments, used to
validate the detectors against dense chat.

## Chat JSON structure

The chat file is a JSON object with these keys:

| Key | Type | Description |
|---|---|---|
| `comments` | list | Array of chat messages with timestamps, commenter info, and content |
| `video` | dict | VOD metadata (title, duration, game, timestamps) |
| `streamer` | dict | Streamer info (name, id) |
| `embeddedData` | dict | Emote, badge, and bit data for offline rendering |
| `FileInfo` | dict | Producer metadata (`Version`, `CreatedAt`, ...) |
| `clipper` | dict | Which tool produced the file and its version |

Each comment in the `comments` array contains:

- `content_offset_seconds`: time offset from VOD start
- `commenter`: user display name and ID
- `message`: message body with fragments (text + emotes)
- `created_at`: UTC timestamp

The app now fetches chat itself over Twitch GQL
(`server/adapters/outbound/vod/chat-fetch.ts`) and writes this same shape, so a
hand-placed file from another tool stays readable.

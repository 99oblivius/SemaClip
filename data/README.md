# Data Directory

## Structure

```
data/
├── training/          # Streams used for development and calibration
│   ├── video.mp4      # VOD file (gitignored)
│   ├── chat.json      # Twitch chat transcript (gitignored)
│   └── README.md
└── testing/           # Intended as held-out evaluation data — see its README, it is
    │                  # no longer clean (jfk.wav is the CI fixture, and the dense-chat
    │                  # case has already been used for validation)
    ├── fixtures/jfk.wav         # 11s speech fixture, the engine E2E input in CI
    └── <dense-chat>/            # video.mp4 + chat.json, gitignored
```

Files here are placed by hand. Nothing in the repo downloads them. No fixture's
actual channel name, VOD id or game is recorded in this repository: the local files
are a real channel's data and stay local, and only their SHAPE matters to the code.

## What the fixtures are for

Two cases matter, and they are opposite ends of the chat-signal range:

- a **sparse** case — a channel with very low chat engagement (~1 message every 3
  minutes), which stress-tests relying on the voice signal when chat is unreliable;
- a **dense** case — a multi-hour stream with tens of thousands of comments, used to
  validate the detectors against dense chat.

Record the measured figures in the local copy, not here.

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

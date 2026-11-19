# Super Player

A movie, TV and anime streaming player for iPhone and iPad.

## What it does

- **Browse** trending, popular and top-rated movies, shows and anime, with search and full detail pages (cast, seasons, episodes, ratings).
- **Home built for watching**: Continue Watching, Top 10 rails, and poster rows.
- **Nostalgia**: rows for Childhood Movies, Cartoon Network, Old School Nick, Toonami Anime, Disney Channel and Boomerang.
- **Native player** with separate controls for Server, Audio, Subtitles, Speed and Quality (Max, your screen's own resolution like 1170p on iPhone 16e, 4K, 1440p, 1080p, 720p, 480p, 360p).
- **Sub or dub** for anime: anime servers show as Sub and Dub entries,, with subtitles from the stream or from Wyzie subtitle search.
- **Smart servers**: anime titles only list anime servers; movies and series only list regular servers.
- **Library** with watchlist, watch history and progress saved on the device.
- **Portrait and landscape** layouts across the whole app.
- **TMDB built in**: no API key setup needed.

## Build

Every push to `main` runs **Build iOS (unsigned IPA)** in GitHub Actions. Download the `Super-Player-unsigned` artifact from the run and sideload it (AltStore, Sideloadly, etc.).

Local build:

```bash
npm ci
npx vite build --mode ios
npx cap sync ios
# then open ios/App/App.xcodeproj in Xcode
```

## Subtitles

Wyzie subtitle search needs a free key: see [wyzie-tutorial.md](wyzie-tutorial.md), then paste it in Settings.

## License

GPL-3.0. See [LICENSE](LICENSE). Super Player is a modified version of an open-source GPL-3.0 project (modified 2026).

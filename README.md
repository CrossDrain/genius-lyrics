# Genius Lyrics

A [TidaLuna](https://github.com/Inrixia/TidaLuna) plugin that adds a native-feeling **Genius** tab to TIDAL's now-playing view, fetching the current track's lyrics from [Genius.com](https://genius.com).

## Features

- Adds a "Genius" tab alongside Lyrics/Credits/Similar Tracks in the now-playing panel
- Matches the currently playing track against Genius search results, verifying the artist to avoid picking translation/cover curator pages
- Strips Genius page chrome (contributor counts, translation lists, "Read More" blurbs) so only the lyrics render
- Visually distinguishes section headers (`[Verse 1]`, `[Chorus]`, ...) from lyric lines, and a long soft-wrapped line from an actual new line
- Highlights lyric fragments that have a Genius annotation — click one to read the explanation inline, right below that line, with a distinct badge for artist-verified annotations
- Adjustable lyrics font size (persisted), with a webfont that has better diacritic coverage than the system font stack
- Native TIDAL scrollbar styling (via OverlayScrollbars) instead of the browser default
- Optional: hide section headers, disable annotation highlighting, auto-refetch on track change

## Settings

Available under **Luna Settings → Genius Lyrics**:

- **Lyrics font size** — scale the lyrics text (50–200%)
- **Hide section headers** — remove `[Verse]`/`[Chorus]` markers from the fetched lyrics
- **Auto-refetch on track change** — automatically load lyrics for the next track while the Genius panel is open
- **Disable annotation highlighting** — don't highlight or make clickable the lyric fragments that have a Genius annotation

## Development

```sh
pnpm install
pnpm run watch
```

This builds the plugin and serves it (with hot reload) for installation via the **DEV** store in **Luna Settings → Plugin Store**.

The plugin source lives in [`plugins/GeniusLyrics`](./plugins/GeniusLyrics).

## Installing a built release

After a release build runs, install via:

```
https://github.com/CrossDrain/genius-lyrics/releases/download/latest/luna.genius-lyrics
```

Or add the store:

```
https://github.com/CrossDrain/genius-lyrics/releases/download/latest/store.json
```

---

Built on [Inrixia/luna-template](https://github.com/Inrixia/luna-template). For TidaLuna plugin development docs, see the [TidaLuna repo](https://github.com/Inrixia/TidaLuna).

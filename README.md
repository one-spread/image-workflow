# Image Workflow

An image-centric workflow plugin for Obsidian. Click images to enlarge with zoom, copy / download, and copy markdown selections so images paste inline into Gmail, Google Docs, Slack, etc.

## Features

- **Click to enlarge** — Click any image in your markdown notes to open it in a dark overlay
- **Mouse wheel zoom** — Scroll to zoom in/out with smart 100% snap
- **Copy / Download** — Copy image as PNG, save the original to disk, or copy the vault path
- **Annotate (Edit)** — Draw boxes, arrows, text and mosaics, or crop the image, with undo. PNG images are saved in place: the untouched original and the shapes are kept inside the file, so annotations stay editable and *Revert* restores the original exactly. Other formats are saved as `<name>-edited.png` with the note's embeds relinked
- **Copy for… (destination picker)** — Copy the selection (or the whole note) formatted for the place you paste it: Google Docs, Gmail, Slack, Google Chat, Chatwork, or plain text. Available from the command palette, the editor right-click menu, and any hotkey you assign
  - Google Docs / Gmail: rich HTML with images embedded as base64, highlights as background color, code blocks as a shaded single-cell table
  - Slack / Google Chat: rich text plus `*bold*` markup fallback; highlights become bold, tables become aligned code blocks
  - Chatwork: plain text with `[info]` / `[code]` / `[hr]` tags
  - Plain text: no markdown symbols; tables become tab-separated values
- **Smaller clipboard images** — Google Docs/Gmail images are resized to a maximum long edge of 1200 px without upscaling, with a total image-size notice. Transparency is retained.
- **Safe sharing copies** — Copy and rich-note copy remove private editing data. Saved editable PNGs retain the recoverable original; use Copy when sharing a mosaic or cropped image.
- **Smart paste-back** — Pasting a Google Docs / Gmail copy back into Obsidian inserts the original markdown (no base64 bloat)
- **Cmd/Ctrl+C stays plain markdown** — Automatic rich copy on Cmd/Ctrl+C is optional (off by default)
- **Easy dismiss** — Click the background or press `Escape` to close

## Installation

### From Obsidian Community Plugins

1. Open **Settings** → **Community plugins** → **Browse**
2. Search for **Image Workflow**
3. Install, then enable

### Via BRAT (beta installer)

While the plugin is awaiting community-plugin review, install with [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install the BRAT plugin from Community plugins
2. BRAT → "Add Beta plugin" → paste `one-spread/image-workflow`
3. Enable Image Workflow in **Settings** → **Community plugins**

### Manual

1. Download `main.js`, `styles.css`, and `manifest.json` from the [latest release](https://github.com/one-spread/image-workflow/releases/latest)
2. Create a folder `image-workflow` in your vault's `.obsidian/plugins/` directory
3. Copy the downloaded files into the folder
4. Reload Obsidian and enable the plugin in **Settings** → **Community plugins**

## Usage

| Action | Result |
|--------|--------|
| Click an image | Opens fullscreen overlay |
| Scroll wheel | Zoom in / out |
| `Cmd/Ctrl + C` (overlay) | Copy image to clipboard |
| Click "Copy" button | Copy image to clipboard |
| Click "Download" button / `Cmd/Ctrl + S` | Save image to disk |
| `Cmd/Ctrl + Shift + C` (overlay) | Copy image path to clipboard |
| Click "Edit" / `E` (overlay) | Open the annotation editor (Box / Arrow / Text / Mosaic / Crop, `Cmd/Ctrl + Z` undo, `Cmd/Ctrl + C` copy, `Cmd/Ctrl + S` save, *Revert* to restore the original) |
| Click background / `Escape` | Close overlay |
| Command / right-click: *Copy for…* | Pick a destination (Google Docs, Gmail, Slack, Google Chat, Chatwork, plain text). The last choice is listed first |
| Commands: *Copy for Google Docs / Gmail / Slack / Google Chat / Chatwork / Plain text* | Copy directly for that destination (assignable hotkeys) |

## Settings

- **Rich copy on Cmd/Ctrl+C** *(default: off)* — when enabled, Cmd/Ctrl+C on a selection with image embeds writes Google Docs-friendly HTML. When off, Cmd/Ctrl+C is Obsidian's standard markdown copy.
- **Format all markdown copies for Google apps** *(default: off)* — when enabled, every markdown selection copied with Cmd/Ctrl+C is written as Google Docs-friendly HTML, even if it has no images.
- **Preserve line breaks for Google paste** *(default: on)* — keeps soft line breaks inside paragraphs as visible line breaks when pasting into Google Docs, Gmail, and other Google editors. Plain markdown clipboard text is unchanged.

## Development

```bash
npm install
npm run check
npm test
npm run test:browser  # Chromium, or CHROME_PATH pointing to an installed Chrome
npm run build
```

The built `main.js` is output to the project root. Symlink the project directory into `.obsidian/plugins/image-workflow/` for live development.

## Compatibility

- **Desktop only** — Uses the Clipboard API (`ClipboardItem`), which requires Electron
- **Obsidian** ≥ 1.4.0

## Reporting issues

Please open an issue on [GitHub](https://github.com/one-spread/image-workflow/issues) with reproduction steps, your Obsidian version, and OS.

## License

[MIT](LICENSE)

# Track Day Checklist

A small static webpage that walks you through a pre-session and a post-session
checklist for a track day. Designed for the Tesla browser, but works in any
modern mobile or desktop browser.

- **Refresh** always returns to the **pre-session** checklist (clean reset).
- Tap each item to check it. When all pre-session items are checked, a big
  green **GO!** screen appears with an **I'm back** button.
- Tap **I'm back** after your session to load the **post-session** checklist.
- A **press-and-hold (3 seconds)** "skip to post-session" button at the bottom
  of the pre-session screen handles the case where the browser was refreshed
  mid-session.
- Edit either list inline by tapping the pencil icon. **Drag the ≡ handle** to
  reorder items.

Lists are stored in your browser's `localStorage`. No accounts, no servers, no
Google Cloud setup.

---

## Deploy to GitHub Pages

```sh
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin git@github.com:<your-username>/<repo>.git
git push -u origin main
```

In your repo on github.com → **Settings → Pages** → Source: **Deploy from a
branch** → Branch: **main**, folder **/ (root)** → **Save**.

After a minute the site is live at `https://<your-username>.github.io/<repo>/`.
Bookmark that URL in the Tesla browser.

## Local development

Plain static site. Any static file server works:

```sh
python3 -m http.server 8000
```

Open <http://localhost:8000>.

---

## How it's stored

All your lists live in this browser's `localStorage` under the key
`tcl_lists_v1`. The shape:

```json
{
  "pre":  ["Tire pressures set", "Helmet, gloves, HANS device", …],
  "post": ["Cool-down lap completed", "Tire pressures rechecked", …]
}
```

If you clear your browser's site data, your lists are gone — that's why the
**Settings → Export to file** button exists. Export gives you a
`track-checklist.json` file you can save anywhere; **Import** loads it back.

## Settings

Tap the gear icon (top-right) on any checklist screen:

- **Export to file** — downloads `track-checklist.json` with both lists.
- **Import from file** — restores lists from a previously-exported file.
- **Reset to example list** — wipes your lists and reloads a default HPDE
  example (3-second hold to confirm).

## Files

```
index.html   — single-page UI for all screens
styles.css   — mobile-first dark theme
app.js       — state, render, editor, export/import
```

Plus one external dependency loaded from CDN:
[SortableJS](https://github.com/SortableJS/Sortable) for drag-and-drop
reordering.

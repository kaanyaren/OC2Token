# Screenshots — generation & privacy notes

Regenerate with (coordinator-owned script; do not hand-edit the SVGs):

```sh
npm run build
node scripts/generate-screenshots.mjs
```

## ⚠️ PII baked into current assets (2026-09-03)

`scripts/generate-screenshots.mjs:36-53` builds its fixture with **real
absolute paths** (`/Users/kaanyaren/GitHub/OC2Token`,
`/Users/kaanyaren/GitHub/opencode`, `/Users/kaanyaren/work/client-app`).
Those strings are baked into every committed SVG under this directory
(`dashboard.svg`, `dashboard-projects.svg`, `dashboard-hour.svg`,
`dashboard-narrow.svg`, `table.svg`, …) and visible in the README gallery.

Additionally `scripts/generate-screenshots.mjs:384` titles the JSON card
`oc2token --json (schema v3)` and the embedded snippet shows
`"schemaVersion": 3` — both stale since the contract moved to **v4**
(`src/output/json.ts:13`). The SVGs cannot be fixed by editing docs alone;
they must be **regenerated**.

## Recommended fix (for the script owner)

- Replace fixture `project` values with synthetic, clearly-fake paths
  (e.g. `/demo/alpha`, `/demo/beta`, `~/demo/client-app`) so regeneration
  never emits a real username or client directory.
- Or point the fixture at a temp dir (`fs.mkdtempSync(os.tmpdir())`) and
  assert no output contains the real `$HOME` before writing.
- Bump the JSON card title/snippet to schema v4 (or derive the title from
  `JSON_SCHEMA_VERSION` so it cannot drift again).

Until then, treat these SVGs as containing the author's local layout and
avoid copying new real paths into the fixture.

![berg](berg.png)

Same-site crawler built on [tracker-radar-collector](https://github.com/duckduckgo/tracker-radar-collector)'s
crawler and collectors. Starts from a seed URL, follows same-site links up to a page budget, runs collectors on
every page, and writes per-page JSON plus a `site.json` summary/link graph.

## Setup

tracker-radar-collector is vendored as a git submodule at `radar/`.

```sh
git clone --recurse-submodules <this repo>
# or, in an existing clone:
git submodule update --init

npm install   # postinstall also runs `npm ci` inside radar/ against its own lockfile
```

radar's dependencies are installed in `radar/node_modules` rather than hoisted, because some collectors resolve
files via hardcoded `../node_modules/...` paths. berg code imports radar modules via the
[subpath import](https://nodejs.org/api/packages.html#subpath-imports) alias `#radar/*`, e.g.
`require('#radar/collectors/RequestCollector')`.

## Usage

```sh
npx berg --site https://example.com -b 100 -o data/example.com
```

Run `npx berg --help` for all options. Chromium is downloaded on first run into `radar/chromium/`.

## Development

```sh
npm test       # end-to-end test against a local HTTP server
npm run lint   # prettier
```

### Updating radar

```sh
git -C radar fetch && git -C radar checkout <ref>
npm install
git add radar && git commit -m "Bump radar to <ref>"
```

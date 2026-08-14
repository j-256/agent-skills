# Vendored dependencies

## `js-yaml.min.js`

The prebuilt minified bundle of [js-yaml](https://github.com/nodeca/js-yaml)
(v4.1.1, MIT – the license banner rides in the file), vendored so the shared
scrape library has zero npm dependencies and needs no `npm install` step. The
DSC skills are installed by symlinking a skill directory into
`~/.claude/skills/`, where an ordinary npm dependency would sit unresolved; the
bundle sidesteps that entirely.

Only the parser API (`load` / `dump`) is used, through
[`../scrape/load-yaml.js`](../scrape/load-yaml.js). The bundle is
self-contained: js-yaml's declared `argparse` dependency is used only by its
command-line `bin`, not the library, so nothing else is required at runtime.

### Updating

```bash
# from a scratch directory (keeps this repo dependency-free):
npm pack js-yaml@<version>            # or: npm install --no-save js-yaml@<version>
# then copy the dist bundle in:
cp <js-yaml>/dist/js-yaml.min.js skills/_shared/vendor/js-yaml.min.js
```

Bump the version noted above and in `scrape/load-yaml.js`, then run
`bash skills/_shared/tests/run.sh` (the `test-load-yaml` case proves the bundle
parses with the npm package unresolvable).

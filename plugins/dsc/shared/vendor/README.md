# Vendored dependencies

## `js-yaml.min.js`

The prebuilt minified bundle of [js-yaml](https://github.com/nodeca/js-yaml) (v4.1.1, MIT; the license banner remains in the file) is vendored so the shared scrape library has zero npm dependencies and needs no `npm install` step. The bundle keeps direct Agent Skill installs and cached plugin copies self-contained across clients.

Only the parser API (`load` / `dump`) is used through [`../scrape/load-yaml.js`](../scrape/load-yaml.js). The bundle is self-contained because js-yaml's declared `argparse` dependency is used only by its command-line entry point.

### Updating

From a scratch directory, fetch the requested js-yaml package and copy `dist/js-yaml.min.js` to `plugins/dsc/shared/vendor/js-yaml.min.js`. Then update the version above and run `bash plugins/dsc/shared/test/run.sh`; `test-load-yaml` verifies that the bundle works when the npm package is unavailable.

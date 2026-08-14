'use strict';

// js-yaml is vendored (see ../vendor/README.md) so the shared scrape library is
// zero-install: there is no npm dependency to resolve and no `npm install` step for
// users who symlink a skill into ~/.claude/skills/. The prebuilt bundle carries its
// own MIT license banner and is self-contained (js-yaml's argparse dependency is
// CLI-only and not bundled). Only the parser API is used.
const yaml = require('../vendor/js-yaml.min.js');

function load(str) {
  return yaml.load(str);
}

module.exports = { load };

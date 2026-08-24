'use strict';

// js-yaml is vendored so the shared scrape library stays zero-install across clients
// The prebuilt bundle carries its MIT license banner and uses only the parser API
const yaml = require('../vendor/js-yaml.min.js');

function load(str) {
  return yaml.load(str);
}

module.exports = { load };

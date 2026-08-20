#!/usr/bin/env node
'use strict';

const { main } = require('../../../shared/scrape/scrape.js');

main(process.argv).catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});

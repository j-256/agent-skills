#!/usr/bin/env node
'use strict';

const { pkceShellSnippet } = require('../lib/common/pkce.js');

process.stdout.write(`${pkceShellSnippet()}\n`);

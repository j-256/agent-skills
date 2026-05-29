#!/usr/bin/env node
'use strict';

const { pkceShellSnippet } = require('../lib/pkce.js');

process.stdout.write(`${pkceShellSnippet()}\n`);

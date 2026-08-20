#!/usr/bin/env node
'use strict';

const { pkceShellSnippet } = require('../../../shared/common/pkce.js');

process.stdout.write(`${pkceShellSnippet()}\n`);

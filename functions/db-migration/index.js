'use strict';

const migrator = require('./handler');

exports.handler = (event) => migrator.migrate(event);

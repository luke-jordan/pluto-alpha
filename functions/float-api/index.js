'use strict';

const impl = require('./handler');

exports.handler = async (event) => impl.accrue(event, null);

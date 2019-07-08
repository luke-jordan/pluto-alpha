'use strict';

const impl = require('./handler');

exports.handler = async (event) => impl.create(event, null);

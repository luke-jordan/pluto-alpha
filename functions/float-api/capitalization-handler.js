'use strict';

const logger = require('debug')('jupiter:float:capitalize');
const opsUtil = require('ops-util-common');

const dynamo = require('./persistence/dynamodb');
const rds = require('./persistence/rds');

const BigNumber = require('bignumber.js');

/**
 * Allows admin to review the operation before committing it. Conducts all the calculations and then returns the top level
 * results plus a sample of the transactions
 */
module.exports.preview = async (params) => {

};

module.exports.confirm = async (params) => {

};

module.exports.handle = async (event) => {

};
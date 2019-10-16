'use strict';

const logger = require('debug')('jupiter:save:payment');
const config = require('config');

const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });

module.exports.getPaymentLink = async ({ tranasctionId, accountRef, amountDict }) => {
    logger('Received params: ', tranasctionId, accountRef, amountDict);
};

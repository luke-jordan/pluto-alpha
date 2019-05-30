'use strict';

const config = require('config');
const logger = require('debug')('pluto:auth:dynamo');

const dynamoCommon = require('dynamo-common')

module.exports.getPolicy =  async (policyName, systemWideUserId) => {
    const dynamoDbResult = await dynamoCommon.fetchSingleRow(config.get('tables.dynamoAuthPoliciesTable'), {policy_id: policyName});
    dynamoDbResult.systemWideUserId = systemWideUserId;
    logger('Got this back from dynamod policy get call:', dynamoDbResult);
    return dynamoDbResult;
};
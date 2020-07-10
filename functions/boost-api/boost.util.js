'use strict';

const config = require('config');
// const logger = require('debug')('jupiter:message:util');

const allowedCors = config.has('headers.CORS') ? config.get('headers.CORS') : '*';
const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowedCors
};

module.exports.ACTIVE_BOOST_STATUS = ['CREATED', 'OFFERED', 'UNLOCKED', 'PENDING'];
module.exports.COMPLETE_BOOST_STATUS = ['REDEEMED', 'REVOKED', 'FAILED', 'EXPIRED'];

// note: keep an eye on sort order of final statusses, but at present this seems right
module.exports.ALL_BOOST_STATUS_SORTED = ['CREATED', 'OFFERED', 'UNLOCKED', 'PENDING', 'REDEEMED', 'REVOKED', 'EXPIRED'];

module.exports.extractUserDetails = (event) => (event.requestContext ? event.requestContext.authorizer : null);

module.exports.extractEventBody = (event) => (event.body ? JSON.parse(event.body) : event);

module.exports.extractBoostIds = (boosts) => boosts.map((boost) => boost.boostId);

module.exports.statusSorter = (status1, status2) => exports.ALL_BOOST_STATUS_SORTED.indexOf(status2) - exports.ALL_BOOST_STATUS_SORTED.indexOf(status1);

module.exports.hasConditionType = (statusConditions, status, conditionType) => Array.isArray(statusConditions[status]) &&
    statusConditions[status].some((condition) => condition.startsWith(conditionType));

module.exports.extractQueryParams = (event) => {
    // logger('Event query string params: ', event.queryStringParameters);
    if (typeof event.queryStringParameters === 'object' && event.queryStringParameters !== null) {
        return event.queryStringParameters;
    } 
    return event;
};

module.exports.isUserAuthorized = (userDetails, requiredRole = 'SYSTEM_ADMIN') => {
    if (!userDetails || !Reflect.has(userDetails, 'systemWideUserId')) {
        return false;
    }

    return userDetails.role === requiredRole;
};

module.exports.wrapHttpResponse = (body, statusCode = 200) => ({
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(body)
});

module.exports.unauthorizedResponse = {
    statusCode: 403,
    headers: corsHeaders
};

module.exports.errorResponse = (err) => ({
    statusCode: 500,
    headers: corsHeaders,
    body: JSON.stringify(err.message)
});

module.exports.constructBoostContext = (boost) => ({
    boostId: boost.boostId,
    boostType: boost.boostType,
    boostCategory: boost.boostCategory,

    boostStartTime: boost.boostStartTime.valueOf(),
    boostEndTime: boost.boostEndTime.valueOf(),

    // some extra context, to seed ML properly
    statusConditions: boost.statusConditions,
    rewardParameters: boost.rewardParameters,
    gameParams: boost.gameParams,
    
    boostAmount: boost.boostAmount,
    boostUnit: boost.boostUnit,
    boostCurrency: boost.boostCurrency
});

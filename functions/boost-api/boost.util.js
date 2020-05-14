'use strict';

const config = require('config');
// const logger = require('debug')('jupiter:message:util');

const allowedCors = config.has('headers.CORS') ? config.get('headers.CORS') : '*';
const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowedCors
};

module.exports.ACTIVE_BOOST_STATUS = ['CREATED', 'OFFERED', 'UNLOCKED', 'PENDING'];

// note: keep an eye on sort order of final statusses, but at present this seems right
module.exports.ALL_BOOST_STATUS_SORTED = ['CREATED', 'OFFERED', 'UNLOCKED', 'PENDING', 'REDEEMED', 'REVOKED', 'EXPIRED'];

module.exports.EVENT_TYPE_CONDITION_MAP = {
    'SAVING_PAYMENT_SUCCESSFUL': ['save_event_greater_than', 'save_completed_by', 'first_save_by', 'first_save_above'],
    'WITHDRAWAL_EVENT_CONFIRMED': ['balance_below', 'withdrawal_before'],
    'USER_GAME_COMPLETION': ['number_taps_greater_than', 'percent_destroyed_above'],
    'BOOST_EXPIRED': ['number_taps_in_first_N'],
    'FRIEND_REQUEST_INITIATED_ACCEPTED': ['friends_added_since', 'total_number_friends'],
    'FRIEND_REQUEST_TARGET_ACCEPTED': ['friends_added_since', 'total_number_friends']
};

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


'use strict';

// todo : this could use a clean up - for generic functions, swap callers to using ops util, and for others, tidy and do a 
// bulk module.exports = { } at the end

const config = require('config');
const logger = require('debug')('jupiter:boost:util');
const stringify = require('json-stable-stringify');

const allowedCors = config.has('headers.CORS') ? config.get('headers.CORS') : '*';
const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowedCors
};

module.exports.ACTIVE_BOOST_STATUS = ['CREATED', 'OFFERED', 'UNLOCKED', 'PENDING'];
module.exports.COMPLETE_BOOST_STATUS = ['REDEEMED', 'REVOKED', 'FAILED', 'EXPIRED'];

// note: keep an eye on sort order of final statusses, but at present this seems right
module.exports.ALL_BOOST_STATUS_SORTED = ['CREATED', 'OFFERED', 'UNLOCKED', 'PENDING', 'REDEEMED', 'REVOKED', 'EXPIRED', 'FAILED'];

module.exports.extractUserDetails = (event) => (event.requestContext ? event.requestContext.authorizer : null);

module.exports.extractEventBody = (event) => (event.body ? JSON.parse(event.body) : event);

module.exports.extractBoostIds = (boosts) => boosts.map((boost) => boost.boostId);

module.exports.statusSorter = (status1, status2) => exports.ALL_BOOST_STATUS_SORTED.indexOf(status2) - exports.ALL_BOOST_STATUS_SORTED.indexOf(status1);

// these are time-based in the sense that they are triggered or not based on a sequence of events within a given time
const timeBasedConditions = ['event_does_follow', 'event_does_not_follow'];
    
// two helper filters to try make this easier to maintain/follow
module.exports.conditionIsTimeBased = (condition) => timeBasedConditions.some((timeBasedCondition) => condition.startsWith(timeBasedCondition));
module.exports.oneConditionTimeBased = (conditions) => conditions.some((condition) => exports.conditionIsTimeBased(condition));

module.exports.hasTimeBasedConditions = (boost) => {
    const { statusConditions } = boost;
    return Object.values(statusConditions).some((conditions) => exports.oneConditionTimeBased(conditions));
};

module.exports.extractSequenceAndIntervalFromCondition = (condition) => {
    const parameterMatch = condition.match(/#{(.*)}/);
    const [firstEvent, secondEvent, timeAmount, timeUnit] = parameterMatch[1].split('::');
    const parameters = { firstEvent, secondEvent, timeAmount, timeUnit };
    // logger('From parameter string: ', parameterMatch[1], ' extracted: ', parameters);
    return parameters;
};

const extractEvents = (condition) => {
    const { firstEvent, secondEvent } = exports.extractSequenceAndIntervalFromCondition(condition);
    return [firstEvent, secondEvent];
};

const extractEventsFromConditions = (conditions) => conditions.filter(exports.conditionIsTimeBased).map(extractEvents).
    reduce((allList, thisList) => [...allList, ...thisList], []);

module.exports.extractEventsInSequenceConditions = (boost) => {
    const { statusConditions } = boost;
    const sequenceDependentStatusses = Object.keys(statusConditions).filter((status) => exports.oneConditionTimeBased(statusConditions[status]));
    logger('Processing boost, sequence dependent statusses; ', sequenceDependentStatusses);

    // as in general, three levels of lists to untangle here: statusses, then conditions, then events within condition
    const eventsToObtainRaw = sequenceDependentStatusses.map((status) => extractEventsFromConditions(statusConditions[status]));
    logger('Raw events to obtain: ', eventsToObtainRaw);
    const eventsToObtain = [...new Set(eventsToObtainRaw.reduce((allList, thisList) => [...allList, ...thisList]))];
    logger('Deduped: ', eventsToObtain);
    
    return eventsToObtain;
};

// for event logging, data pipeline, etc
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

// GENERIC STUFF, SHOULD AT SOME POINT SWITCH TO USING BOOST

module.exports.isBoostTournament = (boost) => boost.boostType === 'GAME' && boost.statusConditions.REDEEMED && 
    boost.statusConditions.REDEEMED.some((condition) => condition.startsWith('number_taps_in_first_N') || condition.startsWith('percent_destroyed_in_first_N'));

module.exports.isRandomAward = (boost) => boost.statusConditions.REDEEMED && boost.statusConditions.REDEEMED.some((condition) => condition.startsWith('randomly_chosen_first_N'));

module.exports.hasConditionType = (statusConditions, status, conditionType) => Array.isArray(statusConditions[status]) &&
    statusConditions[status].some((condition) => condition.startsWith(conditionType));

// this is a slightly clearer version of ops util one
module.exports.lambdaParameters = (payload, nameKey, sync = true) => ({
    FunctionName: config.get(`lambdas.${nameKey}`),
    InvocationType: sync ? 'RequestResponse' : 'Event',
    Payload: stringify(payload)
});

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

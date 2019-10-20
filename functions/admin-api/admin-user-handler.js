'use strict';

const logger = require('debug')('pluto:admin:rds');
const config = require('config');
const moment = require('moment');
const status = require('statuses');

const persistence = require('./persistence/rds.analytics');
const adminUtil = require('./admin.util');
const opsCommonUtil = require('ops-util-common');

const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });

const lambda = new AWS.Lambda();

const extractLambdaBody = (lambdaResult) => JSON.parse(JSON.parse(lambdaResult['Payload']).body);

/**
 * Gets the user counts for the front page, usign a mix of parameters. Leaving out a parameter will invoke a default
 * @param {object} event An event containing the request context and the request body. The body's properties a decribed below.
 * @property {string} startTimeMillis If left out, default is set by config but will generally be six months ago
 * @property {string} endTimeMillis If left out, default is set to now
 * @property {boolean} includeNewButNoSave determines whether to include in the count accounts that were created in the time window but have not yet had a settled save transaction. This can be useful for diagnosing drop outs
 */
module.exports.fetchUserCounts = async (event) => {
    if (!adminUtil.isUserAuthorized(event)) {
        return adminUtil.unauthorizedResponse;
    }

    const params = opsCommonUtil.extractQueryParams(event);
    logger('Finding user Ids with params: ', params);

    const defaultDaysBack = config.get('defaults.userCounts.daysBack');

    logger(`Do we have a start time millis ? : ${Reflect.has(params, 'startTimeMillis')}, and it is : ${params.startTimeMillis}`);

    const startTime = Reflect.has(params, 'startTimeMillis') ? moment(parseInt(params.startTimeMillis, 10)) : moment().subtract(defaultDaysBack, 'days');
    const endTime = Reflect.has(params, 'endTimeMillis') ? moment(parseInt(params.endTimeMillis, 10)) : moment();
    const includeNoTxAccountsCreatedInWindow = typeof params.includeNewButNoSave === 'boolean' && params.includeNewButNoSave;

    const userIdCount = await persistence.countUserIdsWithAccounts(startTime, endTime, includeNoTxAccountsCreatedInWindow);

    logger('Obtained user count: ', userIdCount);

    return adminUtil.wrapHttpResponse({ userCount: userIdCount });
};

/**
 * Function for looking up a user and returning basic data about them
 * @param {object} event An event object containing the request context and query paramaters specifying the search to make
 * @property {object} requestContext As in method above (contains context, from auth, etc)
 * @property {object} queryStringParamaters Contains one of nationalId & country code, phone number, and email address
 */
module.exports.lookUpUser = async (event) => {
    try {
        if (!adminUtil.isUserAuthorized(event)) {
            return adminUtil.unauthorizedResponse;
        }

        const lookUpPayload = opsCommonUtil.extractQueryParams(event);
        const lookUpInvoke = adminUtil.invokeLambda(config.get('lambdas.systemWideIdLookup'), lookUpPayload);

        logger('Invoking system wide user ID lookup with params: ', lookUpInvoke);
        const systemWideIdResult = await lambda.invoke(lookUpInvoke).promise();
        const systemIdPayload = JSON.parse(systemWideIdResult['Payload']);

        if (systemIdPayload.statusCode !== 200) {
            return opsCommonUtil.wrapResponse({ result: 'USER_NOT_FOUND' }, status('Not Found'));
        }

        const { systemWideUserId } = JSON.parse(systemIdPayload.body);
        logger(`From query params: ${JSON.stringify(lookUpPayload)}, got system ID: ${systemWideUserId}`);

        const profileFetchLambdaInvoke = adminUtil.invokeLambda(config.get('lambdas.fetchProfile'), { systemWideUserId });
        const profileFetchResult = await lambda.invoke(profileFetchLambdaInvoke).promise();
        logger('Result of profile fetch: ', profileFetchResult);

        const userProfile = extractLambdaBody(profileFetchResult);

        const balancePayload = {
            userId: systemWideUserId,
            currency: userProfile.defaultCurrency,
            atEpochMillis: moment().valueOf(),
            timezone: userProfile.defaultTimezone, 
            clientId: userProfile.clientId,
            daysToProject: 0
        };

        const balanceLambdaInvocation = adminUtil.invokeLambda(config.get('lambdas.fetchUserBalance'), balancePayload);

        const userBalanceResult = await lambda.invoke(balanceLambdaInvocation).promise();
        const userBalance = extractLambdaBody(userBalanceResult);

        const resultObject = { ...userProfile, userBalance };
        logger('Returning: ', resultObject);

        return opsCommonUtil.wrapResponse(resultObject);

    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return opsCommonUtil.wrapResponse(err.message, 500);
    }
};

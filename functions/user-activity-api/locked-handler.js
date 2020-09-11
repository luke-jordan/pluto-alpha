'use strict';

const logger = require('debug')('jupiter:locked-saves:main');
const config = require('config');
const moment = require('moment');

const interestHelper = require('./interest-helper');

const opsUtil = require('ops-util-common');
const dynamo = require('./persistence/dynamodb');

const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });

const lambda = new AWS.Lambda();

const extractLambdaBody = (lambdaResult) => JSON.parse(JSON.parse(lambdaResult['Payload']).body);

const wrapLambdaInvoc = (functionName, async, payload) => ({
    FunctionName: functionName,
    InvocationType: async ? 'Event' : 'RequestResponse',
    Payload: JSON.stringify(payload)
});

const fetchUserProfile = async (systemWideUserId) => {
    const profileFetchLambdaInvoke = wrapLambdaInvoc(config.get('lambdas.fetchProfile'), { systemWideUserId });
    const profileFetchResult = await lambda.invoke(profileFetchLambdaInvoke).promise();
    logger('Result of profile fetch: ', profileFetchResult);

    return extractLambdaBody(profileFetchResult);
};

const obtainUserBalance = async (userProfile) => {
    const balancePayload = {
        userId: userProfile.systemWideUserId,
        currency: userProfile.defaultCurrency,
        atEpochMillis: moment().valueOf(),
        timezone: userProfile.defaultTimezone,
        clientId: userProfile.clientId,
        daysToProject: 0
    };

    logger('Balance payload: ', balancePayload);
    const balanceLambdaInvocation = wrapLambdaInvoc(config.get('lambdas.fetchUserBalance'), balancePayload);

    const userBalanceResult = await lambda.invoke(balanceLambdaInvocation).promise();
    return extractLambdaBody(userBalanceResult);
};

/**
 * 
 * @param {object} event 
 * @property {string} floatId
 * @property {string} clientId
 * @property {array} daysToPreview
 */
module.exports.previewBonus = async (event) => {
    try {
        if (opsUtil.isObjectEmpty(event)) {
            return { statusCode: 400, body: 'Empty invocation' };
        }

        const userDetails = event.requestContext ? event.requestContext.authorizer : null;
        if (!userDetails || !Reflect.has(userDetails, 'systemWideUserId')) {
            return { statusCode: 403 };
        }

        const systemWideUserId = userDetails.systemWideUserId;

        const { clientId, floatId, daysToPreview } = opsUtil.extractParamsFromEvent(event);
        logger('Previewing locked save bonus for client id: ', clientId, ' and float id: ', floatId);

        const userProfile = await fetchUserProfile(systemWideUserId);
        logger('Got user profile: ', userProfile);

        const floatProjectionVars = await dynamo.fetchFloatVarsForBalanceCalc(clientId, floatId);
        logger('Got client-float vars: ', floatProjectionVars);

        const { accrualRateAnnualBps, lockedSaveBonus } = floatProjectionVars;
        const lockedSaveInterestMap = daysToPreview.map((days) => ({ [days]: lockedSaveBonus[days] * accrualRateAnnualBps }));
        logger('Mapped days to preview to corresponding multipliers: ', lockedSaveInterestMap);

        const { currentBalance } = await obtainUserBalance(userProfile);
        logger('Got user balance: ', currentBalance);

        const calculatedLockedSaveBonus = lockedSaveInterestMap.map((daysAndInterest) => {
            const interestRate = Object.values(daysAndInterest)[0];
            const daysToCalculate = Object.keys(daysAndInterest)[0];
            const calculatedInterestEarned = interestHelper.calculateEstimatedInterestEarned({ ...currentBalance, daysToCalculate }, 'HUNDREDTH_CENT', interestRate);
            return { [daysToCalculate]: calculatedInterestEarned };
        });

        // todo; reduce to single object

        logger('Returning final result: ', calculatedLockedSaveBonus);
        return opsUtil.wrapResponse(calculatedLockedSaveBonus);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};

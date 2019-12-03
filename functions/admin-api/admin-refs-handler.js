'use strict';

const logger = require('debug')('jupiter:admin:refs');
const config = require('config');

const dynamo = require('./persistence/dynamo.float');

const opsCommonUtil = require('ops-util-common');
const adminUtil = require('./admin.util');

const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });
const lambda = new AWS.Lambda();

const otpNeededStatusCode = 401;
const referralNotFoundCode = 404;
const referralNotAvailableCode = 409;

const validateInterval = (intervalKey, intervalValue) => {
    if (isNaN(intervalKey) || isNaN(intervalValue)) {
        return false;
    }

    const keyNumber = parseInt(intervalKey, 10);
    if (keyNumber < 0 || !Number.isInteger(keyNumber)) {
        return false;
    }

    return true;
};

const validateComparatorDef = (comparator, ratesMap) => {
    const testMap = { ...ratesMap };
    Reflect.deleteProperty(testMap, 'label'); // optional property; aside from it, all keys must be valid positive integers

    const intervalFailures = Object.entries(testMap).filter(([key, value]) => !validateInterval(key, value));
    logger('Interval failures: ', intervalFailures);

    if (intervalFailures.length > 0) {
        return { comparator, validated: false, failures: intervalFailures.map((failure) => `${failure[0]}: ${failure[1]}`).join(', ') };
    }

    return { comparator, validated: true };
};

const validateReferenceRates = (params) => {
    if (!Reflect.has(params, 'clientId') || !Reflect.has(params, 'floatId')) {
        return { validated: false, reason: 'Must include float ID and client ID' };
    }
    
    const ratesMap = params.comparatorRates;
    if (!Reflect.has(ratesMap, 'intervalUnit') || !Reflect.has(ratesMap, 'rateUnit')) {
        return { validated: false, reason: 'Must specify units for intervals and rates' };
    }

    const newRates = ratesMap.rates;
    if (opsCommonUtil.isObjectEmpty(newRates)) {
        return { validated: false, reason: 'Must contain a map of comparison rates'};
    }

    const rateFailures = Object.keys(newRates).
        map((comparator) => validateComparatorDef(comparator, newRates[comparator])).
        filter((result) => !result.validated);
    
    logger('Found rate failures? : ', rateFailures);
    
    if (rateFailures.length > 0) {
        const reason = rateFailures.map((failure) => `Error for ${failure.comparator}, error entries: ${failure.failures}`).join('; ');
        return { validated: false, reason };
    }

    return { validated: true };
};

module.exports.setFloatReferenceRates = async (event) => {
    try {
        if (!adminUtil.isUserAuthorized(event)) {
            return adminUtil.unauthorizedResponse;
        }

        const params = opsCommonUtil.extractParamsFromEvent(event);
        const { validated, reason } = validateReferenceRates(params);

        if (!validated) {
            const invalidStatusCode = 400;
            return opsCommonUtil.wrapResponse(reason, invalidStatusCode);
        }

        const adminUserId = event.requestContext.authorizer.systemWideUserId;
        const adminPassedOtp = await dynamo.verifyOtpPassed(adminUserId);

        if (!adminPassedOtp) {
            return opsCommonUtil.wrapResponse({ result: 'OTP_NEEDED' }, otpNeededStatusCode);
        }

        const { clientId, floatId } = params;
        const mapToStore = params.comparatorRates;

        const resultOfUpdate = await dynamo.updateClientFloatVars({ clientId, floatId, newComparatorMap: mapToStore});
        logger('Result of updating reference map: ', resultOfUpdate);

        if (resultOfUpdate.result === 'SUCCESS') {
            return adminUtil.codeOnlyResponse();
        }

        throw new Error('Failure in updating dynamo, or some other unspecified error');

    } catch (err) {
        return opsCommonUtil.wrapResponse(err.message, 500);
    }
};

// ///////////////////////////////////////////////////////////////////////////////////////////////////
// ///////////////////////////// REFERRAL CODES //////////////////////////////////////////////////////
// ///////////////////////////////////////////////////////////////////////////////////////////////////

const condenseBonusAmount = (bonusAmount) => `${bonusAmount.amount}::${bonusAmount.unit}::${bonusAmount.currency}`;

const listReferralCodes = async (event) => {
    const { clientId, floatId } = event.queryStringParameters;
    logger('Looking up codes for clientId: ', clientId, ' and floatId: ', floatId);
    const resultOfList = await dynamo.listReferralCodes(clientId, floatId);
    logger('From Dynamo: ', resultOfList);
    return resultOfList;
};

const createReferralCode = async (event) => {
    const params = opsCommonUtil.extractParamsFromEvent(event);
    logger('Creating referral code with params: ', params);

    const { clientId, floatId } = params;
    const countryCode = await dynamo.findCountryForClientFloat(clientId, floatId);

    const { systemWideUserId } = opsCommonUtil.extractUserDetails(event);
    
    const assembledAmount = condenseBonusAmount(params.bonusAmount);

    const createPayload = {
        referralCode: params.referralCode,
        codeType: params.codeType,
        creatingUserId: systemWideUserId,
        countryCode,
        clientId,
        floatId,
        referralContext: {
            boostAmountOffered: assembledAmount,
            bonusPoolId: params.bonusSource
        }
    };

    const lambdaInvocation = adminUtil.invokeLambda(config.get('lambdas.createReferralCode'), createPayload, true);
    const resultOfCreate = await lambda.invoke(lambdaInvocation).promise();
    
    logger('Received from create lambda: ', resultOfCreate);
    if (resultOfCreate['StatusCode'] !== 200) {
        throw new Error(resultOfCreate['Payload']);
    }

    const { persistedTimeMillis } = JSON.parse(resultOfCreate['Payload']);
    const updatedCodes = await dynamo.listReferralCodes(clientId, floatId);

    await dynamo.putAdminLog(systemWideUserId, 'REFERRAL_CODE_CREATED', params);

    return {
        result: 'SUCCESS',
        persistedTimeMillis,
        updatedCodes
    };
};

const deactivateCode = async (event) => {
    const params = opsCommonUtil.extractParamsFromEvent(event);
    logger('Deactivating referral code, params: ', params);

    const { systemWideUserId } = opsCommonUtil.extractUserDetails(event);

    const modifyPayload = {
        operation: 'DEACTIVATE',
        referralCode: params.referralCode,
        clientId: params.clientId,
        floatId: params.floatId,
        initiator: systemWideUserId
    };

    const lambdaInvocation = adminUtil.invokeLambda(config.get('lambdas.modifyReferralCode'), modifyPayload, true);
    const resultOfOff = await lambda.invoke(lambdaInvocation).promise();
    logger('Result of turning off: ', resultOfOff);

    if (resultOfOff['StatusCode'] !== 200) {
        throw new Error(resultOfOff['Payload']);
    }

    const { updatedTimeMillis } = JSON.parse(resultOfOff['Payload']);
    const updatedCodes = await dynamo.listReferralCodes(params.clientId, params.floatId);

    await dynamo.putAdminLog(systemWideUserId, 'REFERRAL_CODE_DEACTIVATED', params);

    return {
        result: 'DEACTIVATED',
        updatedTimeMillis,
        updatedCodes
    };
};

const modifyCode = async (event) => {
    const params = opsCommonUtil.extractParamsFromEvent(event);
    logger('Updating referral code: ', params);

    const { referralCode, clientId, floatId } = params;
    const { systemWideUserId } = opsCommonUtil.extractUserDetails(event);

    const modifyPayload = {
        operation: 'UPDATE',
        referralCode,
        clientId,
        floatId,
        initiator: systemWideUserId,
        newContext: { }
    };

    if (params.bonusAmount) {
        modifyPayload.newContext.boostAmountOffered = condenseBonusAmount(params.bonusAmount);
    }

    if (params.bonusSource) {
        modifyPayload.newContext.bonusPoolId = params.bonusSource;
    }

    if (params.tags) {
        modifyPayload.tags = params.tags;
    }

    const lambdaInvocation = adminUtil.invokeLambda(config.get('lambdas.modifyReferralCode'), modifyPayload, true);
    const resultOfUpdate = await lambda.invoke(lambdaInvocation).promise();
    
    if (resultOfUpdate['StatusCode'] !== 200) {
        throw new Error(resultOfUpdate['Payload']);
    }

    const { updatedTimeMillis } = JSON.parse(resultOfUpdate['Payload']);
    
    await dynamo.putAdminLog(systemWideUserId, 'REFERRAL_CODE_MODIFIED', params);

    return {
        result: 'UPDATED',
        updatedTimeMillis
    };
 
};

const validateCode = async (event) => {
    const { clientId, floatId, referralCode } = event.queryStringParameters;
    const countryCode = await dynamo.findCountryForClientFloat(clientId, floatId);
    logger('Country code for client-float: ', countryCode);
    
    const lambdaInvocation = adminUtil.invokeLambda(config.get('lambdas.verifyReferralCode'), { countryCode, referralCode }, true);
    
    logger('Sending Lambda invocation: ', lambdaInvocation);
    const resultOfCheck = await lambda.invoke(lambdaInvocation).promise();

    const resultCode = JSON.parse(resultOfCheck['Payload']).statusCode;
    
    // note: we flip here; if verify returns 200, the code exists, otherwise it doesn't
    return resultCode === referralNotFoundCode;
};

const dispatcher = {
    'list': (event) => listReferralCodes(event),
    'create': (event) => createReferralCode(event),
    'deactivate': (event) => deactivateCode(event),
    'update': (event) => modifyCode(event)
};

/**
 * Operations: CREATE, MODIFY, DEACTIVATE, LIST
 */
module.exports.manageReferralCodes = async (event) => {
    try {
        logger('Event: ', event);
        if (!adminUtil.isUserAuthorized(event)) {
            return adminUtil.unauthorizedResponse;
        }

        const operation = event.pathParameters.proxy;

        const adminUserId = event.requestContext.authorizer.systemWideUserId;
        const adminPassedOtp = await operation === 'LIST' || dynamo.verifyOtpPassed(adminUserId);

        if (!adminPassedOtp) {
            return opsCommonUtil.wrapResponse({ result: 'OTP_NEEDED' }, otpNeededStatusCode);
        }

        if (Object.keys(dispatcher).includes(operation)) {
            const resultOfOperation = await dispatcher[operation](event);
            return adminUtil.wrapHttpResponse(resultOfOperation);
        }

        if (operation === 'available') {
            const isCodeAvailable = await validateCode(event);
            logger('Result of code availability check: ', isCodeAvailable);
            return adminUtil.codeOnlyResponse(isCodeAvailable ? 200 : referralNotAvailableCode);
        }

        throw new Error('Referral management reached end of method without completing');

    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return opsCommonUtil.wrapResponse(err.message, 500);
    }
};

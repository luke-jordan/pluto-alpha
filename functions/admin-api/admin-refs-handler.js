'use strict';

const logger = require('debug')('jupiter:admin:refs');

const dynamo = require('./persistence/dynamo.float');

const opsCommonUtil = require('ops-util-common');
const adminUtil = require('./admin.util');

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

    if (!Reflect.has(params, 'intervalUnit') || !Reflect.has(params, 'rateUnit')) {
        return { validated: false, reason: 'Must specify units for intervals and rates' };
    }

    const ratesMap = params.comparisonRates;
    if (opsCommonUtil.isObjectEmpty(ratesMap)) {
        return { validated: false, reason: 'Must contain a map of comparison rates'};
    }

    const rateFailures = Object.keys(ratesMap).
        map((comparator) => validateComparatorDef(comparator, ratesMap[comparator])).
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
            return { statusCode: 400, body: JSON.stringify(reason) };
        }

        const adminUserId = event.requestContext.authorizer.systemWideUserId;
        const adminPassedOtp = await dynamo.verifyOtpPassed(adminUserId);

        if (!adminPassedOtp) {
            return { statusCode: 401, body: JSON.stringify({ result: 'OTP_NEEDED' }) };
        }

        const { clientId, floatId } = params;
        const mapToStore = { 
            intervalUnit: params.intervalUnit,
            rateUnit: params.rateUnit,
            comparisonRates: params.comparisonRates
        };

        const resultOfUpdate = await dynamo.updateClientFloatVars({ clientId, floatId, newComparatorMap: mapToStore});
        logger('Result of updating reference map: ', resultOfUpdate);

        if (resultOfUpdate.result === 'SUCCESS') {
            return { statusCode: 200 };
        }

        throw new Error('Failure in updating dynamo, or some other unspecified error');

    } catch (err) {
        return opsCommonUtil.wrapResponse(err.message, 500);
    }
};

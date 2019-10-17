'use strict';

const logger = require('debug')('jupiter:save:payment');
const config = require('config');
const moment = require('moment');

const opsUtil = require('ops-util-common');

const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });

const lambda = new AWS.Lambda();

const MAX_LENGTH_REF = 19; // actually 20, but just in case
const PREF_COUNT_LENGTH = 5; // i.e., for space up to 10,000 saves (!)

// will almost certainly move this lookup into payments lambda itself when handling multiple, hency a little hacky now

const CURRENCY_COUNTRY_LOOKUP = {
    'USD': 'US',
    'ZAR': 'ZA'
};

module.exports.warmUpPayment = async () => {
    const invocation = {
        FunctionName: config.get('lambdas.paymentUrlGet'),
        InvocationType: 'Event',
        Payload: JSON.stringify({})
    };

    const warmupResponse = await lambda.invoke(invocation).promise();
    logger('Result of warmup: ', warmupResponse);
    return { result: 'TRIGGERED' };
};

// exporting this so we can test it thoroughly (small trade off)
module.exports.generateBankRef = (accountInfo) => {
    const countPart = String(accountInfo.priorSaveCount);
    const refStem = accountInfo.bankRefStem;

    const charsLeft = MAX_LENGTH_REF - refStem.length - countPart.length;
    const preferredPad = PREF_COUNT_LENGTH - countPart.length;

    logger(`Characters left: ${charsLeft}, and preferred pad length: ${preferredPad}`);

    let expectedBankRef = refStem;
    if (preferredPad <= charsLeft) {
        expectedBankRef = `${refStem}-${countPart.padStart(PREF_COUNT_LENGTH, '0')}`;
    } else if (charsLeft >= 0) {
        const countLength = countPart.length + charsLeft;
        expectedBankRef = `${refStem}-${countPart.padStart(countLength, '0')}`;
    } else {
        logger('Well this is a problem. Remove the first non-digit character?');
    }

    return expectedBankRef;
};

module.exports.getPaymentLink = async ({ transactionId, accountInfo, amountDict }) => {
    logger('Received params: ', transactionId, accountInfo, amountDict);

    const bankReference = exports.generateBankRef(accountInfo);
    logger('Generated bank ref: ', bankReference);

    const wholeCurrencyAmount = opsUtil.convertToUnit(amountDict.amount, amountDict.unit, 'WHOLE_CURRENCY');
    
    const payload = {
        transactionId,
        bankReference,
        countryCode: CURRENCY_COUNTRY_LOOKUP[amountDict.currency],
        currencyCode: amountDict.currency,
        amount: wholeCurrencyAmount,
        isTest: true
    };

    const urlInvocation = {
        FunctionName: config.get('lambdas.paymentUrlGet'),
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify(payload)
    };

    const paymentUrlResponse = await lambda.invoke(urlInvocation).promise();
    logger('Result of payment url: ', paymentUrlResponse);

    return paymentUrlResponse['Payload'];
};

module.exports.checkPayment = async ({ transactionId }) => {
    logger('Checking payment status on transaction : ', transactionId);

    const statusInvocation = {
        FunctionName: config.get('lambdas.paymentStatusCheck'),
        InvocationType: 'RequestResponse',  
        Payload: JSON.stringify({ transactionId, isTest: true })
    };

    const paymentStatusResult = await lambda.invoke(statusInvocation).promise();
    
    logger('Result of invocation: ', paymentStatusResult);
    
    let returnResult = { };
    if (paymentStatusResult['StatusCode'] === 200 && paymentStatusResult['Payload']['result'] === 'COMPLETED') {
        const payload = paymentStatusResult['Payload'];
        returnResult = {
            paymentStatus: 'SETTLED',
            createdDate: payload.createdDate ? moment(payload.createdDate) : moment(),
            paymentDate: payload.paymentDate ? moment(payload.paymentDate) : moment()
        };
    } else if (paymentStatusResult['StatusCode'] === 200) {
        // todo : handle cancellation, etc
        returnResult = { paymentStatus: 'PENDING' };
    }

    return returnResult;
};
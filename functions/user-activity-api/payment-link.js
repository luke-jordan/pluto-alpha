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

module.exports.warmUpPayment = async (type) => {
    const functionName = type && type === 'TRIGGER_CHECK' ? config.get('lambdas.checkSavePayment') : config.get('lambdas.paymentUrlGet');
    const invocation = {
        FunctionName: functionName,
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

    const numberCharsRemaining = MAX_LENGTH_REF - refStem.length - countPart.length;
    const preferredPad = PREF_COUNT_LENGTH - countPart.length;

    logger(`Characters left: ${numberCharsRemaining}, and preferred pad length: ${preferredPad}`);

    let expectedBankRef = refStem;
    if (preferredPad <= numberCharsRemaining) {
        expectedBankRef = `${refStem}-${countPart.padStart(PREF_COUNT_LENGTH, '0')}`;
    } else if (numberCharsRemaining >= 0) {
        const countLength = countPart.length + numberCharsRemaining;
        expectedBankRef = `${refStem}-${countPart.padStart(countLength, '0')}`;
    } else {
        // worst case : means we have to remove chars from the reference just before the reference counter
        const refNumMatch = (/\d{2,3}$/u).exec(refStem);
        const charsToTrim = -(numberCharsRemaining) + 1; // i.e., to get us back to zero
        const trimmedStem = `${refStem.substring(0, refNumMatch.index - charsToTrim)}${refNumMatch[0]}`;
        expectedBankRef = `${trimmedStem}-${countPart}`;
        logger('For extra long name, reference length: ', expectedBankRef.length);
    }

    return expectedBankRef;
};

module.exports.getPaymentLink = async ({ transactionId, accountInfo, amountDict }) => {
    logger('Received params: ', transactionId, accountInfo, amountDict);
    const dummyPayment = config.has('dummy') && config.get('dummy') === 'ON';
    
    const bankReference = exports.generateBankRef(accountInfo);
    logger('Generated bank ref: ', bankReference);

    if (dummyPayment) {
        const dummyPaymentRef = `some-payment-reference-${(new Date().getTime())}`;
        return { paymentUrl: 'https://pay.me/1234', paymentProvider: 'STRIPE', bankRef: bankReference, paymentRef: dummyPaymentRef };
    }

    const wholeCurrencyAmount = opsUtil.convertToUnit(amountDict.amount, amountDict.unit, 'WHOLE_CURRENCY');
    
    logger('Should send country code: ', CURRENCY_COUNTRY_LOOKUP[amountDict.currency]);
    
    const payload = {
        transactionId,
        bankReference,
        countryCode: CURRENCY_COUNTRY_LOOKUP[amountDict.currency],
        currencyCode: amountDict.currency,
        amount: wholeCurrencyAmount,
        isTest: config.get('payment.test')
    };

    logger('Sending payload to payment url generation: ', payload);
    const urlInvocation = {
        FunctionName: config.get('lambdas.paymentUrlGet'),
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify(payload)
    };

    const paymentUrlResponse = await lambda.invoke(urlInvocation).promise();
    logger('Result of payment url: ', paymentUrlResponse);

    const rawPayload = paymentUrlResponse['Payload'];
    const responseResult = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;

    return {
        paymentUrl: responseResult.paymentUrl,
        paymentProvider: responseResult.paymentProvider,
        paymentRef: responseResult.requestId,
        bankRef: bankReference
    };
};

module.exports.triggerTxStatusCheck = async ({ transactionId, paymentProvider }) => {
    const lambdaInvocation = { 
        FunctionName: config.get('lambdas.checkSavePayment'),
        InvocationType: 'Event',
        Payload: JSON.stringify({ transactionId, paymentProvider })
    };

    logger('Background firing off event: ', lambdaInvocation);

    const invocationResult = await lambda.invoke(lambdaInvocation).promise();
    logger('Result of invocation: ', invocationResult);
    return invocationResult;
};

module.exports.checkPayment = async ({ transactionId }) => {
    logger('Checking payment status on transaction : ', transactionId);

    const statusInvocation = {
        FunctionName: config.get('lambdas.paymentStatusCheck'),
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify({ transactionId, isTest: config.get('payment.test') })
    };

    logger('Sending invocation to payment status getter: ', statusInvocation);
    const paymentStatusResult = await lambda.invoke(statusInvocation).promise();
    
    logger('Result of invocation: ', paymentStatusResult);
    const payload = typeof paymentStatusResult['Payload'] === 'string' ? JSON.parse(paymentStatusResult['Payload']) : paymentStatusResult['Payload'];
    logger('Payload: ', payload);

    let returnResult = { };
    if (paymentStatusResult['StatusCode'] === 200 && payload.result === 'COMPLETE') {
        logger('Payload created date: ', moment(payload.createdDate));
        returnResult = {
            paymentStatus: 'SETTLED',
            createdDate: payload.createdDate ? moment(payload.createdDate) : moment(),
            paymentDate: payload.paymentDate ? moment(payload.paymentDate) : moment()
        };
    } else if (paymentStatusResult['StatusCode'] === 200) {
        logger('Payment not complete, returning an alternate status');
        returnResult = { paymentStatus: payload.result };
    }

    return returnResult;
};

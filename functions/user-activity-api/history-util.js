'use strict';

const moment = require('moment');
const uuid = require('uuid/v4');
const MAX_AMOUNT = 6000000;
const MIN_AMOUNT = 5000000;

module.exports.extractEventBody = (event) => (event.body ? JSON.parse(event.body) : event);

module.exports.isUserAuthorized = (event) => {
    const userDetails = event.requestContext ? event.requestContext.authorizer : null;
    
    if (!userDetails || !Reflect.has(userDetails, 'systemWideUserId')) {
        return false;
    }

    return true;
};

module.exports.unauthorizedResponse = {
    statusCode: 403
};

module.exports.invokeLambda = (functionName, payload, sync = true) => ({
    FunctionName: functionName,
    InvocationType: sync ? 'RequestResponse' : 'Event',
    Payload: JSON.stringify(payload)
});

const generateAmount = () => {
    const base = Math.floor(Math.random());
    const multiplier = (MAX_AMOUNT - MIN_AMOUNT);
    const normalizer = MIN_AMOUNT;
    const rawResult = base * multiplier;
    return rawResult + normalizer;
};

const testBalance = () => ({
    amount: generateAmount(),
    unit: 'HUNDREDTH_CENT',
    currency: 'USD',
    datetime: moment().format(),
    epochMilli: moment().valueOf(),
    timezone: 'America/New_York'
});

module.exports.dryRunResponse = {
    userBalance: {
        accountId: [uuid()],
        balanceStartDayOrLastSettled: testBalance(),
        balanceEndOfToday: testBalance(),
        currentBalance: testBalance(),
        balanceSubsequentDays: [testBalance(), testBalance(), testBalance()]
    },
    accruedInterest: '$20',
    userHistory: [
        {
            timestamp: 1572551269491,
            type: 'HISTORY',
            details: {
                initiator: 'SYSTEM',
                context: '{"freeForm":"JSON object"}',
                interface: 'MOBILE_APP',
                eventType: 'REGISTERED'
            }
        },
        {
            timestamp: 1572637669491,
            type: 'HISTORY',
            details: {
                initiator: 'SYSTEM',
                context: '{"freeForm":"JSON object"}',
                interface: 'MOBILE_APP',
                eventType: 'PASSWORD_SET'
            }
        },
        {
            timestamp: 1572810469491,
            type: 'HISTORY',
            details: {
                initiator: 'SYSTEM',
                context: '{"freeForm":"JSON object"}',
                interface: 'MOBILE_APP',
                eventType: 'USER_LOGIN'
            }
        },
        {
            timestamp: 1572983269000,
            type: 'TRANSACTION',
            details: {
                accountId: '0d287f65-2663-449d-80f6-404730023bf6',
                transactionType: 'ALLOCATION',
                settlementStatus: 'SETTLED',
                amount: '100',
                currency: 'USD',
                unit: 'HUNDREDTH_CENT',
                humanReference: 'BUSANI6'
            }
        }
    ]
};

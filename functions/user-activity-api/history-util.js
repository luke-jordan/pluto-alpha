'use strict';

const config = require('config');
const moment = require('moment');

const allowedCors = config.has('headers.CORS') ? config.get('headers.CORS') : '*';
const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowedCors
};

module.exports.extractEventBody = (event) => (event.body ? JSON.parse(event.body) : event);

module.exports.isUserAuthorized = (event, requiredRole = 'SYSTEM_ADMIN') => {
    const userDetails = event.requestContext ? event.requestContext.authorizer : null;
    
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

module.exports.invokeLambda = (functionName, payload, sync = true) => ({
    FunctionName: functionName,
    InvocationType: sync ? 'RequestResponse' : 'Event',
    Payload: JSON.stringify(payload)
});

module.exports.normalize = (events, type) => {
    const result = [];
    switch (true) {
        case type === 'HISTORY':
            events.forEach((event) => {
                result.push({
                    timestamp: event.timestamp,
                    type,
                    context: {
                        initiator: event.initiator,
                        context: event.context,
                        interface: event.interface,
                        eventType: event.eventType
                    }
                });
            });
            return result;

        case type === 'TRANSACTION':
            events.forEach((event) => {
                result.push({
                    timestamp: moment(event.creationTime).valueOf(),
                    type,
                    context: {
                        accountId: event.accountId,
                        transactionType: event.transactionType,
                        settlementStatus: event.settlementStatus,
                        amount: event.amount,
                        currency: event.currency,
                        unit: event.unit,
                        humanReference: event.humanReference
                    }
                })
            });
            return result;

        default:
            return result;        
    };
};
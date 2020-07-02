'use strict';

const config = require('config');
const stringify = require('json-stable-stringify');
// const logger = require('debug')('jupiter:message:util');

const allowedCors = config.has('headers.CORS') ? config.get('headers.CORS') : '*';
const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowedCors
};

module.exports.eventTypesForHistory = [
    'USER_LOGIN', 
    'PASSWORD_SET', 
    'USER_REGISTERED', 
    'STATUS_CHANGED', 
    'FAILED_VERIFICATION', 
    'VERIFIED_AS_PERSON', 
    
    'SAVING_PAYMENT_SUCCESSFUL', 
    'BOOST_REDEEMED',

    'WITHDRAWAL_EVENT_CONFIRMED', 
    'WITHDRAWAL_COMPLETED', 
    
    'BANK_VERIFICATION_FAILED',
    'BANK_VERIFICATION_SUCCEEDED',
    'BANK_VERIFICATION_MANUAL'
];

module.exports.extractEventBody = (event) => (event.body ? JSON.parse(event.body) : event);

module.exports.isUserAuthorized = (event, requiredRole = 'SYSTEM_ADMIN') => {
    const userDetails = event.requestContext ? event.requestContext.authorizer : null;
    
    if (!userDetails || !Reflect.has(userDetails, 'systemWideUserId')) {
        return false;
    }

    return userDetails.role === requiredRole; // userRole?
};

module.exports.wrapHttpResponse = (body, statusCode = 200) => ({    
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(body)
});

module.exports.codeOnlyResponse = (statusCode = 200) => ({
    headers: corsHeaders,
    statusCode
});

module.exports.unauthorizedResponse = {
    statusCode: 403,
    headers: corsHeaders
};

module.exports.invokeLambda = (functionName, payload, sync = true) => ({
    FunctionName: functionName,
    InvocationType: sync ? 'RequestResponse' : 'Event',
    Payload: stringify(payload)
});

'use strict';

const config = require('config');
const logger = require('debug')('jupiter:message:util');

const allowedCors = config.has('headers.CORS') ? config.get('headers.CORS') : '*';
const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowedCors
};

module.exports.extractEventBody = (event) => (event.body ? JSON.parse(event.body) : event);
module.exports.extractUserDetails = (event) => (event.requestContext ? event.requestContext.authorizer : null);

module.exports.isUserAuthorized = (userDetails, requiredRole = 'SYSTEM_ADMIN') => {
    if (!userDetails || !Reflect.has(userDetails, 'systemWideUserId')) {
        return false;
    }

    const mockingRole = config.has('security.roleRequired') && !config.get('security.roleRequired');
    logger('Security required ? : ', mockingRole);
    if (mockingRole) {
        return true;
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

module.exports.lambdaInvocation = (functionName, payload, requestResponse = false, logs = false) => ({
    FunctionName: functionName,
    InvocationType: requestResponse ? 'RequestResponse' : 'Event',
    LogType: logs ? 'Tail' : 'None',
    Payload: JSON.stringify(payload)
});


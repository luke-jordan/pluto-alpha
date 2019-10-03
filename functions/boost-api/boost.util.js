'use strict';

const config = require('config');
// const logger = require('debug')('jupiter:message:util');

const allowedCors = config.has('headers.CORS') ? config.get('headers.CORS') : '*';
const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowedCors
};

module.exports.extractUserDetails = (event) => (event.requestContext ? event.requestContext.authorizer : null);
module.exports.extractEventBody = (event) => (event.body ? JSON.parse(event.body) : event);

module.exports.extractQueryParams = (event) => {
    if (event.queryStringParameters === 'object' && event.queryStringParameters !== null) {
        return event.queryStringParameters;
    } 
    return event;
};

// todo : transition to using permissions
module.exports.isUserAuthorized = (userDetails, requiredRole = 'SYSTEM_ADMIN') => {
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

module.exports.errorResponse = (err) => ({
    statusCode: 500,
    headers: corsHeaders,
    body: JSON.stringify(err.message)
});

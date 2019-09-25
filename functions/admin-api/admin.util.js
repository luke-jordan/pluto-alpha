'use strict';

const config = require('config');
const logger = require('debug')('jupiter:message:util');

const allowedCors = config.has('headers.CORS') ? config.get('headers.CORS') : '*';
const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowedCors
};

module.exports.extractEventBody = (event) => event.body ? JSON.parse(event.body) : event;

const extractUserDetails = (event) => event.requestContext ? event.requestContext.authorizer : null;

module.exports.isUserAuthorized = (event, requiredRole = 'SYSTEM_ADMIN') => {
    const userDetails = extractUserDetails(event);
    
    if (!userDetails || !Reflect.has(userDetails, 'systemWideUserId')) {
        return false;
    }

    return userDetails.role === requiredRole;
};

module.exports.wrapHttpResponse = (body, statusCode = 200) => {
    return {
        statusCode,
        headers: corsHeaders,
        body: JSON.stringify(body)
    };
};

module.exports.unauthorizedResponse = {
    statusCode: 403,
    headers: corsHeaders
};

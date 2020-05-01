'use strict';

module.exports.resetStubs = (...stubs) => {
    stubs.forEach((stub) => stub.reset());
};

module.exports.wrapEvent = (requestBody, systemWideUserId, userRole) => ({
    body: JSON.stringify(requestBody),
    requestContext: {
        authorizer: {
            systemWideUserId,
            role: userRole
        }
    }
});

module.exports.wrapResponse = (body, statusCode = 200) => ({
    statusCode,
    headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(body)
});

module.exports.wrapLambdaInvoc = (functionName, async, payload) => ({
    FunctionName: functionName,
    InvocationType: async ? 'Event' : 'RequestResponse',
    Payload: JSON.stringify(payload)
});

module.exports.mockLambdaResponse = (body, statusCode = 200) => ({
    Payload: JSON.stringify({
        statusCode,
        body: JSON.stringify(body)
    })
});

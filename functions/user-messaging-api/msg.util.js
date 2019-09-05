'use strict';

const config = require('config');

module.exports.wrapHttpResponse = (body, statusCode = 200) => {
    const allowedCors = config.has('headers.CORS') ? config.get('headers.CORS') : '*';
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': allowedCors
        },
        body: JSON.stringify(body)
    };
}

module.exports.lambdaInvocation = (functionName, payload, requestResponse = false, logs = false) => ({
    FunctionName: functionName,
    InvocationType: requestResponse ? 'RequestResponse' : 'Event',
    LogType: logs ? 'Tail' : 'None',
    Payload: JSON.stringify(payload)
});

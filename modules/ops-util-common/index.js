'use strict';

const config = require('config');

module.exports.wrapResponse = (body, statusCode = 200) => {
    const allowedCors = config.has('headers.CORS') ? config.get('headers.CORS') : '*';
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': allowedCors
        },
        body: JSON.stringify(body)
    };
};

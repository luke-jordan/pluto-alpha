'use strict';

const logger = require('debug')('jupiter:third-parties:finworks');
const config = require('config');
const util = require('util');
const opsUtil = require('ops-util-common');
const request = require('request-promise');
const AWS = require('aws-sdk');

const s3 = new AWS.S3();

const fetchAccessCreds = async () => {
    const bucket = config.get('finworks.s3.bucket');
    const crt = await s3.getObject({ Bucket: bucket, Key: config.get('finworks.s3.crt') }).promise();
    const pem = await s3.getObject({ Bucket: bucket, Key: config.get('finworks.s3.pem') }).promise();
    return [crt.Body.toString('ascii'), pem.Body.toString('ascii')];
};

const assembleRequest = (method, endpoint, data) => {
    const options = {
        method,
        uri: endpoint,
        agentOptions: { cert: data.crt, key: data.pem },
        json: true
    };
    if (data) {
        options.body = data.body;
    }
    return options;
};

module.exports.createAccount = async (event) => {
    try {
        const params = opsUtil.extractParamsFromEvent(event);
        const body = { idNumber: params.idNumber, surname: params.surname, firstNames: params.firstNames };
        const [crt, pem] = await fetchAccessCreds();
        const options = assembleRequest('POST', config.get('finworks.endpoints.accountCreation'), { body, crt, pem });

        const response = await request(options);
        logger('Got response:', response);

        return opsUtil.wrapResponse(response, 200);

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse(err.message, 500);
    }
};

module.exports.addCash = async (event) => {
    try {
        const params = opsUtil.extractParamsFromEvent(event);
        const body = { amount: params.amount, unit: params.unit, currency: params.currency };
        const [crt, pem] = await fetchAccessCreds();
        const endpoint = util.format(config.get('finworks.endpoints.addCash'), params.accountId);
        logger('Assembled endpoint:', endpoint);

        const options = assembleRequest('POST', endpoint, { body, crt, pem });
        const response = await request(options);
        logger('Got response:', response);

        return opsUtil.wrapResponse(response, 200);

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse(err.message, 500);
    }
};

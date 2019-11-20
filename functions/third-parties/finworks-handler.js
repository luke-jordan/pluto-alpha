'use strict';

const logger = require('debug')('jupiter:third-parties:finworks');
const config = require('config');
const util = require('util');
const opsUtil = require('ops-util-common');
const request = require('request-promise');
const AWS = require('aws-sdk');

const s3 = new AWS.S3();

const fetchAccessCred = async (bucket, key) => {
    const object = await s3.getObject({ Bucket: bucket, Key: key }).promise();
    return object.Body.toString('ascii');
};

const assembleRequest = (endpoint, method, data) => {
    const options = {
        method,
        uri: endpoint,
        json: true,
        agentOptions: {
            cert: data.crt,
            key: data.pem
        }
    };
    if (data) {
        options.body = data.body;
    }
    logger('assembled options:', options);
    return options;
};

module.exports.createAccount = async (event) => {
    try {
        // authorizer?        
        const params = opsUtil.extractParamsFromEvent(event);

        const body = {
            idNumber: params.idNumber,
            surname: params.surname,
            firstNames: params.firstNames
        };

        const bucket = config.get('finworks.s3.bucket');
        const [crt, pem] = await Promise.all([fetchAccessCred(bucket, config.get('finworks.s3.crt')), fetchAccessCred(bucket, config.get('finworks.s3.pem'))]);

        const options = assembleRequest(config.get('finworks.endpoints.accountCreation'), 'POST', { body, crt, pem });
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
        // authorizer?
        const params = opsUtil.extractParamsFromEvent(event);

        const body = {
            amount: params.amount,
            unit: params.unit,
            currency: params.currency
        };

        const bucket = config.get('finworks.s3.bucket');
        const [crt, pem] = await Promise.all([fetchAccessCred(bucket, config.get('finworks.s3.crt')), fetchAccessCred(bucket, config.get('finworks.s3.pem'))]);
        const endpoint = util.format(config.get('finworks.endpoints.addCash'), params.accountId);

        logger('Assembled endpoint:', endpoint);
        const options = assembleRequest(endpoint, 'POST', { body, crt, pem });
        const response = await request(options);
        logger('Got response:', response);

        return opsUtil.wrapResponse(response, 200);

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse(err.message, 500);
    }
};

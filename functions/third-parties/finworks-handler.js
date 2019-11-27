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
    const [crt, pem] = await Promise.all([
        s3.getObject({ Bucket: bucket, Key: config.get('finworks.s3.crt') }).promise(),
        s3.getObject({ Bucket: bucket, Key: config.get('finworks.s3.pem') }).promise()
    ]);
    return [crt.Body.toString('ascii'), pem.Body.toString('ascii')];
};

const assembleRequest = (method, endpoint, data) => {
    const options = {
        method,
        uri: endpoint,
        agentOptions: { cert: data.crt, key: data.pem },
        json: true
    };
    if (data.body) {
        options.body = data.body;
    }
    return options;
};

module.exports.createAccount = async (event) => {
    try {
        const params = opsUtil.extractParamsFromEvent(event);
        const body = { idNumber: params.idNumber, surname: params.surname, firstNames: params.firstNames };
        const [crt, pem] = await fetchAccessCreds();
        const endpoint = config.get('finworks.endpoints.rootUrl') + config.get('finworks.endpoints.accountCreation');
        const options = assembleRequest('POST', endpoint, { body, crt, pem });

        const response = await request(options);
        logger('Got response:', response);

        if (!Reflect.has(response, 'accountNumber')) {
            throw new Error(JSON.stringify(response));
        }

        return response;

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'ERROR', details: err.message };
    }
};

module.exports.addCash = async (event) => {
    try {
        const params = opsUtil.extractParamsFromEvent(event);
        const body = { amount: params.amount, unit: params.unit, currency: params.currency };
        const [crt, pem] = await fetchAccessCreds();
        const endpoint = config.get('finworks.endpoints.rootUrl') + util.format(config.get('finworks.endpoints.addCash'), params.accountNumber);
        logger('Assembled endpoint:', endpoint);

        const options = assembleRequest('POST', endpoint, { body, crt, pem });
        const response = await request(options);
        logger('Got response:', response);

        if (Reflect.has(response, 'errors')) {
            throw new Error(JSON.stringify(response));
        }

        return response;

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'ERROR', details: err.message };
    }
};

module.exports.getMarketValue = async (event) => {
    try {
        const params = opsUtil.extractParamsFromEvent(event);
        const [crt, pem] = await fetchAccessCreds();
        const endpoint = config.get('finworks.endpoints.rootUrl') + util.format(config.get('finworks.endpoints.marketValue'), params.accountNumber);
        logger('Assembled endpoint:', endpoint);

        const options = assembleRequest('GET', endpoint, { crt, pem });
        const response = await request(options);
        logger('Got response:', response);

        if (Reflect.has(response, 'errors')) {
            throw new Error(JSON.stringify(response));
        }

        return response;

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'ERROR', details: err.message };
    }
};

module.exports.sendWithdrawal = async (event) => {
    try {
        const params = opsUtil.extractParamsFromEvent(event);
        const body = {
            amount: params.amount,
            currency: params.currency,
            bankDetails: {
                holderName: params.holderName,
                accountNumber: params.accountNumber,
                branchCode: params.branchCode,
                type: params.type,
                bankName: params.bankName
            }
        };

        const [crt, pem] = await fetchAccessCreds();
        const endpoint = config.get('finworks.endpoints.rootUrl') + util.format(config.get('finworks.endpoints.withdrawals'), params.accountNumber);
        logger('Assembled endpoint:', endpoint);

        const options = assembleRequest('POST', endpoint, { body, crt, pem });
        const response = await request(options);
        logger('Got response:', response);

        if (Reflect.has(response, 'errors')) {
            throw new Error(JSON.stringify(response));
        }

        return response;

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'ERROR', details: err.message };
    }
};

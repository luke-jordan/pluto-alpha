'use strict';

const logger = require('debug')('jupiter:third-parties:finworks');
const config = require('config');
const util = require('util');
const opsUtil = require('ops-util-common');
const request = require('request-promise');
const AWS = require('aws-sdk');

const s3 = new AWS.S3();

const SUCCESS_RESPONSES = [200, 201];

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
        resolveWithFullResponse: true,
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
        const endpoint = `${config.get('finworks.endpoints.rootUrl')}${config.get('finworks.endpoints.accountCreation')}`;
        const options = assembleRequest('POST', endpoint, { body, crt, pem });

        const response = await request(options);
        logger('Got response:', response);

        if (!SUCCESS_RESPONSES.includes(response.statusCode)) {
            throw new Error(JSON.stringify(response.body));
        }

        return response.body;

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'ERROR', details: err.message };
    }
};

module.exports.addCash = async (event) => {
    try {
        const { accountNumber, amount, currency, unit } = opsUtil.extractParamsFromEvent(event);

        const body = { amount, unit, currency };

        const [crt, pem] = await fetchAccessCreds();
        const endpoint = `${config.get('finworks.endpoints.rootUrl')}${util.format(config.get('finworks.endpoints.addCash'), accountNumber)}`;
        logger('Assembled endpoint:', endpoint);

        const options = assembleRequest('POST', endpoint, { body, crt, pem });
        const response = await request(options);
        logger('Got response:', response);

        if (!SUCCESS_RESPONSES.includes(response.statusCode)) {
            throw new Error(JSON.stringify(response.body));
        }

        return response.body;

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'ERROR', details: err.message };
    }
};

module.exports.sendWithdrawal = async (event) => {
    try {
        const { accountNumber, amount, currency, unit, bankDetails } = opsUtil.extractParamsFromEvent(event);

        const body = {
            amount,
            currency,
            unit,
            bankDetails: {
                holderName: bankDetails.holderName,
                accountNumber: bankDetails.accountNumber,
                branchCode: bankDetails.branchCode,
                type: bankDetails.accountType,
                bankName: bankDetails.bankName
            }
        };

        const [crt, pem] = await fetchAccessCreds();
        const endpoint = `${config.get('finworks.endpoints.rootUrl')}${util.format(config.get('finworks.endpoints.withdrawals'), accountNumber)}`;
        logger('Assembled endpoint:', endpoint);

        const options = assembleRequest('POST', endpoint, { body, crt, pem });
        const response = await request(options);
        logger('Got response:', response);

        if (!SUCCESS_RESPONSES.includes(response.statusCode)) {
            throw new Error(JSON.stringify(response.body));
        }

        return response.body;

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'ERROR', details: err.message };
    }
};

module.exports.addTransaction = async (event) => {
    logger('Adding transaction to balance sheet, event: ', event);
    const { operation, transactionDetails } = event;

    const dispatch = { 'INVEST': exports.addCash, 'WITHDRAW': exports.sendWithdrawal };    
    if (!operation || !Object.keys(dispatch).includes(operation)) {
        return { result: 'ERROR', message: 'No or invalid operation' };
    }

    const resultOfOperation = await dispatch[operation](transactionDetails);
    logger('Result of operation in dispatcher: ', resultOfOperation);
    return resultOfOperation;
};

module.exports.getMarketValue = async (event) => {
    try {
        const { accountNumber } = opsUtil.extractParamsFromEvent(event);
        
        const [crt, pem] = await fetchAccessCreds();
        const endpoint = `${config.get('finworks.endpoints.rootUrl')}${util.format(config.get('finworks.endpoints.marketValue'), accountNumber)}`;
        logger('Assembled endpoint:', endpoint);

        const options = assembleRequest('GET', endpoint, { crt, pem });
        const response = await request(options);
        logger('Got response:', response);

        if (!SUCCESS_RESPONSES.includes(response.statusCode)) {
            throw new Error(JSON.stringify(response.body));
        }

        return response.body;

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'ERROR', details: err.message };
    }
};

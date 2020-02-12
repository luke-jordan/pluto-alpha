'use strict';

const logger = require('debug')('jupiter:third-parties:finworks');
const config = require('config');
const util = require('util');
const opsUtil = require('ops-util-common');
const request = require('request-promise');
const AWS = require('aws-sdk');

const s3 = new AWS.S3();

const SUCCESS_RESPONSES = [200, 201];

const BANK_BRANCH_CODES = {
    'FNB': '250655',
    'ABSA': '632005',
    'STANDARD': '051001',
    'NEDBANK': '198765',
    'CAPITEC': '470010'
};

const FINWORKS_NAMES = {
    'FNB': 'First National Bank',
    'ABSA': 'ABSA',
    'STANDARD': 'Standard Bank',
    'NEDBANK': 'Nedbank',
    'CAPITEC': 'Capitec'
};

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
        logger('Received params for FW account create: ', params);
        const accountNumber = params.humanRef ? params.humanRef : '';
        const body = { idNumber: params.idNumber, surname: params.surname, firstNames: params.firstNames, accountNumber };
        logger('Sending body to FW: ', body);
        const [crt, pem] = await fetchAccessCreds();
        const endpoint = `${config.get('finworks.endpoints.rootUrl')}/${config.get('finworks.endpoints.accountCreation')}`;
        const options = assembleRequest('POST', endpoint, { body, crt, pem });

        const response = await request(options);
        logger('Got response:', response.toJSON());

        if (!SUCCESS_RESPONSES.includes(response.statusCode)) {
            throw new Error(JSON.stringify(response.body));
        }

        return response.body;

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'ERROR', details: err.message };
    }
};

const assembleAddMoneyOptions = async (event, endPointTemplate) => {
    const { accountNumber, amount, currency, unit } = opsUtil.extractParamsFromEvent(event);

    const body = { amount, unit, currency };

    const [crt, pem] = await fetchAccessCreds();
    const endpoint = `${config.get('finworks.endpoints.rootUrl')}/${util.format(endPointTemplate, accountNumber)}`;
    logger('Assembled endpoint:', endpoint);

    const options = assembleRequest('POST', endpoint, { body, crt, pem });
    const response = await request(options);

    logger('Got response:', response.toJSON());

    if (!SUCCESS_RESPONSES.includes(response.statusCode)) {
        throw new Error(JSON.stringify(response.body));
    }

    return response;
};

module.exports.addCash = async (event) => {
    try {
        const response = await assembleAddMoneyOptions(event, config.get('finworks.endpoints.addCash'));
        // logger('Response from generic method for add cash: ', response);
        return response.body;
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'ERROR', details: err.message };
    }
};

module.exports.addBoost = async (event) => {
    try {
        const response = await assembleAddMoneyOptions(event, config.get('finworks.endpoints.addBoost'));
        // logger('Response from generic method for boost: ', response);
        return response.body;
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'ERROR', details: err.message };
    }
};

module.exports.sendWithdrawal = async (event) => {
    try {
        const { accountNumber, amount, currency, unit, bankDetails } = opsUtil.extractParamsFromEvent(event);

        // we have to do a little transformation in here to handle different naming conventions & continued use of branch codes
        const body = {
            amount,
            currency,
            unit,
            bankDetails: {
                holderName: bankDetails.accountHolder,
                accountNumber: bankDetails.accountNumber,
                branchCode: BANK_BRANCH_CODES[bankDetails.bankName],
                type: bankDetails.accountType,
                bankName: FINWORKS_NAMES[bankDetails.bankName]
            }
        };

        const [crt, pem] = await fetchAccessCreds();
        const endpoint = `${config.get('finworks.endpoints.rootUrl')}/${util.format(config.get('finworks.endpoints.withdrawals'), accountNumber)}`;
        logger('Assembled endpoint:', endpoint);

        const options = assembleRequest('POST', endpoint, { body, crt, pem });
        const response = await request(options);
        logger('Got response:', response.toJSON());

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

    const dispatch = { 'INVEST': exports.addCash, 'BOOST': exports.addBoost, 'WITHDRAW': exports.sendWithdrawal };    
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
        const endpoint = `${config.get('finworks.endpoints.rootUrl')}/${util.format(config.get('finworks.endpoints.marketValue'), accountNumber)}`;
        logger('Assembled endpoint:', endpoint);

        const options = assembleRequest('GET', endpoint, { crt, pem });
        const response = await request(options);
        logger('Got response:', response.toJSON());

        if (!SUCCESS_RESPONSES.includes(response.statusCode)) {
            throw new Error(JSON.stringify(response.body));
        }

        return response.body;

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'ERROR', details: err.message };
    }
};

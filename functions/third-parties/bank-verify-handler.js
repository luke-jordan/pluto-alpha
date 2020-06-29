'use strict';

const logger = require('debug')('jupiter:third-parties:bank-verify');
const config = require('config');
const request = require('request-promise');

const extractEventBody = (event) => (event.body ? JSON.parse(event.body) : event);

// the APIs version is dumb and counter-intuitive, so we do a transform
// CURRENTCHEQUEACCOUNT,SAVINGSACCOUNT,TRANSMISSION,BOND
const accountTypeMap = {
    'SAVINGS': 'SAVINGSACCOUNT',
    'CURRENT': 'CURRENTCHEQUEACCOUNT',
    'TRANSMISSION': 'TRANSMISSION',
    'BOND': 'BOND'
};

const validateParams = (params) => {
    const supportedBanks = config.get('pbVerify.supportedBanks');
    const manualBanks = config.get('pbVerify.manualBanks'); // these are for ones very popular but without automated support
    const validBanks = [...supportedBanks, ...manualBanks];

    const accountTypes = config.get('pbVerify.accountTypes');
    
    switch (true) {
        case !params.bankName:
            throw new Error('NO_BANK_NAME');
        case !validBanks.includes(params.bankName.toUpperCase()):
            throw new Error('BANK_NOT_SUPPORTED');
        case !params.accountNumber:
            throw new Error('NO_ACCOUNT_NUMBER');
        case !params.accountType:
            throw new Error('NO_ACCOUNT_TYPE');
        case !accountTypes.includes(params.accountType.toUpperCase()):
            throw new Error('INVALID_ACCOUNT_TYPE');
        case !params.reference:
            throw new Error('NO_REFERENCE');
        case !params.nationalId:
            throw new Error('NO_NATIONAL_ID');
        case !params.initials:
            throw new Error('NO_INITIALS');
        case !params.surname:
            throw new Error('NO_SURNAME');
        default:
            return params;
    }
};

const assembleRequest = (params, action) => {
    if (action === 'INITIALISE') {
        return {
            method: 'POST',
            url: `${config.get('pbVerify.endpoint')}/${config.get('pbVerify.path.bankstart')}`,
            formData: {
                'memberkey': config.get('pbVerify.memberKey'),
                'password': config.get('pbVerify.password'),
                'bvs_details[verificationType]': 'Individual',
                'bvs_details[bank_name]': params.bankName,
                'bvs_details[acc_number]': params.accountNumber,
                'bvs_details[acc_type]': accountTypeMap[params.accountType],
                'bvs_details[yourReference]': params.reference,
                'bvs_details[id_number]': params.nationalId,
                'bvs_details[initials]': params.initials,
                'bvs_details[surname]': params.surname
            },
            json: true
        };
    }
    if (action === 'CHECKSTATUS') {
        return {
            method: 'POST',
            url: `${config.get('pbVerify.endpoint')}/${config.get('pbVerify.path.bankstatus')}`,
            formData: {
                'memberkey': config.get('pbVerify.memberKey'),
                'password': config.get('pbVerify.password'),
                'jobId': params.jobId
            },
            json: true
        };
    }
};


/**
 * This function enables verifications on consumer bank account details to determine the state and 
 * validity of a South African bank account. The Following banks are supported ABSA; FNB; STANDARD, NEDBANK, CAPITEC. 
 * Processing Times – Although the service is available 24 x 7 x 365, records received after 17:00 on 
 * weekdays, will only be submitted on the next available working day. Records are only submitted for 
 * verification after 03:00 AM on normal weekdays. Responses may be available within 30 minutes, but it 
 * could take up to 3+ hours to receive responses from participating banks.
 * This function returns a job status and job id in its response.
 * @param {object} event An event object containing the request body. The event body's properties are described below.
 * @property {string} bankName Name of bank can be any of the following - (ABSA, FNB, STANDARDBANK, NEDBANK, CAPITEC).
 * @property {string} accountNumber Bank account number of account holder.
 * @property {string} accountType Bank account type of account holder (CURRENTCHEQUEACCOUNT,SAVINGSACCOUNT,TRANSMISSION,BOND).
 * @property {string} reference Your Search Reference - Internal use.
 * @property {string} initials if Verification Type is Individual, this will be the initials of person.
 * @property {string} surname if Verification Type is Individual, this will be the persons Surname.
 * @property {string} nationalId if Verification Type is Individual, this will be the persons ID Number.
 */
module.exports.initialize = async (event) => {
    try {
        const mockVerifyOn = config.has('mock.enabled') && typeof config.get('mock.enabled') === 'boolean' && config.get('mock.enabled');
        if (mockVerifyOn) {
            const mockResult = Boolean(config.get('mock.result'));
            logger('Returning mock result: ', mockResult);
            return { status: 'SUCCESS', jobId: 'mock-job-id' };
        }

        const params = extractEventBody(event);
        const validParams = validateParams(params);
        logger('Validated params:', validParams);

        const isManualBank = config.get('pbVerify.manualBanks').includes(params.bankName.toUpperCase());
        logger('Is this a bank that requires manual verification: ', isManualBank);
        if (isManualBank) {
            return { status: 'SUCCESS', jobId: 'MANUAL_JOB' };
        }

        const options = assembleRequest(validParams, 'INITIALISE');
        logger('Created options:', options);

        const response = await request(options);
        logger('Verification request result in:', response);
        if (!response || typeof response !== 'object' || response.Status !== 'Success') {
            return { status: 'ERROR', details: response };
        }

        return { status: 'SUCCESS', jobId: response['XDSBVS']['JobID']};

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { status: 'ERROR', details: err.message };
    }
};

const doesResponseVerify = (response) => {
    if (response.Status === 'Pending') {
        return { result: 'PENDING' };
    }

    if (response.Status !== 'Success') {
        return { result: 'ERROR', cause: 'Failure by third party service' };
    }

    const responseDetails = response['Results'];
    if (!responseDetails['IDNUMBERMATCH'] || responseDetails['IDNUMBERMATCH'] !== 'Yes') {
        return { result: 'FAILED', cause: 'ID number does not match'};
    }

    if (!responseDetails['ACCOUNT-OPEN'] || responseDetails['ACCOUNT-OPEN'] !== 'Yes') {
        return { result: 'FAILED', cause: 'Account not open' };
    }

    if (!responseDetails['ACCOUNTACCEPTSCREDITS'] || responseDetails['ACCOUNTACCEPTSCREDITS'] !== 'Yes') {
        return { result: 'FAILED', cause: 'Account does not accept credits' };
    }

    return { result: 'VERIFIED' };
};

/**
 * This function is used with the response from initialize(), you will receive a JobID in the result of
 * the verification which will be used to check on the status of the bank account verification.
 * @param {object} event An event object containing the request context and request body. The event body's properties are described below.
 * @property {string} jobId JobId returned from the bank account verification API
 */
module.exports.checkStatus = async (event) => {
    try {
        const mockVerifyOn = config.has('mock.enabled') && typeof config.get('mock.enabled') === 'boolean' && config.get('mock.enabled');
        if (mockVerifyOn) {
            const mockResult = Boolean(config.get('mock.result'));
            logger('Mock result in check status: ', mockResult);
            return { result: mockResult };
        }

        const params = extractEventBody(event);
        if (!params.jobId) {
            throw new Error('Missing job id');
        }

        if (params.jobId === 'MANUAL_JOB') {
            logger('Job ID is for manual bank, return true');
            return { result: 'VERIFY_MANUALLY' };
        }

        const options = assembleRequest(params, 'CHECKSTATUS');
        logger('Created options:', options);

        const response = await request(options);
        logger('Verification request result in:', response);
        if (!response || typeof response !== 'object' || typeof response.Status !== 'string') {
            logger('FATAL_ERROR: Bank verification malformed response: ', response);
            return { status: 'ERROR', details: response };
        }

        const checkFields = doesResponseVerify(response);
        logger('Checking response fields gave: ', checkFields);

        return checkFields;
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { status: 'ERROR', details: err.message };
    }
};

// what we use to direct the check; doing it this way for the moment to avoid proliferation
module.exports.handle = async (event) => {
    // try catch will happen inside block
    const { operation, parameters } = event;
    if (operation === 'statusCheck') {
        return exports.checkStatus(parameters);
    } 
    
    return exports.initialize(parameters);
};

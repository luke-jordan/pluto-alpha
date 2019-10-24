'use strict';

const logger = require('debug')('jupiter:third-parties:bank-verify');
const config = require('config');
const request = require('request-promise');

const extractUserDetails = (event) => (event.requestContext ? event.requestContext.authorizer : null);
const extractEventBody = (event) => (event.body ? JSON.parse(event.body) : event);

const wrapHttpResponse = (body, statusCode = 200) => ({
    statusCode,
    headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(body)
});

const validateParams = (params) => {
    const supportedBanks = config.get('pbVerify.supportedBanks');
    const accountTypes = config.get('pbVerify.accountTypes');
    switch (true) {
        case !params.verificationType:
            throw new Error('Missing verification type');
        case params.verificationType !== 'Company' && params.verificationType !== 'Individual':
            throw new Error('Invalid verification type');
        case !params.bankName:
            throw new Error('Missing bank name');
        case !supportedBanks.includes(params.bankName.toUpperCase()):
            throw new Error('The bank you have entered is currently not supported')
        case !params.accountNumber:
            throw new Error('Missing account number');
        case !params.accountType:
            throw new Error('Missing account type');
        case !accountTypes.includes(params.accountType.toUpperCase()):
            throw new Error('Invalid account type');
        case !params.reference:
            throw new Error('Missing reference');
        case params.verificationType === 'Company' && !params.companyRegNumber:
            throw new Error('Company registration number is required for company account verification');
        case params.verificationType === 'Company' && !params.companyName:
            throw new Error('Company name is required for company account verification');
        case params.verificationType === 'Individual' && !params.nationalId:
            throw new Error('The individuals national id is required for individual account verification');
        case params.verificationType === 'Individual' && !params.initials:
            throw new Error('The individuals initials are required for individual account verification');
        case  params.verificationType === 'Individual' && !params.surname:
            throw new Error('The individuals surname is required for individual account verification');
        default:
            return params;
    }
};

const assembleRequest = (params) => {
    const verificationType = params.verificationType

    let entityDetails = {
        'memberkey': config.get('pbVerify.memberKey'),
        'password': config.get('pbVerify.password'),
        'bvs_details[verificationType]': verificationType,
        'bvs_details[bank_name]': params.bankName,
        'bvs_details[acc_number]': params.accountNumber,
        'bvs_details[acc_type]': params.accountType,
        'bvs_details[yourReference]': params.reference
    };

    if (verificationType === 'Company') {
        entityDetails['bvs_details[company_reg_no]'] = params.companyRegNumber;
        entityDetails['bvs_details[company_name]'] = params.companyName;
    }

    if (verificationType === 'Individual') {
        entityDetails['bvs_details[id_number]'] = params.nationalId;
        entityDetails['bvs_details[initials]'] = params.initials;
        entityDetails['bvs_details[surname]'] = params.surname;
    }

    return {
        method: 'POST',
        url: config.get('pbVerify.endpoint'),
        formData: entityDetails,
        json: true
    };
};


/**
 * This function enables verifications on consumer bank account details to determine the state and 
 * validity of a South African bank account. The Following banks are supported ABSA; FNB; STANDARD, NEDBANK, CAPITEC. 
 * Processing Times – Although the service is available 24 x 7 x 365, records received after 17:00 on 
 * weekdays, will only be submitted on the next available working day. Records are only submitted for 
 * verification after 03:00 AM on normal weekdays. Responses may be available within 30 minutes, but it 
 * could take up to 3+ hours to receive responses from participating banks.
 * This function returns a job status and job id in its response.
 * @param {object} event An event object containing the request context and request body. The event body's properties are described below.
 * @property {string} verificationType Type of Verification, can be either Company or Individual.
 * @property {string} bankName Name of bank can be any of the following - (ABSA, FNB, STANDARDBANK, NEDBANK, CAPITEC).
 * @property {string} accountNumber Bank account number of account holder.
 * @property {string} accountType Bank account type of account holder (CURRENTCHEQUEACCOUNT,SAVINGSACCOUNT,TRANSMISSION,BOND).
 * @property {string} reference Your Search Reference - Internal use.
 * @property {string} companyRegNumber if Verification Type is Company this is the Company registration number in the following format xxxx/xxxxxx/xx
 * @property {string} companyName if Verification Type is Company, this will be the Company Name.
 * @property {string} initials if Verification Type is Individual, this will be the initials of person.
 * @property {string} surname if Verification Type is Individual, this will be the persons Surname.
 * @property {string} nationalId if Verification Type is Individual, this will be the persons ID Number.
 */
module.exports.initialize = async (event) => {
    try {
        const userDetails = extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const params = extractEventBody(event);
        const validParams = validateParams(params)
        logger('Validated params:', validParams);

        const options = assembleRequest(validParams);
        logger('Created options:', options);

        const response = await request(options);
        logger('Verification request result in:', response);
        if (!response || typeof response !== 'object' || response.Status !== 'Success') {
            return wrapHttpResponse(response, 500);
        }

        return wrapHttpResponse(response, 200);

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return wrapHttpResponse(err.message, 500);
    }
};

/**
 * This function is used with the response from initialize(), you will receive a JobID in the result of
 * the verification which will be used to check on the status of the bank account verification.
 * @param {object} event An event object containing the request context and request body. The event body's properties are described below.
 * @property {string} jobId JobId returned from the bank account verification API
 */
module.exports.checkStatus = async (event) => {
    try {
        const userDetails = extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const params = extractEventBody(event);
        if (!params.jobId) {
            throw new Error('Missing job id');
        }

        const options = {
            method: 'POST',
            url: config.get('pbVerify.endpoint'),
            formData: {
                'memberkey': config.get('pbVerify.memberKey'),
                'password': config.get('pbVerify.password'),
                'jobId': params.jobId
            },
            json: true
        };
        logger('Created options:', options);
        const response = await request(options);
        logger('Verification request result in:', response);
        if (!response || typeof response !== 'object' || response.Status !== 'Success') {
            return wrapHttpResponse(response, 500);
        }

        return wrapHttpResponse(response, 200);

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return wrapHttpResponse(err.message, 500);
    }
};

'use strict';

const logger = require('debug')('jupiter:admin:user-status');
const config = require('config');

const adminUtil = require('../admin.util');
const opsCommonUtil = require('ops-util-common');

const validKycStatus = ['NO_INFO', 'CONTACT_VERIFIED', 'PENDING_VERIFICATION_AS_PERSON', 'VERIFIED_AS_PERSON', 
    'FAILED_VERIFICATION', 'FLAGGED_FOR_REVIEW', 'PENDING_INFORMATION', 'REVIEW_CLEARED', 'REVIEW_FAILED'];

const validUserStatus = ['CREATED', 'ACCOUNT_OPENED', 'USER_HAS_INITIATED_SAVE', 'USER_HAS_SAVED', 'USER_HAS_WITHDRAWN', 'SUSPENDED_FOR_KYC'];

const validRegulatoryStatus = ['REQUIRES_AGREEMENT', 'HAS_GIVEN_AGREEMENT'];


// checking for reason to log is across any update, hence here just check right field and valid type
const validateStatusUpdate = ({ fieldToUpdate, newStatus }) => {
    if (fieldToUpdate === 'KYC' && validKycStatus.indexOf(newStatus) >= 0) {
        return true;
    }

    if (fieldToUpdate === 'STATUS' && validUserStatus.indexOf(newStatus) >= 0) {
        return true;
    }

    if (fieldToUpdate === 'REGULATORY' && validRegulatoryStatus.indexOf(newStatus) >= 0) {
        return true;
    }

    return false;
};

const handleStatusUpdate = async ({ adminUserId, systemWideUserId, fieldToUpdate, newStatus, reasonToLog }, lambda, publisher) => {
    const statusPayload = { systemWideUserId, initiator: adminUserId };
    
    if (fieldToUpdate === 'KYC') {
        statusPayload.updatedKycStatus = {
            changeTo: newStatus,
            reasonToLog
        };
    } 
    
    if (fieldToUpdate === 'STATUS') {
        statusPayload.updatedUserStatus = {
            changeTo: newStatus,
            reasonToLog
        };
    }

    if (fieldToUpdate === 'REGULATORY') {
        statusPayload.updatedRegulatoryStatus = {
            changeTo: newStatus,
            reasonToLog
        };
    }

    const updateInvoke = adminUtil.invokeLambda(config.get('lambdas.statusUpdate'), statusPayload);
    const updateResult = await lambda.invoke(updateInvoke).promise();
    logger('Result from status update Lambda: ', updateResult);
    const updatePayload = JSON.parse(updateResult['Payload']);
    
    const returnResult = updatePayload.statusCode === 200
        ? { result: 'SUCCESS', updateLog: JSON.parse(updatePayload.body) }
        : { result: 'FAILURE', message: JSON.parse(updatePayload.body) };

    logger('Returning result: ', returnResult);

    // then these ones are special
    const statusForUserLog = ['VERIFIED_AS_PERSON', 'FAILED_VERIFICATION', 'FLAGGED_FOR_REVIEW', 'REVIEW_CLEARED', 'REVIEW_FAILED'];
    if (statusForUserLog.includes(newStatus)) {
        const logOptions = { 
            initiator: adminUserId,
            context: { reasonToLog } 
        };
        logger('Status triggers user log, so fire off');
        await publisher.publishUserEvent(systemWideUserId, newStatus, logOptions);
    }

    return returnResult;
};

// see note in user-events handling re swapping out for dependency injection, but for present this is enough
module.exports.processStatusUpdate = async ({ params, lambda, publisher }) => {
    logger('Updating user status, validate types and return okay');
    if (!validateStatusUpdate(params)) {
        return opsCommonUtil.wrapResponse('Error, bad field or type for user update', 400);
    }
    return handleStatusUpdate(params, lambda, publisher);
};

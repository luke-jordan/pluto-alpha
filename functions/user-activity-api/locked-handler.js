'use strict';

const logger = require('debug')('jupiter:locked-saves:main');
const config = require('config');
const moment = require('moment');

const persistence = require('./persistence/rds');
const dynamo = require('./persistence/dynamodb');

const opsUtil = require('ops-util-common');
const publisher = require('publish-common');

const interestHelper = require('./interest-helper');

// Finds lowest "days" key in lockedSaveBonus that is smaller than passed in "days" and 
// returns the multiplier associated with the days found.
const roundDays = (days, lockedSaveBonus) => {
    const availableDays = Object.keys(lockedSaveBonus).filter((duration) => duration < days);
    if (!availableDays || availableDays.length === 0) {
        return config.get('defaults.lockedSaveMultiplier');
    }

    const roundedDays = Math.max(...availableDays);
    return lockedSaveBonus[roundedDays];
};

const mapLockedSaveDaysToInterest = (lockedSaveBonus, accrualRate, daysToPreview) => {
    const lockedSaveInterestMap = daysToPreview.map((days) => {
        if (opsUtil.isObjectEmpty(lockedSaveBonus)) {
            return { [days]: config.get('defaults.lockedSaveMultiplier') * accrualRate };
        }

        if (Object.keys(lockedSaveBonus).includes(days.toString())) {
            return { [days]: lockedSaveBonus[days] * accrualRate };
        }

        return { [days]: roundDays(days, lockedSaveBonus) * accrualRate };
    });

    return lockedSaveInterestMap;
};

const calculateBonusForLockedSave = (lockedSaveInterestMap, baseAmount) => {
    const resultOfCalculation = lockedSaveInterestMap.map((daysAndInterest) => {
        const interestRate = Object.values(daysAndInterest)[0];
        const daysToCalculate = Object.keys(daysAndInterest)[0];
        const calculatedInterestEarned = interestHelper.calculateEstimatedInterestEarned({ ...baseAmount, daysToCalculate }, 'HUNDREDTH_CENT', interestRate);
        return { [daysToCalculate]: calculatedInterestEarned };
    });

    return resultOfCalculation;
};

/**
 * Calculates the locked saved bonus for each duration passed in the daysToPreview array.
 * Returns the projected interest exclusive of the user balance.
 * @param {object} event 
 * @property {string} floatId The float from which to read the accrual rate and locked save multipliers.
 * @property {string} clientId The client id used in conjunction with the float id above from which to read the relevant client-float vars.
 * @property {string} baseAmount An amount dict on which to perform the interest projections.
 * @property {array} daysToPreview The number of days to project locked save interest on. Multiple days may be passed in.
 */
module.exports.previewBonus = async (event) => {
    try {
        if (opsUtil.isObjectEmpty(event)) {
            return { statusCode: 400, body: 'Empty invocation' };
        }

        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails || !Reflect.has(userDetails, 'systemWideUserId')) {
            return { statusCode: 403 };
        }

        const { clientId, floatId, baseAmount, daysToPreview } = opsUtil.extractParamsFromEvent(event);
        logger('Previewing locked save bonus for client id: ', clientId, ' and float id: ', floatId);

        const { accrualRateAnnualBps, lockedSaveBonus } = await dynamo.fetchFloatVarsForBalanceCalc(clientId, floatId);
        logger('Got accrual rate: ', accrualRateAnnualBps, 'And locked save bonus details: ', lockedSaveBonus);

        const lockedSaveInterestMap = mapLockedSaveDaysToInterest(lockedSaveBonus, accrualRateAnnualBps, daysToPreview);
        logger('Mapped days to preview to corresponding multipliers: ', lockedSaveInterestMap);

        const calculatedLockedSaveBonus = calculateBonusForLockedSave(lockedSaveInterestMap, baseAmount);
        logger('Calculated locked save bonus for receive days: ', calculatedLockedSaveBonus);
        
        const resultObject = calculatedLockedSaveBonus.reduce((obj, daysBonusMap) => ({ ...obj, ...daysBonusMap }), {});
        logger('Returning final result: ', resultObject);

        return opsUtil.wrapResponse(resultObject);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};

const isValidTxForLock = (transactionToLock) => {
    if (transactionToLock.transactionType !== 'USER_SAVING_EVENT') {
        logger('Attempted to lock a non-saving event, exiting');
        return false;
    }

    if (transactionToLock.settlementStatus !== 'SETTLED') {
        logger('Attempted to lock a non-settled transaction, exiting');
        return false;
    }

    return true;
};

const isUserTxAccountOwner = async (systemWideUserId, transactionToLock) => {
    const userAccountIds = await persistence.findAccountsForUser(systemWideUserId);
    logger('Got account ids for user: ', userAccountIds);
    
    if (!userAccountIds.includes(transactionToLock.accountId)) {
        logger('User is not account owner, exiting');
        return false;
    }

    return true;
};

/**
 * 
 * @param {object} event 
 * @property {string} transactionId
 * @property {object} lockBonusAmount
 * @property {number} daysToLock
 */
module.exports.lockSettledSave = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
            return { statusCode: 403 };
        }
    
        const { systemWideUserId } = opsUtil.extractUserDetails(event);
        const { transactionId, lockBonusAmount, daysToLock } = opsUtil.extractParamsFromEvent(event);
    
        const transactionToLock = await persistence.fetchTransaction(transactionId);
        logger('Got transaction: ', transactionToLock);

        if (!transactionToLock) {
            logger('No transaction found for received transaction id, exiting');
            return { statusCode: 400 };
        }
    
        if (opsUtil.isApiCall(event)) {
            const isValidUser = await isUserTxAccountOwner(systemWideUserId, transactionToLock);
            if (!isValidUser) {
                return { statusCode: 403 };
            }
        }

        if (!isValidTxForLock(transactionToLock)) {
            return { statusCode: 400 };
        }
    
        const resultOfLock = await persistence.lockTransaction(transactionToLock, lockBonusAmount, daysToLock);
        logger('Result of lock: ', resultOfLock);

        const updatedTime = moment(resultOfLock.updatedTime);
        
        const logOptions = {
            initiator: systemWideUserId,
            timestamp: updatedTime.valueOf(),
            context: {
                transactionId,
                accountId: transactionToLock.accountId,
                transactionType: transactionToLock.transactionType,
                oldTransactionStatus: transactionToLock.settlementStatus,
                newTransactionStatus: 'LOCKED',
                lockDurationDays: daysToLock,
                lockBonusAmount
            }
        };
    
        await publisher.publishUserEvent(systemWideUserId, 'USER_LOCKED_SAVE', logOptions);

        return opsUtil.wrapResponse({ result: 'SUCCESS' });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};

/**
 * 
 * @param {object} event 
 */
// module.exports.checkForExpiredLocks = async (event) => {

// };
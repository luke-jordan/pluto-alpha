'use strict';

const logger = require('debug')('jupiter:locked-saves:main');
const config = require('config');
const moment = require('moment');

const persistence = require('./persistence/rds');
const dynamo = require('./persistence/dynamodb');

const opsUtil = require('ops-util-common');
const publisher = require('publish-common');

const interestHelper = require('./interest-helper');

const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });

const lambda = new AWS.Lambda();

const extractLambdaBody = (lambdaResult) => JSON.parse(JSON.parse(lambdaResult['Payload']).body);

const wrapLambdaInvocation = (payload, nameKey, sync = true) => ({
    FunctionName: config.get(`lambdas.${nameKey}`),
    InvocationType: sync ? 'RequestResponse' : 'Event',
    Payload: JSON.stringify(payload)
});

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
 * Returns the projected interest exclusive of the user's balance.
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

const fetchUserProfile = async (systemWideUserId) => {
    const profileFetchInvocation = wrapLambdaInvocation({ systemWideUserId }, 'fetchProfile');
    const profileFetchResult = await lambda.invoke(profileFetchInvocation).promise();
    logger('Result of profile fetch: ', profileFetchResult);

    return extractLambdaBody(profileFetchResult);
};

const createBoostForLockedTx = async (systemWideUserId, transactionId, lockBonusAmount, daysToLock) => {
    const { clientId, defaultFloatId } = await fetchUserProfile(systemWideUserId);
    logger('Got user client and float id: ', { clientId, defaultFloatId });

    const { bonusPoolSystemWideId } = await dynamo.fetchFloatVarsForBalanceCalc(clientId, defaultFloatId);
    logger('Got bonus pool id: ', bonusPoolSystemWideId);

    const boostSource = { clientId, floatId: defaultFloatId, bonusPoolId: bonusPoolSystemWideId };

    const boostAudienceSelection = {
        conditions: [
            { op: 'in', prop: 'systemWideUserId', value: [systemWideUserId] }
        ]
    };

    // Sets boost to expire soon after lock expires, giving scheduled job time to redeem
    const boostExpiryDays = daysToLock + config.get('defaults.lockedSaveBoostExpiryDays');
    const boostExpiryTime = moment().add(boostExpiryDays, 'days').valueOf();

    const lockExpiryTimeMillis = moment().add(daysToLock, 'days').valueOf();

    const boostPayload = {
        creatingUserId: systemWideUserId,
        label: 'Locked Save Boost',
        boostTypeCategory: 'LOCKED::SIMPLE_LOCK',
        boostAmountOffered: opsUtil.convertAmountDictToString(lockBonusAmount),
        boostBudget: lockBonusAmount.amount,
        boostSource,
        endTimeMillis: boostExpiryTime,
        boostAudienceType: 'INDIVIDUAL',
        boostAudienceSelection,
        initialStatus: 'PENDING',
        statusConditions: {
            REDEEMED: [`lock_save_expires #{${transactionId}::${lockExpiryTimeMillis}}`]
        }
    };

    const boostInvocation = wrapLambdaInvocation(boostPayload, 'createBoost', false);

    logger('Invoking lambda with payload: ', boostPayload);
    const resultOfInvocation = await lambda.invoke(boostInvocation).promise();
    logger('Result of firing off lambda invoke: ', resultOfInvocation);

    return { result: 'BOOST_CREATED' };
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
 * The function locks save transactions whose settlement status is SETTLED and creates a boost that
 * will be triggered when the lock expires.
 * @param {object} event An admin, user, http, or direct invocation event.
 * @property {string} transactionId The identifier of the transaction to be locked.
 * @property {object} lockBonusAmount A standard amount dict, the boost amount to be awarded to the user after the lock expired
 * @property {number} daysToLock The number of days to lock the transaction.
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
    
        const resultOfLock = await persistence.lockTransaction(transactionToLock, daysToLock);
        logger('Result of lock: ', resultOfLock);

        const updatedTime = moment(resultOfLock.updatedTime);

        const resultOfBoost = await createBoostForLockedTx(systemWideUserId, transactionId, lockBonusAmount, daysToLock);
        logger('Result of boost creation for locked tx: ', resultOfBoost);
        
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

const publishLockExpired = async (unlockedTx) => {
    const logOptions = {
        initiator: unlockedTx.ownerUserId,
        timestamp: moment().valueOf(),
        context: {
            transactionId: unlockedTx.transactionId,
            oldTransactionStatus: 'LOCKED',
            newTransactionStatus: 'SETTLED'
        }
    };

    return publisher.publishUserEvent(unlockedTx.ownerUserId, 'LOCK_EXPIRED', logOptions);
};

/**
 * Scheduled job for removing expired locks from transactions.
 * @param {object} event 
 */
module.exports.checkForExpiredLocks = async (event) => {
    try {
        logger('Expired lock handler received event: ', event);

        const lockedTransactions = await persistence.fetchExpiredLockedTransactions();
        logger('Expired locks: ', lockedTransactions);

        if (lockedTransactions.length === 0) {
            logger('No expired tx locks found, exiting');
            return { statusCode: 200 };
        }

        const transactionIds = lockedTransactions.map((transaction) => transaction.transactionId);
        const unlockedTxIds = await persistence.unlockTransactions(transactionIds);
        logger('Result of expired lock removal: ', unlockedTxIds);

        const unlockedTransactions = lockedTransactions.filter((tx) => unlockedTxIds.includes(tx.transactionId));

        await Promise.all(unlockedTransactions.map((unlockedTx) => publishLockExpired(unlockedTx)));
        return opsUtil.wrapResponse({ result: 'SUCCESS' });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ message: err.message }, 500);
    }
};

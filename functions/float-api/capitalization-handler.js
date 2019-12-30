'use strict';

const logger = require('debug')('jupiter:float:capitalize');
const config = require('config');
const moment = require('moment');

const opsUtil = require('ops-util-common');
const constants = require('./constants');

const dynamo = require('./persistence/dynamodb');
const rds = require('./persistence/rds');

const BigNumber = require('bignumber.js');

const DEFAULT_UNIT = constants.floatUnits.DEFAULT;

const getLastCapitalizationTime = async (clientId, floatId, dateTimeCutOff) => {
    const floatLogParams = { clientId, floatId, logType: 'CAPITALIZATION_EVENT', endTime: dateTimeCutOff };
    const lastFloatLogBeforeYield = await rds.fetchLastLog(floatLogParams);
    if (!lastFloatLogBeforeYield || opsUtil.isObjectEmpty(lastFloatLogBeforeYield)) {
        return moment(0);
    }
    return moment(lastFloatLogBeforeYield.referenceTime);
};

// returns a map of how much to distribute to all of the accounts, together with information about discrepancies to the prior accruals
// this is the core method, alongside fetchAccrualsInPeriod -- it is where the heart of the capitalization logic sits
// returns a map (since this will in time get very large) keyed to account/entity IDs, with info about them, and the amounts to credit
const divideCapitalizationPerAccruals = async ({ clientId, floatId, startTime, endTime, capitalizedAmount, floatConfigVars }) => {
    
    const { unit, currency } = capitalizedAmount;
    const bonusPoolId = floatConfigVars.bonusPoolTracker;
    
    const accrualMap = await rds.fetchAccrualsInPeriod({ floatId, clientId, startTime, endTime, unit, currency });

    const totalAccrued = Array.from(accrualMap.values()).reduce((sum, entry) => entry.amountAccrued + sum, 0);
    
    // since we have passed unit and currency to rds method, these are in matching units
    logger('About to divide up capitalized amount: ', capitalizedAmount);
    const distributionPaid = capitalizedAmount.amount;
    const remainderUnaccrued = distributionPaid - totalAccrued;
    logger(`Total accrued: ${totalAccrued}, vs distribution paid: ${distributionPaid}, so remainder: ${remainderUnaccrued}, with bonus pool: `);

    const allocations = new Map();
    
    const accruedBigNumber = new BigNumber(totalAccrued); // used below
    const remainderBigNumber = new BigNumber(remainderUnaccrued); // and the same

    // for each entity in the accrual fetch result, we calculate an amount equal to their total accrual, plus a relevant share
    // of the excess. if there is a deficiency, it all gets taken from the bonus pool (as per our general principle)
    accrualMap.forEach((entityDetails, entityId) => {
        let amountToCredit = entityDetails.amountAccrued;
        if (remainderUnaccrued > 0) { // comes out of the bonus pool, which is the excess/overflow absorber
            const shareOfAllAccrual = new BigNumber(entityDetails.amountAccrued).dividedBy(accruedBigNumber);
            const amountToAdd = remainderBigNumber.times(shareOfAllAccrual);
            amountToCredit += amountToAdd.integerValue().toNumber();
        } else if (remainderUnaccrued < 0 && entityDetails.entityType === constants.entityTypes.BONUS_POOL && entityId === bonusPoolId) {
            amountToCredit += remainderUnaccrued; // since this is negative
        }
        const entityWithAmount = { ...entityDetails, amountToCredit };
        allocations.set(entityId, entityWithAmount);
    });
    logger('Allocations so far, saple: ', Array.from(allocations.values()).slice(0, 2));

    // then we do a last check just in case one or two hundredths of a cent left over due to rounding
    const whollyAllocatedAmount = Array.from(allocations.values()).reduce((sum, entry) => entry.amountToCredit + sum, 0);
    if (whollyAllocatedAmount !== distributionPaid) {
        logger(`Rounding : check : after division, still mismatch, distribution paid: ${distributionPaid}, wholly allocated: ${whollyAllocatedAmount}`);
        const currentBonusEntity = allocations.get(bonusPoolId);
        const adjustedBonusAmount = currentBonusEntity.amountToCredit + (distributionPaid - whollyAllocatedAmount);
        const revisedBonusEntry = { ...currentBonusEntity, amountToCredit: adjustedBonusAmount };
        allocations.set(bonusPoolId, revisedBonusEntry);
    }

    const metadata = { unit, currency, totalYield: capitalizedAmount.amount, totalAccrued };

    return { allocations, metadata };
};

const assembleSummaryData = (allocations, floatConfigVars, metadata) => {
    const nonAccountAllocations = 2; // bonus pool and company (may need to calculate in future)
    const numberAccountsToBeCredited = allocations.size - nonAccountAllocations;
    const { bonusPoolTracker, clientCoShareTracker } = floatConfigVars;
    const amountToCreditClient = allocations.get(clientCoShareTracker).amountToCredit;
    const amountToCreditBonusPool = allocations.get(bonusPoolTracker).amountToCredit;

    const excessOverPastAccrual = metadata.totalYield - metadata.totalAccrued;

    return {
        numberAccountsToBeCredited,
        amountToCreditClient,
        amountToCreditBonusPool,
        excessOverPastAccrual,
        unit: metadata.unit,
        currency: metadata.currency
    };
};

const turnAllocationIntoPreview = (allocation) => ({
    accountId: allocation.accountId,
    accountName: allocation.humanRef,
    unit: DEFAULT_UNIT,
    currency: allocation.currency,
    priorBalance: allocation.priorSettledBalance,
    priorAccrued: allocation.amountAccrued,
    amountToCredit: allocation.amountToCredit
});

// const turnAllocationIntoPersistenceInstruction = (allocation) => {
// };

/**
 * Allows admin to review the operation before committing it. Conducts all the calculations and then returns the top level
 * results plus a sample of the transactions
 */
module.exports.preview = async (params) => {
    logger('Processing capitalization preview, parameters: ', params);
    const { clientId, floatId, dateTimePaid, yieldPaid, currency } = params;
    
    const endTime = moment(dateTimePaid);
    const startTime = await getLastCapitalizationTime(clientId, floatId, endTime);
    logger(`Obtained start time: ${startTime.format()} and end time: ${endTime.format()}`);

    const floatConfigVars = await dynamo.fetchConfigVarsForFloat(clientId, floatId);

    const passedUnit = params.unit;
    const convertedAmount = opsUtil.convertToUnit(yieldPaid, passedUnit, DEFAULT_UNIT);

    const capitalizedAmount = { amount: convertedAmount, unit: DEFAULT_UNIT, currency };
    const { allocations, metadata } = await divideCapitalizationPerAccruals({ clientId, floatId, startTime, endTime, capitalizedAmount, floatConfigVars });

    logger('Completed dividing up yield, meta results: ', metadata);
    const previewPackage = assembleSummaryData(allocations, floatConfigVars, metadata);
    logger('Presample, preview package: ', previewPackage);

    const numberToSample = config.get('capitalization.preview.accountsToSample');
    // note: as per lots discussion on SO, this is not truly random (will bias towards early in list), but we don't need truly random
    // what it does is to pseudo-randomly (as per caveat) shuffle the array and then take a slice from it
    const randomSample = Array.from(allocations.values()).
        filter((entity) => entity.entityType === constants.entityTypes.END_USER_ACCOUNT).
        sort(() => 0.5 - Math.random()).slice(0, numberToSample);

    logger('Random sample: ', randomSample);
    const previewAccounts = randomSample.map((allocation) => turnAllocationIntoPreview(allocation));
    // logger('Generated random sample for preview, first: ', previewAccounts[0]);
    previewPackage.sampleOfTransactions = previewAccounts;

    return previewPackage;
};

module.exports.confirm = async (params) => {
    logger('Confirming capitalization, with parameters: ', params);
};

module.exports.handle = async (event) => {

    const { operation, parameters } = event;
    if (operation === 'PREVIEW') {
        return exports.preview(parameters);
    } else if (operation === 'CONFIRM') {
        return exports.confirm(parameters);
    }

    logger('FATAL_ERROR: Unsupported operation: event: ', event);
    return { statusCode: 500, body: 'ERROR: Unsupported operation' };
};
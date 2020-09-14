'use strict';

const logger = require('debug')('jupiter:locked-saves:main');
const config = require('config');

const opsUtil = require('ops-util-common');
const dynamo = require('./persistence/dynamodb');

const interestHelper = require('./interest-helper');

// Finds lowest "days" key in lockedSaveBonus that is smaller than passed in "days" and 
// returns the multipler associated with the days found.
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

const calculateBonusForLockedSave = (lockedSaveInterestMap, amountDetails) => {
    const resultOfCalculation = lockedSaveInterestMap.map((daysAndInterest) => {
        const interestRate = Object.values(daysAndInterest)[0];
        const daysToCalculate = Object.keys(daysAndInterest)[0];
        const calculatedInterestEarned = interestHelper.calculateEstimatedInterestEarned({ ...amountDetails, daysToCalculate }, 'HUNDREDTH_CENT', interestRate);
        return { [daysToCalculate]: calculatedInterestEarned };
    });

    return resultOfCalculation;
};

/**
 * Calculates the locked saved bonus for each duration passed in the daysToPreview array.
 * @param {object} event 
 * @property {string} floatId The float from which to read the accrual rate and locked save multipliers.
 * @property {string} clientId The client id used in conjunction with the float id above from which to read the relevant client-float vars.
 * @property {string} amountDetails An amount dict on which to perform the interest projections.
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

        const { clientId, floatId, amountDetails, daysToPreview } = opsUtil.extractParamsFromEvent(event);
        logger('Previewing locked save bonus for client id: ', clientId, ' and float id: ', floatId);

        const { accrualRateAnnualBps, lockedSaveBonus } = await dynamo.fetchFloatVarsForBalanceCalc(clientId, floatId);
        logger('Got accrual rate: ', accrualRateAnnualBps, 'And locked save bonus details: ', lockedSaveBonus);

        const lockedSaveInterestMap = mapLockedSaveDaysToInterest(lockedSaveBonus, accrualRateAnnualBps, daysToPreview);
        logger('Mapped days to preview to corresponding multipliers: ', lockedSaveInterestMap);

        const calculatedLockedSaveBonus = calculateBonusForLockedSave(lockedSaveInterestMap, amountDetails);
        logger('Calculated locked save bonus for recieved days: ', calculatedLockedSaveBonus);
        
        const resultObject = calculatedLockedSaveBonus.reduce((obj, daysAndInterest) => ({ ...obj, ...daysAndInterest }), {});
        logger('Returning final result: ', resultObject);

        return opsUtil.wrapResponse(resultObject);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};

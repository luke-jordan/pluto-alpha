'use strict';

// separating this out as it involves quite a bit of logic and will probably expand in time
const logger = require('debug')('jupiter:admin:scheduled');

const rdsFloat = require('./persistence/rds.float');
const dynamoFloat = require('./persistence/dynamo.float');

const opsUtil = require('ops-util-common');

const compareInCurrency = (balanceInfoA, labelA, balanceInfoB, labelB, currency) => {
    const backupAmount = { amount: 0, unit: 'HUNDREDTH_CENT' };
    const balanceA = balanceInfoA[currency] || backupAmount;
    const balanceB = balanceInfoB[currency] || backupAmount;

    const equalizedA = opsUtil.convertToUnit(balanceA.amount, balanceA.unit, 'HUNDREDTH_CENT');
    const equalizedB = opsUtil.convertToUnit(balanceB.amount, balanceB.unit, 'HUNDREDTH_CENT');
    logger(`Comparing float balance of ${equalizedA} and sum of allocations ${equalizedB}`);
    if (equalizedA === equalizedB) {
        return null;
    }

    return {
        mismatch: equalizedA - equalizedB,
        [labelA]: equalizedA,
        [labelB]: equalizedB,
        currency,
        unit: 'HUNDREDTH_CENT'
    };
};

const filterArrayForNonNull = (objectArray) => {
    if (!Array.isArray(objectArray) || objectArray.length === 0) {
        return [];
    }
    return objectArray.filter((object) => typeof object === 'object' && object !== null && Object.keys(object).length > 0);
};

const doesArrayHaveNonNull = (objectArray) => filterArrayForNonNull(objectArray).length > 0;

const checkClientFloatForAnomaly = async (clientFloatInfo) => {
    const { clientId, floatId } = clientFloatInfo;
    
    // the core entity; anomaly types are keys, with an array of detected anomalies containing info
    const anomalies = { };

    const floatBalanceMap = await rdsFloat.getFloatBalanceAndFlows([floatId]);
    logger('Balance map for floats: ', floatBalanceMap);
    const floatBalances = floatBalanceMap.get(floatId);
    const floatCurrencies = Object.keys(floatBalances);

    // first check for allocated to float (i.e., float total) and allocated to others not being the same
    const floatAllocations = await rdsFloat.getFloatAllocatedTotal(clientId, floatId);
    logger('Allocation sums: ', floatAllocations);

    // do this for each currency found in the float (just so we are properly future-proofing)
    anomalies['BALANCE_MISMATCH'] = floatCurrencies.
        map((currency) => compareInCurrency(floatBalances, 'floatBalance', floatAllocations, 'floatAllocations', currency));
    
    // then check for allocated to users from float and settled transactions for users not being the same
    const { floatAccountTotal, accountTxTotal } = await rdsFloat.getUserAllocationsAndAccountTxs(clientId, floatId);
    
    anomalies['ALLOCATION_TOTAL_MISMATCH'] = floatCurrencies.
        map((currency) => compareInCurrency(floatAccountTotal, 'floatAccountsTotal', accountTxTotal, 'accountsTxTotal', currency));
    
    // once live, check for FinWorks balance and our balance being different, use BALANCE_UNOBTAINABLE

    // take whatever differences exist, and insert logs (for the alerts), plus assemble a system email about them
    let anomalyLogs = [];
    Object.keys(anomalies).filter((anomalyLabel) => doesArrayHaveNonNull(anomalies[anomalyLabel])).forEach((anomalyLabel) => {
        const anomaliesToLog = filterArrayForNonNull(anomalies[anomalyLabel]);
        const thisAnomalyLogs = anomaliesToLog.map((mismatch) => ({ clientId, floatId, logType: anomalyLabel, logContext: mismatch }));
        logger('Adding: ', thisAnomalyLogs);
        anomalyLogs = anomalyLogs.concat(thisAnomalyLogs);
    });
    
    logger('Anomaly logs to insert: ', anomalyLogs);
    // remove duplicates in the last 24 hours

    const resultOfLogInserts = await Promise.all(anomalyLogs.map((logDef) => rdsFloat.insertFloatLog(logDef)));
    logger('Result of anomaly log insertion: ', resultOfLogInserts);
    return anomalyLogs.length > 0 ? { result: 'ANOMALIES_FOUND', anomalies } : { result: 'NO_ANOMALIES' };
};

module.exports.checkAllFloats = async () => {
    const clientsAndFloats = await dynamoFloat.listClientFloats();
    const checkResults = await Promise.all(clientsAndFloats.map((clientAndFloat) => checkClientFloatForAnomaly(clientAndFloat)));
    logger('Result of anomaly checks: ', checkResults);
    return checkResults;
};

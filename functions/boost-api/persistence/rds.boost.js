'use strict';

const logger = require('debug')('jupiter:boosts:rds');
const config = require('config');
const uuid = require('uuid/v4');
const moment = require('moment');

const decamelize = require('decamelize');
const camelizeKeys = require('camelize-keys');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const accountsTable = config.get('tables.accountLedger');
const boostTable = config.get('tables.boostTable');
const boostAccountJoinTable = config.get('tables.boostAccountJoinTable');
const boostLogTable = config.get('tables.boostLogTable');

const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}}`).join(', ');
const extractQueryClause = (keys) => keys.map((key) => decamelize(key)).join(', ');

const extractArrayIndices = (array, startingIndex = 1) => array.map((_, index) => `$${index + startingIndex}`).join(', ');

const transformBoostFromRds = (boost) => {
    const transformedBoost = camelizeKeys(boost);
    // logger('Working? : ', transformedBoost);
    transformedBoost.messageInstructions = transformedBoost.messageInstructionIds.instructions;
    // transformedBoost.statusConditions = JSON.parse(transformedBoost.statusConditions);
    transformedBoost.boostStartTime = moment(transformedBoost.startTime);
    transformedBoost.boostEndTime = moment(transformedBoost.endTime);
    transformedBoost.defaultStatus = transformedBoost.initialStatus;

    // then clean up
    Reflect.deleteProperty(transformedBoost, 'messageInstructionIds');
    Reflect.deleteProperty(transformedBoost, 'startTime');
    Reflect.deleteProperty(transformedBoost, 'endTime');
    Reflect.deleteProperty(transformedBoost, 'initialStatus');

    return transformedBoost;
};

module.exports.fetchBoost = async (boostId) => {
    const rawResult = await rdsConnection.selectQuery(`select * from ${boostTable} where boost_id = $1`, [boostId]);
    return rawResult.length === 0 ? null : camelizeKeys(rawResult[0]);
};

/**
 * Method that finds boost that may be relevant to a given account, filtering by whether the account is in a certain state related to the boost.
 * Most common use will be to find the boosts for which a given account (e.g., that just saved) is in a 'PENDING STATE'
 * Returns the found boosts transformed into the shape that the services logic uses. Takes a dict of attributes, with the following components:
 * @param {array} accountId An array (can be single element) of the account Ids relevant to the query
 * @param {array} status An array of the statuses that the account must be in for the boost to be relevant (e.g., pending).
 */
module.exports.findBoost = async (attributes) => {
    const accountPortion = { values: [], indices: [] };
    attributes.accountId.forEach((accountId, index) => { 
        accountPortion.values.push(accountId);
        accountPortion.indices.push(index + 1);
    });
    const numberAccount = accountPortion.indices.length;
    const statusPortion = { values: [], indices: [] };
    attributes.boostStatus.forEach((status, index) => {
        statusPortion.values.push(status);
        statusPortion.indices.push(numberAccount + index + 1);
    });
    
    const accountIndices = accountPortion.indices.map((index) => `$${index}`).join(', ');
    const statusIndices = statusPortion.indices.map((index) => `$${index}`).join(', ');
    
    const queryValues = accountPortion.values.concat(statusPortion.values);
    
    const findBoostQuery = `select distinct(boost_id) from ${boostAccountJoinTable} where account_id in ` + 
        `(${accountIndices}) and boost_status in (${statusIndices})`;
    const findBoostIdsResult = await rdsConnection.selectQuery(findBoostQuery, queryValues);
    logger('Result of finding boost IDs: ', findBoostIdsResult);
    if (findBoostIdsResult.length === 0) {
        return [];
    }

    // theoretically, it would be better to do the selection for under budget using a join & sum at the instant, as otherwise
    // there might be some race conditions, given the lag between selection here and the update later, but 
    // (1) the chances are going to be small until truly large scale, at which point a lot of things in here 
    // will have to be rewritten anyway, and (2) the orders of magnitude between individual boost amounts and
    // the total budget mean any such overflow will be tiny in proportion, and (3) the query required to do
    // it in a perfectly normalized, no-race-at-all way would be a monster, and likely fragile. Hence.
    // todo : on the other hand, the above and below do seem like a fairly trivial join query waiting to be written

    const boostIdArray = findBoostIdsResult.map((row) => row['boost_id']);
    let querySuffix = '';

    if (typeof attributes.active === 'boolean') {
        querySuffix = `${querySuffix} and active = ${attributes.active}`;
    }
    if (attributes.underBudgetOnly) {
        querySuffix = `${querySuffix} and boost_redeemed < boost_budget`;
    }
    
    const retrieveBoostQuery = `select * from ${boostTable} where boost_id in (${extractArrayIndices(boostIdArray)})${querySuffix}`;
    
    const boostsRetrieved = await rdsConnection.selectQuery(retrieveBoostQuery, boostIdArray);
    logger('Result of retrieving boosts: ', boostsRetrieved);

    return boostsRetrieved.map(transformBoostFromRds);
};

module.exports.fetchUncreatedActiveBoostsForAccount = async (accountId) => {
    const findBoostQuery = `select distinct(boost_id) from ${boostTable} where active = true and end_time > current_time ` +
        `and boost_id not in (select boost_id from ${boostAccountJoinTable} where account_id = $1)`; 

    const queryValues = [accountId];

    const boostsRetrieved = await rdsConnection.selectQuery(findBoostQuery, queryValues);
    logger('Retrived boosts:', boostsRetrieved);
    if (boostsRetrieved.length === 0) {
        return [];
    }

    return boostsRetrieved.map(transformBoostFromRds);
};

/** 
 * Method that finds the account IDs and user IDs in a given state for a list of boosts. Requires at least one boost ID is provided, as well as at 
 * least one of a status or a list of accountIDs. If passed a list of account IDs, it returns all those accounts relevant to the boost, along with 
 * their userID and current status for the boost. If passed a status, it returns all account IDs and user IDs in that status for the boost. Returns 
 * these in a dict, with the boost ID specified (for processing thereafter) and an account - user - status map, keyed by account ID
 * @param {array} boostId A list of boost IDs for the query. Can be just a single element
 * @param {array} accountId A list of account IDs to filter by
 * @param {array} status A list of statuses that the account IDs must be in 
 */
module.exports.findAccountsForBoost = async ({ boostIds, accountIds, status }) => {
    // todo : validation, etc. (lots)
    const queryBase = `select boost_id, ${accountsTable}.account_id, owner_user_id, boost_status from ${boostAccountJoinTable} ` +
        `inner join ${accountsTable} on ${boostAccountJoinTable}.account_id = ${accountsTable}.account_id`;

    let querySuffix = `where boost_id in (${extractArrayIndices(boostIds)})`;
    let runningIndex = boostIds.length + 1;
    let runningValues = [].concat(boostIds);
    
    if (accountIds) {
        querySuffix = `${querySuffix} and ${accountsTable}.account_id in (${extractArrayIndices(accountIds, runningIndex)})`;
        runningValues = runningValues.concat(accountIds);
        runningIndex += accountIds.length;
    }

    if (status) {
        querySuffix = `${querySuffix} and boost_status in (${extractArrayIndices(status, runningIndex)})`;
        runningValues = runningValues.concat(status);
        runningIndex += status.length;
    }

    const assembledQuery = `${queryBase} ${querySuffix} order by boost_id, account_id`;
    const resultOfQuery = await rdsConnection.selectQuery(assembledQuery, runningValues);
    logger('Received : ', resultOfQuery);

    if (resultOfQuery.length === 0) {
        throw new Error('Account id not found');
    }

    // now with the rows back, we piece together the appropriate object
    let rowIndex = 0;
    const resultObject = boostIds.map((boostId) => {
        const accountUserMap = { };
        while (rowIndex < resultOfQuery.length && resultOfQuery[rowIndex]['boost_id'] === boostId) {
            const currentRow = resultOfQuery[rowIndex];
            accountUserMap[currentRow['account_id']] = { 
                userId: currentRow['owner_user_id'],
                status: currentRow['boost_status']
            };
            rowIndex += 1;
        }
        return ({ boostId, accountUserMap });
    });
    logger('Assembled: ', resultObject);
    return resultObject;
};

// todo : validation / catching of status downgrade in here
const updateAccountDefinition = (boostId, accountId, newStatus) => ({
    table: boostAccountJoinTable,
    key: { boostId, accountId },
    value: { boostStatus: newStatus },
    returnClause: 'updated_time'
});

const constructLogDefinition = (columnKeys, rows) => ({
    query: `insert into ${boostLogTable} (${extractQueryClause(columnKeys)}) values %L returning log_id, creation_time`,
    columnTemplate: extractColumnTemplate(columnKeys),
    rows
});

/** 
 * @param {string} boostId The ID of the boost
 * @param {array} accountIds A list of the accounts whose status to update
 * @param {string} newStatus The status to which to update them. Note: 'redeemed' status cannot be returned to a lower status
 * @param {boolean} stillActive Whether the boost is still active. Note: if left out, the boost's active flag is not touched
 * @param {string} logType The boost log type to use for the logs that will be inserted
 * @param {object} logContext An optional object to insert along with the logs (e.g., recording the transaction ID)
 */
const processBoostUpdateInstruction = async ({ boostId, accountIds, newStatus, stillActive, logType, logContext }) => {
    const updateDefinitions = [];
    const logInsertDefinitions = [];
    
    // todo : make sure to only updates status upwards, to prevent corner case of false positive on one user triggered downward move on others
    if (Array.isArray(accountIds) && accountIds.length > 0) {
        logger('Handling account IDs: ', accountIds);
        const logRows = [];
        accountIds.forEach((accountId) => { 
            updateDefinitions.push(updateAccountDefinition(boostId, accountId, newStatus));
            logRows.push({ boostId, accountId, logType, logContext });
        });
        const columnKeys = ['boostId', 'accountId', 'logType', 'logContext']; // must do this as Object.keys has unreliable ordering
        logInsertDefinitions.push(constructLogDefinition(columnKeys, logRows));
    }

    if (typeof stillActive === 'boolean' && !stillActive) {
        const updateBoostTableDef = { 
            table: boostTable,
            key: { boostId },
            value: { active: stillActive },
            returnClause: 'updated_time'
        };
        updateDefinitions.push(updateBoostTableDef);
        const logRow = { boostId, logType: 'BOOST_DEACTIVATED' };
        logInsertDefinitions.push(constructLogDefinition(Object.keys(logRow), [logRow]));
    }

    let resultOfOperations = [];
    try {
        resultOfOperations = await rdsConnection.multiTableUpdateAndInsert(updateDefinitions, logInsertDefinitions);
        logger('Result from RDS: ', resultOfOperations);
    } catch (error) {
        logger(`Error updating boost ${boostId}: ${error.message}`);
        return { boostId, error: error.message };
    }

    const timesOfOperations = [];
    resultOfOperations.forEach((queryResult) => {
        queryResult.forEach((row) => {
            const rowHasUpdateTime = Reflect.has(row, 'updated_time');
            const latestTime = rowHasUpdateTime ? moment(row['updated_time']) : moment(row['creation_time']);
            timesOfOperations.push(latestTime);
        });
    });
    logger('And times of operations: ', resultOfOperations);

    // this sorts in descending, so latest is in first position
    const sortedArray = timesOfOperations.sort((timeA, timeB) => timeB.valueOf() - timeA.valueOf());
    logger('Sorted properly? : ', sortedArray);
    return { boostId, updatedTime: sortedArray[0] };
};

module.exports.updateBoostAccountStatus = async (instructions) => {
    // todo : swallow errors in single instruction, etc.
    const updatePromises = instructions.map((instruction) => processBoostUpdateInstruction(instruction));
    const resultOfAll = await Promise.all(updatePromises);
    logger('And all together: ', resultOfAll);
    return resultOfAll;
};

module.exports.updateBoostAmountRedeemed = async (boostIds) => {
    // get the sum; note the casting and use of a regex is necessary given the risk that otherwise
    // this could start erroring (and the slight decrease in speed is currently worth that robustness)
    const boostIdStartIdx = 2;
    const sumQuery = `select boost_id, sum(cast(log_context->>'boostAmount' as bigint)) from ` +
        `boost_data.boost_log where log_context ->> 'newStatus' = $1 and ` + 
        `log_context ->> 'boostAmount' ~ E'^\\\\d+$' and ` + 
        `boost_id in (${extractArrayIndices(boostIds, boostIdStartIdx)}) group by boost_id`;

    logger('Processing sum query: ', sumQuery);
    
    const values = ['REDEEMED', ...boostIds];    
    logger('With values: ', values);
    
    const resultOfCounts = await rdsConnection.selectQuery(sumQuery, values);
    logger('Result of counts: ', resultOfCounts);

    const countMap = resultOfCounts.reduce((obj, row) => ({...obj, [row['boost_id']]: row['sum']}), {});
    logger('Reduced to count map: ', countMap);

    const updateDefBase = { table: boostTable, returnClause: 'updated_time' };
    const updateDefs = boostIds.map((boostId) => ({
        ...updateDefBase,
        key: { boostId },
        value: { boostRedeemed: countMap[boostId] || 0 }
    }));
    
    logger('Updating boosts as follows: ', updateDefs);
    const resultOfUpdates = await rdsConnection.multiTableUpdateAndInsert(updateDefs, []);
    logger('Updated boost redeemed amounts, raw result: ', resultOfUpdates);

    return resultOfUpdates;
};

// ///////////////////////////////////////////////////////////////
// //////////// BOOST MEMBER SELECTION STARTS HERE ///////////////
// ///////////////////////////////////////////////////////////////

// todo : turn this into a single insert using freeFormInsert (on the other hand the subsequent insert below is one query, so not a huge gain)
const extractAccountIds = async (audienceId) => {
    const selectionQuery = `select account_id from ${config.get('tables.audienceJoinTable')} where audience_id = $1 and active = $2`;
    
    logger('Audience selection query: ', selectionQuery);
    const queryResult = await rdsConnection.selectQuery(selectionQuery, [audienceId, true]);
    logger('Number of records from query: ', queryResult.length);

    return queryResult.map((row) => row['account_id']);
};


// ///////////////////////////////////////////////////////////////
// //////////// BOOST PERSISTENCE STARTS HERE ///////////////
// ///////////////////////////////////////////////////////////////

module.exports.insertBoost = async (boostDetails) => {
    logger('Instruction received to insert boost: ', boostDetails);
    
    const accountIds = await extractAccountIds(boostDetails.audienceId);
    logger('Extracted account IDs for boost: ', accountIds);

    const boostId = uuid();
    const boostObject = {
        boostId: boostId,
        creatingUserId: boostDetails.creatingUserId,
        label: boostDetails.label,
        startTime: boostDetails.boostStartTime.format(),
        endTime: boostDetails.boostEndTime.format(),
        boostType: boostDetails.boostType,
        boostCategory: boostDetails.boostCategory,
        boostAmount: boostDetails.boostAmount,
        boostBudget: boostDetails.boostBudget,
        boostRedeemed: boostDetails.alreadyRedeemed || 0,
        boostUnit: boostDetails.boostUnit,
        boostCurrency: boostDetails.boostCurrency,
        fromBonusPoolId: boostDetails.fromBonusPoolId,
        fromFloatId: boostDetails.fromFloatId,
        forClientId: boostDetails.forClientId,
        boostAudienceType: boostDetails.boostAudienceType,
        audienceId: boostDetails.audienceId,
        statusConditions: boostDetails.statusConditions,
        messageInstructionIds: { instructions: boostDetails.messageInstructionIds }
    };

    if (boostDetails.conditionValues) {
        logger('This boost has conditions: ', boostDetails);
        boostObject.conditionValues = boostDetails.conditionClause;
    }

    if (boostDetails.gameParams) {
        boostObject.gameParams = boostDetails.gameParams;
    }

    // be careful here, array handling is a little more sensitive than most types in node-pg
    if (Array.isArray(boostDetails.flags) && boostDetails.flags.length > 0) {
        boostObject.flags = boostDetails.flags;
    }

    const boostKeys = Object.keys(boostObject);
    const boostQueryDef = {
        query: `insert into ${boostTable} (${extractQueryClause(boostKeys)}) values %L returning boost_id, creation_time`,
        columnTemplate: extractColumnTemplate(boostKeys),
        rows: [boostObject]
    };

    logger('Inserting boost: ', boostObject);

    const initialStatus = boostDetails.defaultStatus || 'CREATED'; // thereafter: OFFERED (when message sent), PENDING (almost done), COMPLETE
    const boostAccountJoins = accountIds.map((accountId) => ({ boostId, accountId, boostStatus: initialStatus }));
    const boostJoinQueryDef = {
        query: `insert into ${boostAccountJoinTable} (boost_id, account_id, boost_status) values %L returning insertion_id, creation_time`,
        columnTemplate: '${boostId}, ${accountId}, ${boostStatus}',
        rows: boostAccountJoins
    };

    // logger('Sending to insertion: ', boostQueryDef);

    const resultOfInsertion = await rdsConnection.largeMultiTableInsert([boostQueryDef, boostJoinQueryDef]);
    // logger('Insertion result: ', resultOfInsertion); // spews a lot of line

    // first query, first row, creation time
    const persistedTime = moment(resultOfInsertion[0][0]['creation_time']);

    const resultObject = {
        boostId: resultOfInsertion[0][0]['boost_id'],
        persistedTimeMillis: persistedTime.valueOf(),
        numberOfUsersEligible: resultOfInsertion[1].length,
        accountIds
    };

    logger('Returning: ', resultObject);
    return resultObject;

};

module.exports.insertBoostAccount = async (boostIds, accountId, boostStatus) => {
    const boostAccountJoins = boostIds.map((boostId) => ({ boostId, accountId, boostStatus }));
    const boostJoinQueryDef = {
        query: `insert into ${boostAccountJoinTable} (boost_id, account_id, boost_status) values %L returning insertion_id, creation_time`,
        columnTemplate: '${boostId}, ${accountId}, ${boostStatus}',
        rows: boostAccountJoins
    };

    const resultOfInsertion = await rdsConnection.largeMultiTableInsert([boostJoinQueryDef]);
    logger('Result of insertion:', resultOfInsertion);

    const persistedTime = moment(resultOfInsertion[0][0]['creation_time']);

    const resultObject = {
        persistedTimeMillis: persistedTime.valueOf(),
        accountId,
        boostIds
    };

    logger('Returning:', resultObject);
    return resultObject;
};

/**
 * Used to persist the message instructions, and to then set the boost to offered for those accounts
 */
module.exports.setBoostMessages = async (boostId, messageInstructionIdDefs, setAccountsToOffered) => {
    const updateValue = { messageInstructionIds: { instructions: messageInstructionIdDefs }}; 
    const boostUpdateDef = {
        table: boostTable,
        key: { boostId },
        value: updateValue,
        returnClause: 'updated_time'
    };

    const boostLog = {
        boostId, logType: 'BOOST_ALTERED', logContext: { value: updateValue }
    };
    const logDef = constructLogDefinition(Object.keys(boostLog), [boostLog]);    

    const resultOfUpdate = await rdsConnection.multiTableUpdateAndInsert([boostUpdateDef], [logDef]);
    logger('Result of update from RDS: ', resultOfUpdate);

    const updatedTime = moment(resultOfUpdate[0][0]['updated_time']);

    if (setAccountsToOffered) {
        const updateQuery = `update ${boostAccountJoinTable} set boost_status = $1 where boost_id = $2`;
        const resultOfStatusUpdate = await rdsConnection.updateRecord(updateQuery, ['OFFERED', boostId]);
        logger('Result of raw update: ', resultOfStatusUpdate);
        // strictly speaking we should also insert the boost logs, but this is only called during creation, so somewhat redundant (and could be expensive)
    }

    return { updatedTime };
};


module.exports.getAccountIdForUser = async (systemWideUserId) => {
    const tableName = config.get('tables.accountLedger');
    const query = `select account_id from ${tableName} where owner_user_id = $1 order by creation_time desc limit 1`;
    const accountRow = await rdsConnection.selectQuery(query, [systemWideUserId]);
    return Array.isArray(accountRow) && accountRow.length > 0 ? accountRow[0]['account_id'] : null;
};

// ///////////////////////////////////////////////////////////////
// ////// SIMPLE AUX METHOD TO FIND MSG INSTRUCTION IDS //////////
// ///////////////////////////////////////////////////////////////

module.exports.findMsgInstructionByFlag = async (msgInstructionFlag) => {
    // find the most recent matching the flag (just in case);
    const query = `select instruction_id from ${config.get('tables.msgInstructionTable')} where ` +
        `flags && ARRAY[$1] order by creation_time desc limit 1`;
    const result = await rdsConnection.selectQuery(query, [msgInstructionFlag]);
    logger('Got an instruction? : ', result);
    if (Array.isArray(result) && result.length > 0) {
        return result[0]['instruction_id'];
    }

    return null;
};

// ///////////////////////////////////////////////////////////////
// ////// ANOTHER SIMPLE AUX METHODS TO FIND OWNER IDS ///////////
// ///////////////////////////////////////////////////////////////

module.exports.findUserIdsForAccounts = async (accountIds) => {
    const query = `select distinct(owner_user_id) from ${config.get('tables.accountLedger')} where ` +
        `account_id in (${extractArrayIndices(accountIds)})`;
    const result = await rdsConnection.selectQuery(query, accountIds);
    if (Array.isArray(result) && result.length > 0) {
        return result.map((row) => row['owner_user_id']);
    }

    throw Error('Given non-existent or bad account IDs');
};

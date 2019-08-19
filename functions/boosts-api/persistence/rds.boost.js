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

const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}\}`).join(', ');
const extractQueryClause = (keys) => keys.map((key) => decamelize(key)).join(', ');

const extractArrayIndices = (array, startingIndex = 1) => array.map((_, index) => `$${index + startingIndex}`).join(', ');

const transformBoostFromRds = (boost) => {
    const transformedBoost = camelizeKeys(boost);
    // logger('Working? : ', transformedBoost);
    transformedBoost.redemptionMsgInstructions = transformedBoost.redemptionMessages.instructions;
    // transformedBoost.statusConditions = JSON.parse(transformedBoost.statusConditions);
    transformedBoost.boostAudienceSelection = transformedBoost.audienceSelection;
    transformedBoost.boostStartTime = moment(transformedBoost.startTime);
    transformedBoost.boostEndTime = moment(transformedBoost.endTime);
    transformedBoost.defaultStatus = transformedBoost.initialStatus;

    // then clean up
    Reflect.deleteProperty(transformedBoost, 'redemptionMessages');
    Reflect.deleteProperty(transformedBoost, 'audienceSelection');
    Reflect.deleteProperty(transformedBoost, 'startTime');
    Reflect.deleteProperty(transformedBoost, 'endTime');
    Reflect.deleteProperty(transformedBoost, 'initialStatus');

    return transformedBoost;
}

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
    
    const accountIndices = accountPortion.indices.map(index => `$${index}`).join(', ');
    const statusIndices = statusPortion.indices.map(index => `$${index}`).join(', ');
    const queryValues = accountPortion.values.concat(statusPortion.values);

    const findBoostQuery = `select distinct(boost_id) from ${boostAccountJoinTable} where account_id in (${accountIndices}) and boost_status in (${statusIndices})`;
    const findBoostIdsResult = await rdsConnection.selectQuery(findBoostQuery, queryValues);
    logger('Result of finding boost IDs: ', findBoostIdsResult);
    
    const boostIdArray = findBoostIdsResult.map((row) => row['boost_id']);
    const querySuffix = typeof attributes.active === 'boolean' ? ` and active = ${attributes.active}` : '';
    const retrieveBoostQuery = `select * from ${boostTable} where boost_id in (${extractArrayIndices(boostIdArray)})${querySuffix}`;
    const boostsRetrieved = await rdsConnection.selectQuery(retrieveBoostQuery, boostIdArray);
    logger('Result of retrieving boosts: ', boostsRetrieved);

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
        runningIndex = runningIndex + accountIds.length;
    }

    if (status) {
        querySuffix = `${querySuffix} and boost_status in (${extractArrayIndices(status, runningIndex)})`;
        runningValues = runningValues.concat(status);
        runningIndex = runningIndex + status.length;
    }

    const assembledQuery = `${queryBase} ${querySuffix} order by boost_id, account_id`;
    const resultOfQuery = await rdsConnection.selectQuery(assembledQuery, runningValues);
    logger('Received : ', resultOfQuery);

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
            rowIndex++;
        };
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

    if (typeof stillActive === 'boolean') {
        const updateBoostTableDef = { 
            table: boostTable,
            key: { boostId },
            value: { active: stillActive },
            returnClause: 'updated_time'
        };
        updateDefinitions.push(updateBoostTableDef);
        const logRow = ({ boostId, logType: 'BOOST_DEACTIVATED', logContext });
        logInsertDefinitions.push(constructLogDefinition(Object.keys(logRow), [logRow]));
    }

    const resultOfOperations = await rdsConnection.multiTableUpdateAndInsert(updateDefinitions, logInsertDefinitions);
    logger('Result from RDS: ', resultOfOperations);

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
    let sortedArray = timesOfOperations.sort((a, b) => b.valueOf() - a.valueOf());
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

const validateAndExtractUniverse = (universeComponent) => {
    logger('Universe component: ', universeComponent);
    const universeMatch = universeComponent.match(/#{(.*)}/);
    logger('Universe match: ', universeMatch);
    if (!universeMatch || universeMatch.length === 0) {
        throw new Error('Error! Universe definition passed incorrectly: ', universeComponent);
    }

    logger('Parsing: ', universeMatch[1]);
    const universeDefinition = JSON.parse(universeMatch[1]);
    logger('Resulting definition: ', universeDefinition);
    if (typeof universeDefinition !== 'object' || Object.keys(universeDefinition) === 0) {
        throw new Error('Error! Universe definitino not a validt object');
    }

    return universeDefinition;
};

// note : this _could_ be simplified by relying on ordering of Object.keys, but that would be dangerous/fragile
const extractSubClauseAndValues = (universeDefinition, currentIndex, currentKey) => {
    if (currentKey === 'specific_accounts') {
        logger('Sepcific account IDs selected');
        const accountIds = universeDefinition[currentKey];
        const placeHolders = accountIds.map((_, index) => `$${currentIndex + index + 1}`).join(', ');
        logger('Created place holder: ', placeHolders);
        const assembledClause = `account_id in (${placeHolders})`;
        return [assembledClause, accountIds, currentIndex + accountIds.length];
    }
    const newIndex = currentIndex + 1;
    return [`${decamelize(currentKey, '_')} = $${newIndex}`, [universeDefinition[currentKey]], newIndex];
}

// const decamelizeKeys = (object) => Object.keys(object).reduce((obj, key) => ({ ...obj, [decamelize(key, '_')]: object[key] }), {});

const extractWhereClausesValues = (universeDefinition) => {
    const [clauseStrings, clauseValues] = [[], []];
    const universeKeys = Object.keys(universeDefinition);
    let currentIndex = 0;
    universeKeys.forEach((key) => {
        logger('Next clause extraction, current key: ', key, ' and current index: ', currentIndex);
        const [nextClause, nextValues, newCurrentIndex] = extractSubClauseAndValues(universeDefinition, currentIndex, key);
        clauseStrings.push(nextClause);
        clauseValues.push(...nextValues);
        currentIndex = newCurrentIndex;
    });
    return [clauseStrings, clauseValues];
};

const assembleQueryClause = (selectionMethod, universeDefinition) => {
    if (selectionMethod === 'whole_universe') {
        logger('We are selecting all parts of the universe');
        const [conditionClauses, conditionValues] = extractWhereClausesValues(universeDefinition);
        const whereClause = conditionClauses.join(' and ');
        const selectionQuery = `select account_id from ${accountsTable} where ${whereClause}`;
        return [selectionQuery, conditionValues];
    } else if (selectionMethod === 'random_sample') {
        logger('We are selecting some random sample of a universe')
    } else if (selectionMethod === 'match_other') {
        logger('We are selecting so as to match another entity');
    }

    throw new Error('Invalid selection method provided: ', selectionMethod);
};

const extractAccountIds = async (selectionClause) => {
    logger('Selecting accounts according to: ', selectionClause);
    const clauseComponents = selectionClause.split(' ');
    logger('Split pieces: ', clauseComponents);
    const hasMethodParameters = clauseComponents[1] !== 'from';
    
    const selectionMethod = clauseComponents[0];
    const universeComponent = selectionClause.match(/#{.*}/g)[hasMethodParameters ? 1 : 0];
    const universeDefinition = validateAndExtractUniverse(universeComponent);
    
    const [selectionQuery, selectionValues] = assembleQueryClause(selectionMethod, universeDefinition);
    logger('Assembled selection clause: ', selectionQuery);
    logger('And selection values: ', selectionValues);

    const queryResult = await rdsConnection.selectQuery(selectionQuery, selectionValues);
    logger('Number of records from query: ', queryResult.length);

    return queryResult.map((row) => row['account_id']);
};

module.exports.insertBoost = async (boostDetails) => {
    
    logger('Instruction received to insert boost: ', boostDetails);
    
    const accountIds = await extractAccountIds(boostDetails.boostAudienceSelection);
    logger('Extracted account IDs for boost: ', accountIds);

    const boostId = uuid();
    const boostObject = {
        boostId: boostId,
        creatingUserId: boostDetails.creatingUserId,
        startTime: boostDetails.boostStartTime.format(),
        endTime: boostDetails.boostEndTime.format(),
        boostType: boostDetails.boostType,
        boostCategory: boostDetails.boostCategory,
        boostAmount: boostDetails.boostAmount,
        boostUnit: boostDetails.boostUnit,
        boostCurrency: boostDetails.boostCurrency,
        fromBonusPoolId: boostDetails.fromBonusPoolId,
        fromFloatId: boostDetails.fromFloatId,
        forClientId: boostDetails.forClientId,
        boostAudience: boostDetails.boostAudience,
        audienceSelection: boostDetails.boostAudienceSelection,
        statusConditions: boostDetails.statusConditions,
        redemptionMessages: { instructions: boostDetails.redemptionMsgInstructions }
    };

    if (boostDetails.conditionValues) {
        logger('This boost has conditions: ', boostDetails);
        boostObject.conditionValues = boostDetails.conditionClause;
    }

    const boostKeys = Object.keys(boostObject);
    const boostQueryDef = {
        query: `insert into ${boostTable} (${extractQueryClause(boostKeys)}) values %L returning boost_id, creation_time`,
        columnTemplate: extractColumnTemplate(boostKeys),
        rows: [boostObject]
    };

    const initialStatus = boostDetails.defaultStatus || 'CREATED'; // thereafter: OFFERED (when message sent), PENDING (almost done), COMPLETE
    const boostAccountJoins = accountIds.map((accountId) => ({ boostId, accountId, boostStatus: initialStatus }));
    const boostJoinQueryDef = {
        query: `insert into ${boostAccountJoinTable} (boost_id, account_id, boost_status) values %L returning insertion_id, creation_time`,
        columnTemplate: '${boostId}, ${accountId}, ${boostStatus}',
        rows: boostAccountJoins
    };

    // logger('Sending to insertion: ', boostQueryDef);

    const resultOfInsertion = await rdsConnection.largeMultiTableInsert([boostQueryDef, boostJoinQueryDef]);
    logger('Insertion result: ', resultOfInsertion);

    // first query, first row, creation time
    const persistedTime = moment(resultOfInsertion[0][0]['creation_time']);

    const resultObject = {
        boostId: resultOfInsertion[0][0]['boost_id'],
        persistedTimeMillis: persistedTime.valueOf(),
        numberOfUsersEligible: resultOfInsertion[1].length
    };

    logger('Returning: ', resultObject);
    return resultObject;

};
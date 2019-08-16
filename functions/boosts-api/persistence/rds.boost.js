'use strict';

const logger = require('debug')('jupiter:boosts:rds');
const config = require('config');
const uuid = require('uuid/v4');
const moment = require('moment');
const decamelize = require('decamelize');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const accountsTable = config.get('tables.accountLedger');
const boostTable = config.get('tables.boostTable');
const boostAccountJoinTable = config.get('tables.boostAccountJoinTable');

const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}\}`).join(', ');
const extractQueryClause = (keys) => keys.map((key) => decamelize(key)).join(', ');

module.exports.findBoost = async (attributes) => {
    
};

module.exports.findAccountsForBoost = async () => {

};

module.exports.updateBoostAccountStatus = async () => {
    // todo : make sure to only updates status upwards, to prevent corner case of false positive on one user triggered downward move on others
    
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
        startTime: boostDetails.boostStartTime.format(),
        endTime: boostDetails.boostEndTime.format(),
        boostType: boostDetails.boostType,
        boostCategory: boostDetails.boostCategory,
        boostAmount: boostDetails.boostAmount,
        boostUnit: boostDetails.boostUnit,
        boostCurrency: boostDetails.boostCurrency,
        fromBonusPoolId: boostDetails.fromBonusPoolId,
        forClientId: boostDetails.forClientId,
        boostAudience: boostDetails.boostAudience,
        audienceSelection: boostDetails.boostAudienceSelection,
        conditionClause: boostDetails.conditionClause
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
    const boostAccountJoins = accountIds.map((accountId) => ({ boostId, accountId, status: initialStatus }));
    const boostJoinQueryDef = {
        query: `insert into ${boostAccountJoinTable} (boost_id, account_id, status) values %L returning insertion_id, creation_time`,
        columnTemplate: '${boostId}, ${accountId}, ${status}',
        rows: boostAccountJoins
    };

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
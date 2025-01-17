'use strict';

const logger = require('debug')('jupiter:boosts:rds-admin');
const config = require('config');
const moment = require('moment');

const camelizeKeys = require('camelize-keys');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const STATUSSES = ['CREATED', 'OFFERED', 'UNLOCKED', 'PENDING', 'REDEEMED', 'REVOKED', 'EXPIRED', 'FAILED'];

const extractArrayIndices = (array, startingIndex = 1) => array.map((_, index) => `$${index + startingIndex}`).join(', ');

const knitBoostsAndCounts = (boostList, statusCounts) => {
    // might want to use a map for this eventually

    const statusCountDict = statusCounts.
        reduce((obj, row) => ({ ...obj, [`${row['boost_id']}::${row['boost_status']}`]: row['count']}), {});
    
    logger('Status count dict: ', JSON.stringify(statusCountDict));
    return boostList.map((boost) => {
        const count = {};
        STATUSSES.forEach((status) => {
            const countKey = `${boost.boostId}::${status}`;
            count[status] = statusCountDict[countKey] || 0;
        });
        boost.count = count;
        return boost;
    });
};

// get the status counts only for the active boosts (old ones can do a detail call)
const obtainStatusCounts = async (boostList, onlyActive = true) => {
    const boostTable = config.get('tables.boostTable');
    const joinTable = config.get('tables.boostAccountJoinTable');

    const whereClause = onlyActive ? `where ${boostTable}.active = true ` : '';
    const selectStatusCounts = `select ${joinTable}.boost_id, boost_status, count(account_id) ` +
        `from ${joinTable} inner join ${boostTable} on ${joinTable}.boost_id = ${boostTable}.boost_id ` +
        `${whereClause}` +
        `group by ${joinTable}.boost_id, boost_status, ${boostTable}.creation_time order by ${boostTable}.creation_time desc`;
    const selectStatusCountResults = await rdsConnection.selectQuery(selectStatusCounts, []);
    logger('And knitting together status counts, aswith first 5: ', JSON.stringify(selectStatusCountResults.slice(0, 5)));
    return knitBoostsAndCounts(boostList, selectStatusCountResults);
};

module.exports.listBoosts = async (excludedTypeCategories, excludeUserCounts = false, excludeExpired = false) => {
    const boostMainTable = config.get('tables.boostTable');
    
    const hasTypeExclusions = Array.isArray(excludedTypeCategories) && excludedTypeCategories.length > 0;
    const typeExclusionClause = hasTypeExclusions 
        ? `(boost_type || '::' || boost_category) not in (${extractArrayIndices(excludedTypeCategories)})` : '';
    const activeClause = excludeExpired ? 'active = true and end_time > current_timestamp' : '';
    
    let whereClause = '';
    if (hasTypeExclusions && excludeExpired) {
        whereClause = `where ${activeClause} and ${typeExclusionClause}`;
    } else if (hasTypeExclusions) {
        whereClause = `where ${typeExclusionClause}`;
    } else if (excludeExpired) {
        whereClause = `where ${activeClause}`;
    }

    const selectBoostQuery = `select * from ${boostMainTable} ${whereClause} order by creation_time desc`;
    const values = hasTypeExclusions ? excludedTypeCategories : [];
    logger('Assembled select query: ', selectBoostQuery);
    logger('Values for query: ', values);
    const boostsResult = await rdsConnection.selectQuery(selectBoostQuery, values);
    logger('Retrieved boosts of length: ', boostsResult.length);
    
    let boostList = boostsResult.map((boost) => camelizeKeys(boost));

    if (!excludeUserCounts) {
        boostList = await obtainStatusCounts(boostList);
    }

    return boostList;
};

module.exports.updateBoost = async (updateParameters) => {
    const table = config.get('tables.boostTable');
    const key = { boostId: updateParameters.boostId };
    const value = { ...updateParameters };
    Reflect.deleteProperty(value, 'boostId');
    const returnClause = 'updated_time';

    const response = await rdsConnection.updateRecordObject({ table, key, value, returnClause });
    logger('Response from update: ', response);

    return response.map(camelizeKeys);
};

module.exports.fetchUserBoosts = async (accountId, { excludedStatus, changedSinceTime, flags } = { excludedStatus: ['CREATED'] }) => {
    logger('Fetching user boosts with excluded status: ', excludedStatus, ' and flags: ', flags);

    const boostMainTable = config.get('tables.boostTable');
    const boostAccountJoinTable = config.get('tables.boostAccountJoinTable');
    
    const columns = [
        `${boostMainTable}.boost_id`, 'boost_status', 'label', 'start_time', `${boostAccountJoinTable}.updated_time`, 'active',
        'boost_type', 'boost_category', 'boost_amount', 'boost_unit', 'boost_currency', 'from_float_id',
        'status_conditions', 'message_instruction_ids', 'game_params', 'reward_parameters', `${boostMainTable}.flags`
    ];

    const endTimeColumn = '(case when expiry_time is not null then expiry_time else end_time end) as end_time';

    // const excludedType = ['REFERRAL']; // removing
    const excludedType = []; // stopgap

    const statusIndex = 2;
    const typeIndex = statusIndex + excludedStatus.length;

    // man but this needs a refactor sometime (just use length of array for index and keep adding to it)
    const updatedTimeRestriction = changedSinceTime ? ` and ${boostAccountJoinTable}.updated_time > $${typeIndex + excludedType.length}` : '';
    const flagRestriction = flags ? ` and ${boostMainTable}.flags && $${typeIndex + excludedType.length + (changedSinceTime ? 1 : 0)}` : '';
    const finalClause = `${updatedTimeRestriction}${flagRestriction}`;

    const selectBoostQuery = `select ${columns.join(', ')}, ${endTimeColumn} ` +
        `from ${boostMainTable} inner join ${boostAccountJoinTable} ` + 
            `on ${boostMainTable}.boost_id = ${boostAccountJoinTable}.boost_id ` +
        `where account_id = $1 and ` + 
        `boost_status not in (${extractArrayIndices(excludedStatus, statusIndex)}) ${finalClause} ` +
        // `boost_type not in (${extractArrayIndices(excludedType, typeIndex)}) ${finalClause}` +
       `order by ${boostAccountJoinTable}.creation_time desc`;

    const values = [accountId, ...excludedStatus];
    if (changedSinceTime) {
        values.push(changedSinceTime.format());
    }
    if (flags) {
        values.push(flags); // not using spread (as this should be formatted into sql as array)
    }

    logger('Assembled select query: ', selectBoostQuery);
    logger('Values for query: ', values);
    const boostsResult = await rdsConnection.selectQuery(selectBoostQuery, values);
    logger('Retrieved boosts of length: ', boostsResult.length);
    
    return boostsResult.map((boost) => camelizeKeys(boost));
};

module.exports.findAccountsForUser = async (userId = 'some-user-uid') => {
    const findQuery = `select account_id from ${config.get('tables.accountLedger')} where owner_user_id = $1 order by creation_time desc`;
    const resultOfQuery = await rdsConnection.selectQuery(findQuery, [userId]);
    logger('Result of account find query: ', resultOfQuery);
    return resultOfQuery.map((row) => row['account_id']);
};

module.exports.fetchUserBoostLogs = async (accountId, boostIds, logType) => {
    // to allow for empty calls (makes some parallism upstream simpler)
    if (boostIds.length === 0) {
        return [];
    }

    const fixedParams = 2;
    const findQuery = `select * from ${config.get('tables.boostLogTable')} where account_id = $1 and log_type = $2 and ` +
        `boost_id in (${extractArrayIndices(boostIds, fixedParams + 1)})`;
    const resultOfQuery = await rdsConnection.selectQuery(findQuery, [accountId, logType, ...boostIds]);
    return resultOfQuery.map((row) => camelizeKeys(row)); 
};

module.exports.fetchBoostDetails = async (boostId, includeAccounts) => {
    const queryResult = await rdsConnection.selectQuery(`select * from ${config.get('tables.boostTable')} where boost_id = $1`, [boostId]);
    
    const rawBoost = queryResult[0];
    const transformedBoost = {
        boostId: rawBoost['boost_id'],
        boostType: rawBoost['boost_type'],
        boostCategory: rawBoost['boost_category'],

        label: rawBoost['label'],
        
        active: rawBoost['active'],
        endTime: moment(rawBoost['end_time']),
        startTime: moment(rawBoost['start_time']),
        
        statusConditions: rawBoost['status_conditions'],
        rewardParameters: rawBoost['reward_parameters'] || {},
        gameParams: rawBoost['game_params'] || {},

        boostAmount: {
            amount: rawBoost['boost_amount'],
            unit: rawBoost['boost_unit'],
            currency: rawBoost['boost_currency']
        },
        
        flags: rawBoost['flags'] || []
    };

    if (includeAccounts) {
        // in theory could do this as a join but gain would be minimal and subsequent complexity high, so one more query is fine
        const accounts = await rdsConnection.selectQuery(`select account_id from ${config.get('tables.boostAccountJoinTable')} where boost_id = $1`, [boostId]);
        transformedBoost.accountIds = camelizeKeys(accounts).map((account) => account.accountId);
    }

    return transformedBoost;
};

module.exports.fetchBoostScoreLogs = async (boostId) => {
    const logTable = config.get('tables.boostLogTable');
    const accountTable = config.get('tables.accountLedger');

    const query = `select ${logTable}.log_context, ${accountTable}.owner_user_id from ` +
        `${logTable} inner join ${accountTable} on ${logTable}.account_id = ${accountTable}.account_id ` + 
        `where boost_id = $1 and log_type = $2`;
    const resultOfQuery = await rdsConnection.selectQuery(query, [boostId, 'GAME_RESPONSE']);

    const extractedScores = resultOfQuery.map((row) => {
        const logContext = row['log_context'];
        return { 
            userId: row['owner_user_id'],
            gameScore: logContext.numberTaps || logContext.percentDestroyed
        };
    });

    return extractedScores;
};

module.exports.sumBoostAndSavedAmounts = async (boostIds) => {
    const sumQuery = `select boost_id, sum(cast(log_context->>'boostAmount' as bigint)) as sum_of_boost_amount, ` +
        `sum(cast(log_context->>'savedWholeCurrency' as bigint)) as sum_of_saved from ` +
        `boost_data.boost_log where log_context ->> 'newStatus' = $1 ` + 
        `and log_context ->> 'boostAmount' ~ E'^\\\\d+$' and log_context ->> 'savedWholeCurrency' ~ E'^\\\\d+$' ` + 
        `and boost_id in (${extractArrayIndices(boostIds, 2)}) group by boost_id`;
    
    const resultOfSums = await rdsConnection.selectQuery(sumQuery, ['REDEEMED', ...boostIds]);
    logger('Result of sums:', resultOfSums);

    return resultOfSums.map((result) => camelizeKeys(result));
};

// Known duplicate of rds.boost -> fetchQuestionSnippet. To be consolidated.
module.exports.fetchQuestionSnippets = async (snippetIds) => {
    const selectQuery = `select snippet_id, title, body, response_options from ${config.get('tables.snippetTable')} ` + 
        `where snippet_id in (${extractArrayIndices(snippetIds)})`;
    const resultOfFetch = await rdsConnection.selectQuery(selectQuery, snippetIds);
    logger('Result of snippet fetch: ', resultOfFetch);
    return resultOfFetch.map((result) => camelizeKeys(result));
};

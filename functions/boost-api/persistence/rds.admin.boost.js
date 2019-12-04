'use strict';

const logger = require('debug')('jupiter:boosts:rds-admin');
const config = require('config');

const camelizeKeys = require('camelize-keys');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const STATUSSES = ['CREATED', 'OFFERED', 'PENDING', 'REDEEMED', 'REVOKED', 'EXPIRED'];

const extractArrayIndices = (array, startingIndex = 1) => array.map((_, index) => `$${index + startingIndex}`).join(', ');

const knitBoostsAndCounts = (boostList, statusCounts) => {
    // might want to use a map for this eventually

    const statusCountDict = statusCounts.reduce((obj, row) => { 
        const rowKey = `${row['boost_id']}::${row['boost_status']}`;
        return {...obj, [rowKey]: row['count'] };
    }, {});
    
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

module.exports.listBoosts = async (excludedTypeCategories, includeStatusCounts = false, includeInactive = false) => {
    const boostMainTable = config.get('tables.boostTable');
    const boostAccountTable = config.get('tables.boostAccountJoinTable');

    const hasTypeExclusions = Array.isArray(excludedTypeCategories) && excludedTypeCategories.length > 0;
    const typeExclusionClause = hasTypeExclusions 
        ? `(boost_type || '::' || boost_category) not in (${extractArrayIndices(excludedTypeCategories)})` : '';
    const activeClause = includeInactive ? '' : 'active = true and end_time > current_timestamp';
    
    let whereClause = '';
    if (hasTypeExclusions && !includeInactive) {
        whereClause = `where ${activeClause} and ${typeExclusionClause}`;
    } else if (hasTypeExclusions) {
        whereClause = `where ${typeExclusionClause}`;
    } else if (!includeInactive) {
        whereClause = `where ${activeClause}`;
    }

    const selectBoostQuery = `select * from ${boostMainTable} ${whereClause} order by creation_time desc`;
    const values = hasTypeExclusions ? excludedTypeCategories : [];
    logger('Assembled select query: ', selectBoostQuery);
    logger('Values for query: ', values);
    const boostsResult = await rdsConnection.selectQuery(selectBoostQuery, values);
    logger('Retrieved boosts: ', boostsResult);
    
    let boostList = boostsResult.map((boost) => camelizeKeys(boost));

    if (includeStatusCounts) {
        const selectStatusCounts = `select boost_id, boost_status, count(account_id) from ${boostAccountTable} group by boost_id, boost_status`;
        const selectStatusCountResults = await rdsConnection.selectQuery(selectStatusCounts, []);
        boostList = knitBoostsAndCounts(boostList, selectStatusCountResults);
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

module.exports.fetchUserBoosts = async (accountId) => {
    const boostMainTable = config.get('tables.boostTable');
    const boostAccountJoinTable = config.get('tables.boostAccountJoinTable');
    
    const columns = [
        `${boostMainTable}.boost_id`, 'boost_status', 'label', 'start_time', 'end_time', 'active',
        'boost_type', 'boost_category', 'boost_amount', 'boost_unit', 'boost_currency', 'from_float_id',
        'status_conditions', 'message_instruction_ids'
    ];

    const excludedStatus = ['CREATED'];
    const statusIndex = 2;

    const excludedType = ['REFERRAL']; // for now
    const typeIndex = statusIndex + excludedStatus.length;

    const selectBoostQuery = `select ${columns} from ${boostMainTable} inner join ${boostAccountJoinTable} ` + 
       `on ${boostMainTable}.boost_id = ${boostAccountJoinTable}.boost_id where account_id = $1 and ` + 
       `boost_status not in (${extractArrayIndices(excludedStatus, statusIndex)}) and ` +
       `boost_type not in (${extractArrayIndices(excludedType, typeIndex)}) ` +
       `order by ${boostAccountJoinTable}.creation_time desc`;

    const values = [accountId, ...excludedStatus, ...excludedType];
    logger('Assembled select query: ', selectBoostQuery);
    logger('Values for query: ', values);
    const boostsResult = await rdsConnection.selectQuery(selectBoostQuery, values);
    logger('Retrieved boosts: ', boostsResult);
    
    return boostsResult.map((boost) => camelizeKeys(boost));
};

module.exports.findAccountsForUser = async (userId = 'some-user-uid') => {
    const findQuery = `select account_id from ${config.get('tables.accountLedger')} where owner_user_id = $1 order by creation_time desc`;
    const resultOfQuery = await rdsConnection.selectQuery(findQuery, [userId]);
    logger('Result of account find query: ', resultOfQuery);
    return resultOfQuery.map((row) => row['account_id']);
};

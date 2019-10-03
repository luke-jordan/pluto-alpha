'use strict';

const logger = require('debug')('jupiter:boosts:rds-admin');
const config = require('config');

const camelizeKeys = require('camelize-keys');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db')); // todo : consider if want to use admin worker instead of boost worker here

const STATUSSES = ['CREATED', 'OFFERED', 'PENDING', 'REDEEMED', 'REVOKED', 'EXPIRED'];

const extractArrayIndices = (array, startingIndex = 1) => array.map((_, index) => `$${index + startingIndex}`).join(', ');

const knitBoostsAndCounts = (boostList, statusCounts) => {
    // might want to use a map for this eventually

    const statusCountDict = statusCounts.reduce((obj, row) => { 
        const rowKey = `${row['boost_id']}::${row['boost_status']}`;
        return {...obj, [rowKey]: row['count'] }}, {});
    
    return boostList.map((boost) => {
        const count = {};
        STATUSSES.forEach((status) => {
            const countKey = `${boost.boostId}::${status}`;
            count[status] = statusCountDict[countKey] || 0;
        });
        boost.count = count;
        return boost;
    });
}

module.exports.listBoosts = async (excludedTypeCategories, includeStatusCounts = false, includeInactive = false) => {
    const boostMainTable = config.get('tables.boostTable');
    const boostAccountTable = config.get('tables.boostAccountJoinTable');

    const hasTypeExclusions =  Array.isArray(excludedTypeCategories) && excludedTypeCategories.length > 0;
    const typeExclusionClause = hasTypeExclusions ? 
        `(boost_type || '::' || boost_category) not in (${extractArrayIndices(excludedTypeCategories)})` : '';
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
        const selectStatusCounts = `select boost_id, boost_status, count(account_id) from ${boostAccountTable} group by boost_id, boost_status`
        const selectStatusCountResults = await rdsConnection.selectQuery(selectStatusCounts, []);
        boostList = knitBoostsAndCounts(boostList, selectStatusCountResults);
    }

    return boostList;
};

module.exports.updateBoost = async (updateParameters) => {
    const table = config.get('tables.boostTable');
    const key = { boostId: updateParameters.boostId };
    const value = Object.assign({}, updateParameters);
    Reflect.deleteProperty(value, 'boostId');
    const returnClause = 'updated_time';

    const response = await rdsConnection.updateRecordObject({ table, key, value, returnClause });
    logger('Response from update: ', response);

    return response.map(camelizeKeys);
};


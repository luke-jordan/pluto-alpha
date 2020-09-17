'use strict';

const logger = require('debug')('jupiter:admin:rds-heat');
const config = require('config');

const opsUtil = require('ops-util-common');
const camelcaseKeys = require('camelcase-keys');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

module.exports.fetchHeatLevelThresholds = async (clientId, floatId) => {
    const query = `select * from ${config.get('tables.heatLevelThresholds')} where client_id = $1 and float_id = $2`;
    const resultOfQuery = await rdsConnection.selectQuery(query, [clientId, floatId]);
    return camelcaseKeys(resultOfQuery);
};

module.exports.fetchEventPointItems = async (clientId, floatId) => {
    const query = `select * from ${config.get('tables.eventPointMatch')} where client_id = $1 and float_id = $2`;
    const resultOfQuery = await rdsConnection.selectQuery(query, [clientId, floatId]);
    return camelcaseKeys(resultOfQuery);
};

// both of these assume the consumer is more or less playing nice; in future if necessary can first check tables to make more robust 
module.exports.upsertEventPointItems = async (eventPointItems) => {    
    const newItems = eventPointItems.filter((item) => !item.eventPointMatchId);
    const updateItems = eventPointItems.filter((item) => item.eventPointMatchId && item.eventPointMatchId.length > 0);

    const newItemKeys = Object.keys(newItems[0]);
    const insertDef = {
        query: `insert into ${config.get('tables.eventPointMatch')} (${opsUtil.extractQueryClause(newItemKeys)}) values %L returning creation_time`,
        columnTemplate: opsUtil.extractColumnTemplate(newItemKeys),
        rows: newItems
    };

    const updateDefs = updateItems.map(({ eventPointMatchId, numberPoints }) => ({
        table: config.get('tables.eventPointMatch'),
        key: { eventPointMatchId },
        value: { numberPoints },
        returnClause: 'updated_time'
    }));

    const resultOfUpsert = await rdsConnection.multiTableUpdateAndInsert(updateDefs, [insertDef]);
    logger('Result of upsert event point pairs: ', JSON.stringify(resultOfUpsert));

    return { result: 'SUCCESS', updated: updateItems.length, inserted: newItems.length }; // could also obtain rows in query response
};

module.exports.upsertHeatPointThresholds = async (levelConfigurations) => {
    const levelTable = config.get('tables.heatLevelThresholds');

    const newLevels = levelConfigurations.filter((level) => !level.levelId);
    const existingLevels = levelConfigurations.filter((level) => level.levelId && level.levelId.length > 0);

    const newLevelKeys = Object.keys(newLevels[0]);

    const insertDef = {
        query: `inesrt into ${levelTable} (${opsUtil.extractQueryClause(newLevelKeys)}) values %L returning creation_time`,
        columnTemplate: opsUtil.extractColumnTemplate(newLevelKeys),
        rows: newLevels
    };

    const updateDefs = existingLevels.map(({ levelId, minimumPoints, levelName, levelColor, levelColorCode }) => ({
        table: levelTable,
        key: { levelId },
        value: { minimumPoints, levelName, levelColor, levelColorCode },
        returnClause: 'updated_time'
    }));

    const resultOfUpsert = await rdsConnection.multiTableUpdateAndInsert(updateDefs, [insertDef]);
    logger('Result of upsert level thresholds: ', JSON.stringify(resultOfUpsert));

    return { result: 'SUCCESS', updated: existingLevels.legnth, inserted: newLevelKeys.length };
};

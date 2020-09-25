'use strict';

const logger = require('debug')('jupiter:admin:rds-heat');
const config = require('config');
const uuid = require('uuid/v4');

const opsUtil = require('ops-util-common');
const camelcaseKeys = require('camelcase-keys');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

module.exports.fetchHeatLevelThresholds = async (clientId, floatId) => {
    const query = `select * from ${config.get('tables.heatLevelThreshold')} where client_id = $1 ${floatId ? 'and float_id = $2' : ''}`;
    const resultOfQuery = await rdsConnection.selectQuery(query, floatId ? [clientId, floatId] : [clientId]);
    return camelcaseKeys(resultOfQuery);
};

module.exports.fetchEventPointItems = async (clientId, floatId) => {
    const query = `select * from ${config.get('tables.eventPointMatch')} where client_id = $1 and float_id = $2`;
    const resultOfQuery = await rdsConnection.selectQuery(query, [clientId, floatId]);
    return camelcaseKeys(resultOfQuery);
};

const transformNewItem = (newItem, adminUserId) => ({
    eventPointMatchId: uuid(),
    creatingUserId: adminUserId,
    ...newItem
});

const transformNewLevel = (newLevel, adminUserId) => ({
    levelId: uuid(),
    creatingUserId: adminUserId,
    ...newLevel
});

// could move inside the rds-common methods, but this will work for now
const updateAndOrInsert = async (insertDefs, updateDefs) => {
    if (insertDefs.length === 0 && updateDefs.length === 0) {
        throw Error('Passed empty updates and inserts');
    }

    if (updateDefs.length === 0) {   
        const insertion = insertDefs[0];
        const resultOfInsert = await rdsConnection.insertRecords(insertion.query, insertion.columnTemplate, insertion.rows);
        logger('Result of stand alone insertion: ', resultOfInsert);
    } else {
        const resultOfUpsert = await rdsConnection.multiTableUpdateAndInsert(updateDefs, insertDefs);
        logger('Result of upsert: ', JSON.stringify(resultOfUpsert));    
    }
};

// both of these assume the consumer is more or less playing nice; in future if necessary can first check tables to make more robust 
module.exports.upsertEventPointItems = async (eventPointItems, adminUserId) => {
    logger('Inserting with admin user id: ', adminUserId);
    const newItems = eventPointItems.filter((item) => !item.eventPointMatchId).map((newItem) => transformNewItem(newItem, adminUserId));
    const updateItems = eventPointItems.filter((item) => item.eventPointMatchId && item.eventPointMatchId.length > 0);

    const insertDefs = [];
    if (newItems.length > 0) {
        const newItemKeys = Object.keys(newItems[0]);
        const insertDef = {
            query: `insert into ${config.get('tables.eventPointMatch')} (${opsUtil.extractQueryClause(newItemKeys)}) values %L returning creation_time`,
            columnTemplate: opsUtil.extractColumnTemplate(newItemKeys),
            rows: newItems
        };
        logger('Inserting event point items with definition: ', JSON.stringify(insertDef));
        insertDefs.push(insertDef);  
    }

    const updateDefs = updateItems.map(({ eventPointMatchId, numberPoints }) => ({
        table: config.get('tables.eventPointMatch'),
        key: { eventPointMatchId },
        value: { numberPoints },
        returnClause: 'updated_time'
    }));
    logger('And update definitions for event point matches: ', JSON.stringify(updateDefs));

    await updateAndOrInsert(insertDefs, updateDefs);

    return { result: 'SUCCESS', updated: updateItems.length, inserted: newItems.length }; // could also obtain rows in query response
};

module.exports.upsertHeatPointThresholds = async (levelConfigurations, adminUserId) => {
    const levelTable = config.get('tables.heatLevelThreshold');

    const newLevels = levelConfigurations.filter((level) => !level.levelId).map((newLevel) => transformNewLevel(newLevel, adminUserId));
    const existingLevels = levelConfigurations.filter((level) => level.levelId && level.levelId.length > 0);

    const insertDefs = [];

    if (newLevels.length > 0) {
        const newLevelKeys = Object.keys(newLevels[0]);
        insertDefs.push({
            query: `insert into ${levelTable} (${opsUtil.extractQueryClause(newLevelKeys)}) values %L returning creation_time`,
            columnTemplate: opsUtil.extractColumnTemplate(newLevelKeys),
            rows: newLevels
        });
    }

    const updateDefs = existingLevels.map(({ levelId, minimumPoints, levelName, levelColor, levelColorCode }) => ({
        table: levelTable,
        key: { levelId },
        value: { minimumPoints, levelName, levelColor, levelColorCode },
        returnClause: 'updated_time'
    }));

    await updateAndOrInsert(insertDefs, updateDefs);

    return { result: 'SUCCESS', updated: existingLevels.length, inserted: newLevels.length };
};

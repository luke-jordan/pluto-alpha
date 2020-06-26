'use strict';

const logger = require('debug')('jupiter:activity:calculations');
const config = require('config');
const uuid = require('uuid/v4');

const decamelize = require('decamelize');
const camelCaseKeys = require('camelcase-keys');
const opsUtil = require('ops-util-common');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}}`).join(', ');
const extractColumnNames = (keys) => keys.map((key) => decamelize(key)).join(', ');

const snippetTable = config.get('tables.snippetTable');
const snippetJoinTable = config.get('tables.snippetJoinTable');
const snippetLogTable = config.get('tables.snippetLogTable');
const previewUserTable = config.get('tables.previewUserTable');

const transformSnippet = (snippet) => ({
    snippetId: snippet.snippetId || snippet.snippetDataSnippetSnippetId,
    title: snippet.title,
    text: snippet.body,
    fetchCount: snippet.fetchCount || 0,
    viewCount: snippet.viewCount || 0,
    snippetStatus: snippet.snippetStatus || 'UNCREATED',
    snippetPriority: snippet.snippetPriority
});

const extractColumnDetails = (object) => {
    const objectKeys = Object.keys(object);
    return [extractColumnNames(objectKeys), extractColumnTemplate(objectKeys)];
};

/**
 * This functions persists new snippets
 * @param {object} snippet A snippet object containing initial values passed in from the client.
 * @property {string}  creatingUserId The system wide user id of the creator of the snippet.
 * @property {string}  snippetBody The main snippet text.
 * @property {boolean} active Defines whether the snippet should be active on creation or not.
 * @property {object}  responseOptions An object containing response options to be displayed with the snippet to the user.
 */
module.exports.addSnippet = async (snippet) => {
    snippet.snippetId = uuid();

    const [columnNames, columnTemplate] = extractColumnDetails(snippet);
    const insertQuery = `insert into ${snippetTable} (${columnNames}) values %L returning creation_time`;
    
    logger('Inserting snippet: ', snippet);
    logger('Sending in insertion query: ', insertQuery, ' with column template: ', columnTemplate);
    
    const resultOfInsert = await rdsConnection.insertRecords(insertQuery, columnTemplate, [snippet]);
    logger('Result of insertion: ', resultOfInsert);

    return resultOfInsert.rows ? camelCaseKeys(resultOfInsert.rows[0]) : null;
};

// Creates a snippet reference in the user-snippet join table.
module.exports.createSnippetUserJoin = async (snippetId, userId) => {
    const snippetRefObject = { userId, snippetId, snippetStatus: 'CREATED' };

    const [columnNames, columnTemplate] = extractColumnDetails(snippetRefObject);
    const insertQuery = `insert into ${snippetJoinTable} (${columnNames}) values %L returning creation_time`;
    const resultOfInsert = await rdsConnection.insertRecords(insertQuery, columnTemplate, [snippetRefObject]);
    logger('Result of insertion: ', resultOfInsert);

    return resultOfInsert.rows ? camelCaseKeys(resultOfInsert.rows[0]) : null;
};

// Fetches a snippet reference from the user-snippet join table created above.
module.exports.fetchSnippetUserStatuses = async (snippetIds, userId) => {
    const selectQuery = `select * from ${snippetJoinTable} where user_id = $1 and snippet_id in (${opsUtil.extractArrayIndices(snippetIds, 2)})`;
    logger('Fetching snippets with query:', selectQuery);
    const resultOfFetch = await rdsConnection.selectQuery(selectQuery, [userId, ...snippetIds]);
    return resultOfFetch.length > 0 ? resultOfFetch.map((result) => camelCaseKeys(result)) : [];
};

// Increments a snippets view count (by updating the view count in the snippet reference in the user-snippet join table)
module.exports.incrementCount = async (snippetId, userId, status) => {
    if (!['FETCHED', 'VIEWED'].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
    }

    const updateColumn = status === 'FETCHED' ? 'fetch_count' : 'view_count';
    const updateQuery = `UPDATE ${snippetJoinTable} SET ${updateColumn} = ${updateColumn} + 1 WHERE snippet_id = $1 ` +
        `and user_id = $2 returning ${updateColumn}, updated_time`;

    const resultOfUpdate = await rdsConnection.updateRecord(updateQuery, [snippetId, userId]);
    logger('Result of update: ', resultOfUpdate);

    return typeof resultOfUpdate === 'object' && Array.isArray(resultOfUpdate.rows) 
        ? camelCaseKeys(resultOfUpdate.rows[0]) : [];
};

// Updates a snippets status, typically to VIEWED.
module.exports.updateSnippetStatus = async (snippetId, userId, status) => {
    const updateQuery = `UPDATE ${snippetJoinTable} SET snippet_status = $1 WHERE snippet_id = $2 ` +
        `and user_id = $3 returning updated_time`;

    const resultOfUpdate = await rdsConnection.updateRecord(updateQuery, [status, snippetId, userId]);
    logger('Result of update: ', resultOfUpdate);

    return typeof resultOfUpdate === 'object' && Array.isArray(resultOfUpdate.rows) 
        ? camelCaseKeys(resultOfUpdate.rows[0]) : [];
};

/**
 * This function fetches unread snippets for a user.
 * @param {string} systemWideUserId The user for whom the snippets are sought.
 */
module.exports.fetchUncreatedSnippets = async (systemWideUserId) => {
    const selectQuery = `select * from ${snippetTable} where active = $1 snippet_id not in ` +
        `(select snippet_id from ${snippetJoinTable} where user_id = $2 and snippet_status = $3)`;
    logger('Fetching unread snippets with query:', selectQuery);
    const resultOfFetch = await rdsConnection.selectQuery(selectQuery, [true, systemWideUserId, 'VIEWED']);
    return resultOfFetch.length > 0 ? resultOfFetch.map((result) => transformSnippet(camelCaseKeys(result))) : [];
};

/**
 * This function fetches viewed snippets for a user.
 * @param {string} systemWideUserId The user for whom the snippets are sought.
 */
module.exports.fetchCreatedSnippets = async (systemWideUserId) => {
    const selectQuery = `select * from ${snippetJoinTable} inner join ${snippetTable} where user_id = $1 and active = $2`;
    logger('Fetching unread snippets with query:', selectQuery);
    const resultOfFetch = await rdsConnection.selectQuery(selectQuery, [systemWideUserId, true]);
    return resultOfFetch.length > 0 ? resultOfFetch.map((result) => transformSnippet(camelCaseKeys(result))) : [];
};

// Fetches all snippets where preview mode is set to 'true'.
module.exports.fetchPreviewSnippets = async () => {
    const selectQuery = `select * from ${snippetTable} where preview_mode = $1`;
    const resultOfFetch = await rdsConnection.selectQuery(selectQuery, [true]);
    return Array.isArray(resultOfFetch) && resultOfFetch.length > 0
        ? resultOfFetch.map((result) => transformSnippet(camelCaseKeys(result))) : [];
};

/**
 * Asserts whether a user is part of the preview users table.
 * @param {string} systemWideUserId The user identifier to be checked for in the preview users table.
 */
module.exports.isPreviewUser = async (systemWideUserId) => {
    const selectQuery = `select user_id from ${previewUserTable} where user_id = $1`;
    const resultOfFetch = await rdsConnection.selectQuery(selectQuery, [systemWideUserId]);
    logger('Result of Fetch:', resultOfFetch);
    return Array.isArray(resultOfFetch) && resultOfFetch.length > 0;
};

/**
 * This function may be used to update a snippets main text, its active status, or its priority.
 * @param {object} updateParameters 
 * @property {string}  snippetId The target snippets identifier.
 * @property {string}  body The new snippet text.
 * @property {boolean} active The new snippet active status. 
 * @property {number}  priority The snippets priority number.
 */
module.exports.updateSnippet = async (updateParameters) => {
    const snippetId = updateParameters.snippetId;
    Reflect.deleteProperty(updateParameters, 'snippetId');

    const updateDef = { 
        key: { snippetId },
        value: updateParameters,
        table: snippetTable,
        returnClause: 'updated_time'
    };

    const resultOfUpdate = await rdsConnection.updateRecordObject(updateDef);
    logger('Result of update: ', resultOfUpdate);

    return Array.isArray(resultOfUpdate) && resultOfUpdate.length > 0
        ? camelCaseKeys(resultOfUpdate[0]) : null;
};

/**
 * This function is used to log snippet events, typically called when a snippet is viewed.
 * @param {object} logObject An object containing the properties to be persisted (listed below).
 * @property {string} userId The user who has interacted with the snippet.
 * @property {string} snippetId The snippet that has been interacted with.
 * @property {string} logType A string describing the user action/type of interaction, e.g SNIPPET_VIEWED.
 * @property {object} logContext An object containing additional properties to be persisted, pass empty object if none. 
 */
module.exports.insertSnippetLog = async (logObject) => {    
    const logId = uuid();
    const logRow = { logId, ...logObject };

    const insertQuery = `insert into ${snippetLogTable} (log_id, user_id, snippet_id, log_type, log_context) values %L returning log_id`;
    const columnTemplate = '${logId}, ${userId}, ${snippetId}, ${logType}, ${logContext}';
    
    const resultOfInsert = await rdsConnection.insertRecords(insertQuery, columnTemplate, [logRow]);
    logger('Result of inserting log: ', resultOfInsert);

    return resultOfInsert['rows'][0]['log_id'];
};

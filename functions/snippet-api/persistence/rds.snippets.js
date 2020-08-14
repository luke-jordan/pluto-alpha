'use strict';

const logger = require('debug')('jupiter:snippet:rds');

const opsUtil = require('ops-util-common');

const camelCaseKeys = require('camelcase-keys');
const decamelize = require('decamelize');
const config = require('config');
const uuid = require('uuid/v4');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

const snippetTable = config.get('tables.snippetTable');
const snippetLogTable = config.get('tables.snippetLogTable');
const snippetJoinTable = config.get('tables.snippetJoinTable');
const previewUserTable = config.get('tables.previewUserTable');

const transformSnippet = (snippet, keepAnswers = false) => {
    const transformedSnippet = {
        snippetId: snippet.snippetId || snippet.snippetDataSnippetSnippetId,
        title: snippet.title,
        body: snippet.body,
        active: snippet.active,
        fetchCount: snippet.fetchCount || 0,
        viewCount: snippet.viewCount || 0,
        snippetStatus: snippet.snippetStatus || 'UNCREATED',
        snippetPriority: snippet.snippetPriority
    };

    if (snippet.responseOptions) {
        if (!keepAnswers) {
            Reflect.deleteProperty(snippet.responseOptions, 'correctAnswerText');
        }

        transformedSnippet.responseOptions = snippet.responseOptions;
    }

    return transformedSnippet;
};

const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}}`).join(', ');
const extractColumnNames = (keys) => keys.map((key) => decamelize(key)).join(', ');

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
    const queryValues = [userId, ...snippetIds];
    logger('Fetching snippets with query:', selectQuery, ' and values: ', queryValues);
    const resultOfFetch = await rdsConnection.selectQuery(selectQuery, queryValues);
    logger('Retrieved: ', resultOfFetch);
    return resultOfFetch.length > 0 ? resultOfFetch.map((result) => camelCaseKeys(result)) : [];
};

// Increments a snippets view count (by updating the view count in the snippet reference in the user-snippet join table)
module.exports.incrementCount = async (snippetId, userId, status) => {
    if (!['FETCHED', 'VIEWED'].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
    }

    const updateColumn = status === 'FETCHED' ? 'fetch_count' : 'view_count';
    const updateQuery = `update ${snippetJoinTable} set ${updateColumn} = ${updateColumn} + 1 where snippet_id = $1 ` +
        `and user_id = $2 returning ${updateColumn}, updated_time`;

    const resultOfUpdate = await rdsConnection.updateRecord(updateQuery, [snippetId, userId]);
    logger('Result of update: ', resultOfUpdate);

    return typeof resultOfUpdate === 'object' && Array.isArray(resultOfUpdate.rows) 
        ? camelCaseKeys(resultOfUpdate.rows[0]) : [];
};

// Updates a snippets status, typically to VIEWED.
module.exports.updateSnippetStatus = async (snippetId, userId, status) => {
    const updateQuery = `update ${snippetJoinTable} set snippet_status = $1 where snippet_id = $2 ` +
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
module.exports.fetchUncreatedSnippets = async (systemWideUserId, includeQuestionSnippets = false) => {
    let selectQuery = `select * from ${snippetTable} where active = $1 and snippet_id not in ` +
        `(select snippet_id from ${snippetJoinTable} where user_id = $2 and snippet_status = $3)`;

    const responseOptionsClause = includeQuestionSnippets ? ' and response_options not null' : ' and response_options = null';
    selectQuery += responseOptionsClause;
  
    logger('Fetching unread snippets with query:', selectQuery);
    const resultOfFetch = await rdsConnection.selectQuery(selectQuery, [true, systemWideUserId, 'VIEWED']);
    // logger('Raw result of fetch: ', resultOfFetch);
    return resultOfFetch.map((result) => transformSnippet(camelCaseKeys(result)));
};

/**
 * This function fetches viewed snippets for a user.
 * @param {string} systemWideUserId The user for whom the snippets are sought.
 */
module.exports.fetchCreatedSnippets = async (systemWideUserId, includeQuestionSnippets = false) => {
    let selectQuery = `select * from ${snippetJoinTable} inner join ${snippetTable} ` + 
        `on ${snippetJoinTable}.snippet_id = ${snippetTable}.snippet_id ` +
        `where user_id = $1 and active = $2`;

    const responseOptionsClause = includeQuestionSnippets 
        ? ' and response_options not null' : ' and response_options = null';

    selectQuery += responseOptionsClause;
    logger('Fetching unread snippets with query:', selectQuery);
    const resultOfFetch = await rdsConnection.selectQuery(selectQuery, [systemWideUserId, true]);
    return resultOfFetch.map((result) => transformSnippet(camelCaseKeys(result)));
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
    const selectQuery = `select user_id from ${previewUserTable} where user_id = $1 and active = $2`;
    const resultOfFetch = await rdsConnection.selectQuery(selectQuery, [systemWideUserId, true]);
    logger('Result of Fetch:', resultOfFetch);
    return Array.isArray(resultOfFetch) && resultOfFetch.length > 0;
};

/**
 * Inserts a new preview user (a user who can view snippets in preview mode). 
 * @param {string} systemWideUserId The user id of the new preview user.
 */
module.exports.insertPreviewUser = async (systemWideUserId) => {
    const findQuery = `select * from ${previewUserTable} where user_id = $1`;
    const findResult = await rdsConnection.selectQuery(findQuery, [systemWideUserId]);
    logger('Searching for existing preview user resulted in:', findResult);

    if (Array.isArray(findResult) && findResult.length > 0) {
        const updateQuery = `update ${previewUserTable} set active = $1 where user_id = $2 returning updated_time`;
        const resultOfUpdate = await rdsConnection.updateRecord(updateQuery, [true, systemWideUserId]);
        logger('Result of preview user reactivation:', resultOfUpdate);
        
        return typeof resultOfUpdate === 'object' && Array.isArray(resultOfUpdate.rows) 
            ? camelCaseKeys(resultOfUpdate.rows[0]) : [];
    }

    const previewUserObj = { userId: systemWideUserId };
    const [columnNames, columnTemplate] = extractColumnDetails(previewUserObj);
    const insertQuery = `insert into ${previewUserTable} (${columnNames}) values %L returning creation_time`;

    const resultOfInsert = await rdsConnection.insertRecords(insertQuery, columnTemplate, [previewUserObj]);
    logger('Result of preview user insert:', resultOfInsert);

    return resultOfInsert.rows ? camelCaseKeys(resultOfInsert.rows[0]) : null;

};

/**
 * Removes (deactivates) a preview user.
 * @param {string} systemWideUserId The user id of the preview user to be removed.
 */
module.exports.removePreviewUser = async (systemWideUserId) => {
    const updateQuery = `update ${previewUserTable} set active = $1 where user_id = $2 returning updated_time`;
    const resultOfUpdate = await rdsConnection.updateRecord(updateQuery, [false, systemWideUserId]);
    logger('Result of preview user removal:', resultOfUpdate);

    return typeof resultOfUpdate === 'object' && Array.isArray(resultOfUpdate.rows) 
        ? camelCaseKeys(resultOfUpdate.rows[0]) : null;
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

/**
 * Fetches all active snippets and the number of users each snippet has been created for.
 */
module.exports.fetchSnippetsAndUserCount = async () => {
    const selectQuery = `select ${snippetTable}.*, count(distinct(user_id)) as user_count from ` + 
        `${snippetTable} left join ${snippetJoinTable} on ` +
        `${snippetTable}.snippet_id = ${snippetJoinTable}.snippet_id ` +
        `where active = $1 ` + 
        `group by ${snippetTable}.snippet_id`;
    const resultOfFetch = await rdsConnection.selectQuery(selectQuery, [true]);
    logger('Exact result of fetch: ', resultOfFetch);
    // logger(`Found ${resultOfFetch.length || 0} snippets`);
    
    return resultOfFetch.map(camelCaseKeys);
};

/**
 * Fetches a single snippet for admin user. All snippet properties are returned.
 * @param {string} snippetId The identifier of the snippet ot be retrieved.
 */
module.exports.fetchSnippetForAdmin = async (snippetId) => {
    const selectQuery = `select * from ${snippetTable} where snippet_id = $1`;
    const resultOfFetch = await rdsConnection.selectQuery(selectQuery, [snippetId]);
    logger('Got snippet:', resultOfFetch);
    return Array.isArray(resultOfFetch) && resultOfFetch.length > 0 ? camelCaseKeys(resultOfFetch[0]) : [];
};

/**
 * Counts how many times a snippet has been created, fetched, and viewed (by all ordinary users).
 * @param {string} snippetId The identifier of the snippet whose views are to be counted.
 */
module.exports.countSnippetEvents = async (snippetId) => {
    const selectQuery = `select count(distinct(user_id)) as sum_users, sum(view_count) as sum_views, sum(fetch_count) as sum_fetches from ${snippetJoinTable} ` +
        `where snippet_id = $1 group by snippet_id`;
    const resultOfFetch = await rdsConnection.selectQuery(selectQuery, [snippetId]);
    logger('Got snippet view counts:', resultOfFetch);
    return Array.isArray(resultOfFetch) && resultOfFetch.length > 0
        ? camelCaseKeys(resultOfFetch[0]) : null;
};

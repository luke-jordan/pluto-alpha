'use strict';

const logger = require('debug')('jupiter:snippet:admin');

const persistence = require('./persistence/rds.snippets');
const opsUtil = require('ops-util-common');

/**
 * This function list all active snippets for an admin user (also includes how many times each
 * snippet has been created for users).
 * @param {object} event An admin event.
 */
module.exports.listSnippets = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event, 'systemWideUserId', true)) {
            return { statusCode: 403 };
        }

        const snippets = await persistence.fetchSnippetsAndUserCount();
        logger('Got snippets:', snippets);

        const transformedSnippets = snippets.map((snippet) => ({
            snippetId: snippet.snippetId, 
            title: snippet.title,
            body: snippet.body,
            snippetPriority: snippet.snippetPriority,
            previewMode: snippet.previewMode,
            userCount: snippet.userCount
        }));

        return opsUtil.wrapResponse(transformedSnippets);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};

/**
 * This function fetches major snippet details (sucj as title, text, the number of users it has been created for
 * how many times the snippet has been fetched and viewed, etc) for a defined snippet for an admin user.
 * @param {object} event An admin event.
 * @property {string} snippetId The identifier of the snippet whose properties are to be retrieved.
 */
module.exports.viewSnippet = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event, 'systemWideUserId', true)) {
            return { statusCode: 403 };
        }

        const { snippetId } = opsUtil.extractParamsFromEvent(event);

        const [snippet, snippetEventCounts] = await Promise.all([
            persistence.fetchSnippetForAdmin(snippetId),
            persistence.countSnippetEvents(snippetId)
        ]);
        logger('Got snippet', snippet, 'And event counts:', snippetEventCounts);

        const { sumUsers, sumViews, sumFetches } = snippetEventCounts || { sumUsers: 0, sumViews: 0, sumFetches: 0 };

        const transformedSnippet = {
            snippetId: snippet.snippetId,
            title: snippet.title,
            body: snippet.body,
            userCount: sumUsers,
            totalViewCount: sumViews,
            totalFetchCount: sumFetches
        };

        logger('Returning transformed snippet:', transformedSnippet);

        return opsUtil.wrapResponse(transformedSnippet);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};

/** Generic handler to reduce need for lambda proliferation */
module.exports.readSnippets = async (event) => {
    const { operation } = opsUtil.extractPathAndParams(event);
    
    if (operation === 'list') {
        return exports.listSnippets(event);
    }

    if (operation === 'view') {
        return exports.viewSnippet(event);
    }

    return opsUtil.wrapResponse({}, 400);
};

/**
 * This function creates a new snippet.
 * @param {object} event An admin event.
 * @property {string}  title The snippet title
 * @property {string}  body The main snippet text.
 * @property {boolean} active Optional property that can be used to create inactive snippets. All new snippets are active by default.
 * @property {object}  responseOptions An object containing the possible response options to be displayed with the snippet.
 */
module.exports.createSnippet = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (userDetails.role !== 'SYSTEM_ADMIN') {
            return { statusCode: 403 };
        }

        const systemWideUserId = userDetails.systemWideUserId;
        const params = opsUtil.extractParamsFromEvent(event);
        logger('Got params:', params);
        
        const snippet = {
            createdBy: systemWideUserId,
            title: params.title,
            body: params.body,
            countryCode: params.countryCode,
            active: typeof params.active === 'boolean' ? params.active : true,
            snippetPriority: params.snippetPriority || 1,
            snippetLanguage: params.snippetLanguage || 'en',
            previewMode: typeof params.previewMode === 'boolean' ? params.previewMode : true
        };

        const creationResult = await persistence.addSnippet(snippet);
        logger('Result of snippet creation:', creationResult);
        
        return opsUtil.wrapResponse({ result: 'SUCCESS', creationTime: creationResult.creationTime });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};

/**
 * This function updates a snippets properties. The only property updates allowed by the this function are
 * the snippets text, title, active status, and priority.
 * @param {object} event User or admin event.
 * @property {string} snippetId The identifer of the snippet to be updated.
 * @property {string} title The value entered here will update the snippet's title.
 * @property {string} body The value entered here will update the main snippet text.
 * @property {boolean} active Can be used to activate or deactivate a snippet.
 * @property {number} snippetPriority Used to update the snippets priority.
 */
module.exports.updateSnippet = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event, 'systemWideUserId', true)) {
            return { statusCode: 403 };
        }

        const { snippetId, title, body, active, priority } = opsUtil.extractParamsFromEvent(event);
        if (!snippetId || (!title && !body && !priority && typeof active !== 'boolean')) {
            return { statusCode: 400, body: `Error! 'snippetId' and a snippet property to be updated are required` };
        }
        
        const updateParameters = JSON.parse(JSON.stringify({ snippetId, title, body, active, priority })); // removes keys with undefined values
        const resultOfUpdate = await persistence.updateSnippet(updateParameters);
        logger('Result of update:', resultOfUpdate);

        return opsUtil.wrapResponse({ result: 'SUCCESS', updatedTime: resultOfUpdate.updatedTime });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};

/**
 * Adds a new preview user, i.e a user who may preview snippets (to make snippets available for
 * preview set the value of the snippets preview_mode property to true).
 * @param {object} event An admin event.
 * @property {string} systemWideUserId The user id of the new preview user.
 */
module.exports.addUserToPreviewList = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event, 'systemWideUserId', true)) {
            return { statusCode: 403 };
        }

        const { systemWideUserId } = opsUtil.extractParamsFromEvent(event);

        const resultOfInsert = await persistence.insertPreviewUser(systemWideUserId);
        logger('Result of insert:', resultOfInsert);

        if (!resultOfInsert || typeof resultOfInsert !== 'object') {
            throw new Error('Error inserting new preview user');
        }

        return opsUtil.wrapResponse({ result: 'SUCCESS' });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};

/**
 * Removes a preview user. Users put through this process will no longer have access to snippets
 * in preview mode.
 * @param {object} event An admin event.
 * @property {string} systemWideUserId The identifier of the user to be removed from the list of preview users.
 */
module.exports.removeUserFromPreviewList = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event, 'systemWideUserId', true)) {
            return { statusCode: 403 };
        }

        const { systemWideUserId } = opsUtil.extractParamsFromEvent(event);

        const resultOfRemoval = await persistence.removePreviewUser(systemWideUserId);
        logger('Result of preview user removal:', resultOfRemoval);

        if (!resultOfRemoval || typeof resultOfRemoval !== 'object') {
            throw new Error('Error removing preview user');
        }

        return opsUtil.wrapResponse({ result: 'SUCCESS' });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};

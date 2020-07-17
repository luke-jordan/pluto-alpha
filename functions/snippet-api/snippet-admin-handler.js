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

        const { sumUsers, sumViews, sumFetches } = snippetEventCounts;

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

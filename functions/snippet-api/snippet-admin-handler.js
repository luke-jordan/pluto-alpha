'use strict';

const logger = require('debug')('jupiter:snippet:admin');

const persistence = require('./persistence/rds.snippets');
const opsUtil = require('ops-util-common');

/**
 * This function list all active snippets for an admin user.
 * @param {object} event An admin event.
 */
module.exports.listSnippets = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event, 'systemWideUserId', true)) {
            return { statusCode: 403 };
        }

        const snippets = await persistence.fetchAllSnippets();
        logger('Got snippets:', snippets);

        const transformedSnippets = snippets.map((snippet) => ({
            snippetId: snippet.snippetId, 
            title: snippet.title,
            body: snippet.body,
            snippetPriority: snippet.snippetPriority,
            previewMode: snippet.previewMode
        }));

        return opsUtil.wrapResponse(transformedSnippets);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};

/**
 * This function fetches all the properties of a defined snippet for an admin user.
 * @param {object} event An admin event.
 * @property {string} snippetId The identifier of the snippet whose properties are to be retrieved.
 */
module.exports.viewSnippet = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event, 'systemWideUserId', true)) {
            return { statusCode: 403 };
        }

        const { snippetId } = opsUtil.extractParamsFromEvent(event);

        const [snippet, userCount, totalViewCount, totalFetchCount] = await Promise.all([
            persistence.fetchSnippetForAdmin(snippetId),
            persistence.getSnippetUserCount(snippetId),
            persistence.getSnippetViewCount(snippetId),
            persistence.getSnippetFetchCount(snippetId)
        ]);

        const transformedSnippet = {
            snippetId: snippet.snippetId,
            title: snippet.title,
            body: snippet.body,
            userCount,
            totalViewCount,
            totalFetchCount
        };

        logger('Returning transformed snippet:', transformedSnippet);

        return opsUtil.wrapResponse(transformedSnippet);
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};

/**
 * Adds a new user to the list of users who may view snippets in preview mode.
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

        // todo: result validation

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

        // todo: result validation

        return opsUtil.wrapResponse({ result: 'SUCCESS' });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};

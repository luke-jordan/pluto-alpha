'use strict';

const logger = require('debug')('jupiter:snippet:main');
const config = require('config');

const persistence = require('./persistence/rds.snippets');
const publisher = require('publish-common');
const opsUtil = require('ops-util-common');

const statusOrder = ['UNCREATED', 'CREATED', 'FETCHED', 'VIEWED'];
const isStatusAfter = (statusA, statusB) => statusOrder.indexOf(statusA) < statusOrder.indexOf(statusB);

const snippetSorter = (snippetA, snippetB) => {
    if (snippetA.snippetStatus !== snippetB.snippetStatus) {
        return statusOrder.indexOf(snippetA.snippetStatus) - statusOrder.indexOf(snippetB.snippetStatus);
    }

    if (snippetA.viewCount !== snippetB.viewCount) {
        return snippetA.viewCount - snippetB.viewCount;
    }

    return snippetA.snippetPriority - snippetB.snippetPriority;
};

const sortSnippets = (snippets) => snippets.sort(snippetSorter);

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

const handleSnippetUpdate = async (userId, snippetId, snippetStatus) => {
    // if the snippet has been created for a user this operation returns an object containing the snippets status, i.e. the
    // relationship between a snippet and a user, (e.g. whether the snippet has been fetched or viewed for/by the user before)
    const snippetUserStatuses = await persistence.fetchSnippetUserStatuses([snippetId], userId);
    logger('Got snippet details:', snippetUserStatuses);

    // if the snippet has not yet been created for a user do so now
    if (!snippetUserStatuses || snippetUserStatuses.length === 0) {
        const resultOfCreation = await persistence.createSnippetUserJoin(snippetId, userId);
        logger('Resultof creating user-snippet join table entry:', resultOfCreation);
    }

    const initialStatus = snippetUserStatuses && snippetUserStatuses.length > 0 ? snippetUserStatuses[0].snippetStatus : 'CREATED';
    logger('Is status after:', isStatusAfter(initialStatus, snippetStatus));

    if (isStatusAfter(initialStatus, snippetStatus)) {
        const resultOfUpdate = await persistence.updateSnippetStatus(snippetId, userId, snippetStatus);
        logger('Result of updating snippet state:', resultOfUpdate);
    }

    if (snippetStatus === 'VIEWED') {
        const logId = await persistence.insertSnippetLog({ userId, snippetId, logType: 'SNIPPET_VIEWED', logContext: {} });
        logger('Snippet event logged with log id:', logId);
    }

    const incrementResult = await persistence.incrementCount(snippetId, userId, snippetStatus);
    logger('Incrementing view/fetch count resulted in:', incrementResult);

    return snippetStatus === 'FETCHED' ? { fetchCount: incrementResult.fetchCount } : { viewCount: incrementResult.viewCount };
};

/**
 * Updates a snippets status to FETCHED or VIEWED. 
 * @param {object} event A user, admin, or direct invocation.
 * @property {array}  snippetIds An array of snippet ids.
 * @property {string} userId The identifier of the user associated with the above snippet ids.
 * @property {string} status The new status. Valid values are FETCHED and VIEWED. 
 */
module.exports.updateSnippetStateForUser = async (event) => {
    try {
        if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
            return { statusCode: 403 };
        }

        const { snippetIds, userId, status } = event;
        const updatePromises = snippetIds.map((snippetId) => handleSnippetUpdate(userId, snippetId, status));
        const resultOfUpdate = await Promise.all(updatePromises);
        logger('Result of update:', resultOfUpdate);
        return { result: 'SUCCESS', details: resultOfUpdate };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return { result: 'FAILURE', details: err.message };
    }
};

// Handles batch calls from SQS to updateSnippetStateForUser as SQS may pull multiple events from multiple users.
module.exports.handleBatchSnippetUpdates = async (sqsEvent) => {
    const sqsEvents = opsUtil.extractSQSEvents(sqsEvent);
    logger('Got SQS events: ', sqsEvents);
    return Promise.all(sqsEvents.map((event) => exports.updateSnippetStateForUser(event)));
};

/**
 * This function fetches snippets to be displayed to a user. If there are snippets a user has not viewed
 * those are returned first, if not then previously viewed snippets are returned.
 * @param {object} event A user or admin event.
 */
module.exports.fetchSnippetsForUser = async (event) => {
    try {
        const userDetails = opsUtil.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: 403 };
        }

        const systemWideUserId = userDetails.systemWideUserId;

        const uncreatedSnippets = await persistence.fetchUncreatedSnippets(systemWideUserId);
        logger('Found uncreated snippets:', uncreatedSnippets);

        if (Array.isArray(uncreatedSnippets) && uncreatedSnippets.length > 0) {
            const snippetIds = uncreatedSnippets.map((snippet) => snippet.snippetId);
            const queueName = config.get('publishing.userEvents.snippetQueue');
            const payload = { snippetIds, userId: systemWideUserId, status: 'FETCHED' };
            
            await publisher.sendToQueue(queueName, [payload]);
            return opsUtil.wrapResponse(sortSnippets(uncreatedSnippets));
        }

        const isPreviewUser = await persistence.isPreviewUser(systemWideUserId);
        logger('Preview snippets:', isPreviewUser);

        if (isPreviewUser) {
            const previewSnippets = await persistence.fetchPreviewSnippets();
            logger('Found preview snippets:', previewSnippets);
            return opsUtil.wrapResponse(sortSnippets(previewSnippets));
        }
     
        const createdSnippets = await persistence.fetchCreatedSnippets(systemWideUserId);
        logger('Found created snippets:', createdSnippets);

        return opsUtil.wrapResponse(sortSnippets(createdSnippets));
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
        if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
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


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
const updateMultipleSnippetsForUser = async (event) => {
    try {
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

const handleSqsEvent = async (sqsEvent) => {
    const sqsEvents = opsUtil.extractSQSEvents(sqsEvent);
    logger('Received SQS events: ', sqsEvents);
    return Promise.all(sqsEvents.map((event) => updateMultipleSnippetsForUser(event)));
};

const handleApiEvent = async (event) => {
    try {
        logger('Updating snippet user status, with body: ', event.body);
        const { snippetId, status } = JSON.parse(event.body);
        const { systemWideUserId: userId } = opsUtil.extractUserDetails(event);
        const resultOfUpdate = await handleSnippetUpdate(userId, snippetId, status);
        return { statusCode: 200, body: JSON.stringify(resultOfUpdate) };
    } catch (err) {
        return { statusCode: 500, body: JSON.stringify(err) };
    }
};

/**
 * At the moment this can be called by SQS or by API GW. In time we will make API GW just dump into SQS, but later.
 * @param {event} sqsEvent 
 */
module.exports.handleSnippetStatusUpdates = async (event) => {
    if (Reflect.has(event, 'httpMethod') && event.httpMethod === 'POST') {
        return handleApiEvent(event);
    }

    if (event.Records && event.Records.length > 0) {
        return handleSqsEvent(event);
    }

    logger('FATAL_ERROR: Unknown event source for handle snippet status updates');
    return { statusCode: 500 };
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
            const queueName = config.get('publishing.snippetQueue');
            const payload = { snippetIds, userId: systemWideUserId, status: 'FETCHED' };
            await publisher.sendToQueue(queueName, [payload]);

            return opsUtil.wrapResponse({ type: 'UNSEEN', snippets: sortSnippets(uncreatedSnippets) });
        }

        const isPreviewUser = await persistence.isPreviewUser(systemWideUserId);
        logger('Preview snippets:', isPreviewUser);

        if (isPreviewUser) {
            const previewSnippets = await persistence.fetchPreviewSnippets();
            logger('Found preview snippets:', previewSnippets);
            return opsUtil.wrapResponse({ type: 'ALL', snippets: sortSnippets(previewSnippets) });
        }
     
        const createdSnippets = await persistence.fetchCreatedSnippets(systemWideUserId);
        logger('Found created snippets:', createdSnippets);

        return opsUtil.wrapResponse({ type: 'ALL', snippets: sortSnippets(createdSnippets) });
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return opsUtil.wrapResponse({ error: err.message }, 500);
    }
};

'use strict';

module.exports.publishUserLog = async ({ adminUserId, systemWideUserId, eventType, context, publisher }) => {
    const logOptions = { initiator: adminUserId, context };
    return publisher.publishUserEvent(systemWideUserId, eventType, logOptions);
};

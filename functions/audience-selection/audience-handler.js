'use strict';

const logger = require('debug')('jupiter:audience-selection');
const config = require('config');

const persistence = require('./persistence');

const stdProperties = {
    activityCount: {},
    lastSaveTime: {}
}

module.exports.fetchPropertyMapping = () => ({
        statusCode: 200,
        message: AudienceSelection.fetchAvailableProperties()
});

module.exports.processRequestFromAnotherLambda = async (event) => {
    try {
        const users = await persistence.executeColumnConditions(event, false);
        logger('Successfully retrieved users', users);
        return {
            statusCode: 200,
            message: users
        };
    } catch (error) {
        logger('FATAL_ERROR:', error);
        return { statusCode: 500, message: error.message };
    }
};

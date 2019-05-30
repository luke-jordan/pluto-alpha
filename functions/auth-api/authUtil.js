// λfy

const config = require('config');
const logger = require('debug')('pluto:auth-util:main');
const dynamo = require('./persistence/dynamodb/dynamodb');

/**
 * @param systemWideUserId the system wide user id passed into the auth lambda event
 * @param userRole the requested role of new user to be created
 * @param createdBy this is useful for accessing protected roles. Only admin users should be able create protected roles.
 */

module.exports.assignUserRolesAndPermissions = (systemWideUserId, userRole, createdBy = 'newUser') => {
    if (!userRole) userRole = 'default';
    switch(userRole) {
        case 'default':
            return dynamo.getPolicy("defaultUserPolicy", systemWideUserId);

        case 'admin':
            return dynamo.getPolicy("adminUserPolicy", systemWideUserId);

        case 'support':
           return dynamo.getPolicy("supportUserPolicy", systemWideUserId);

        default:
            return {error: 'Undefined Policy'};
    };
};


module.exports.getSignOptions = (systemWideUserId) => {
    return {
        issuer: 'Pluto Saving',
        subject: systemWideUserId,
        audience: 'https://plutosaving.com'
    };
};
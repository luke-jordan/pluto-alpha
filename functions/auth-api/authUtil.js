// λfy
// if (createdBy !== admin) throw new Error('Action not allowed');

const config = require('config');
const logger = require('debug')('pluto:auth-util:main');
const dynamo = require('./persistence/dynamodb/dynamodb');

/**
 * @param
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
        issuer: 'Pluto Savings',
        subject: systemWideUserId,
        audience: 'https://plutosavings.com'
    };
};
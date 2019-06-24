'use strict';

const logger = require('debug')('pluto:auth:rds-util-main')
const config = require('config');
const RdsConnection = require('rds-common');

const rdsConnection = new RdsConnection(config.get('db'));


module.exports.createUserCredentials = (systemWideUserId, salt, verifier) => {
    return {
        systemWideUserId: systemWideUserId,
        salt: salt,
        verifier: verifier,
        serverEphemeralSecret: null
    };
};


// consolidate below?
module.exports.insertUserCredentials = async (newUser) => {
    try {
        logger('about to run credentials insertion query with user object:', newUser);
        const insertionQuery = `insert into ${config.get('tables.userTable')} (system_wide_user_id, salt, verifier, server_ephemeral_secret) values %L returning insertion_id, creation_time`;
        const insertionColumns = '${systemWideUserId}, ${salt}, ${verifier}, ${serverEphemeralSecret}';
        const insertionList = [newUser];

        const response = await rdsConnection.insertRecords(insertionQuery, insertionColumns, insertionList);
        logger('got this back from credentials insertion query', response);

        return {
            databaseResponse: response.rows 
        };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        throw new Error(err.message);
    };
};


module.exports.updateUserSaltAndVerifier = async (systemWideUserId, salt, verifier) => {
    try {
        if (!systemWideUserId || !salt || !verifier) throw new Error('Invalid arguments');
        logger('running in updateUserSaltAndVerifier with args', systemWideUserId, salt, verifier);
        const query = `update ${config.get('tables.userTable')} set salt = $1, verifier = $2 where system_wide_user_id = $3 returning insertion_id, update_time`;
        const values = [salt, verifier, systemWideUserId];

        const response = await rdsConnection.updateRecord(query, values);
        logger('salt and verifier update returned:', response);

        return {
            message: response.rows,
            statusCode: 0
        };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return {
            message: err.message,
            statusCode: 1
        };
    };
};


module.exports.updateServerEphemeralSecret = async (systemWideUserId, serverEphemeralSecret) => {
    try {
        logger('running in  updateServerEphemeralSecret with args', systemWideUserId, serverEphemeralSecret); // to be removed
        const query = `update ${config.get('tables.userTable')} set server_ephemeral_secret = $1 where system_wide_user_id = $2 returning insertion_id, update_time`;
        const values = [serverEphemeralSecret, systemWideUserId];

        const response = await rdsConnection.updateRecord(query, values);
        logger('credentials ephemeral update returned:', response);

        return response.rows
    } catch (err) {
        logger('FATAL_ERROR:', err);
        throw new Error(err.message);
    };
};


module.exports.getUserCredentials = async (systemWideUserId) => {
    try {
        logger('running in getUserCredentials with args:', systemWideUserId);
        const query = `select * from  ${config.get('tables.userTable')} where system_wide_user_id = $1`;
        const value = [systemWideUserId];

        // response returns [] on non-existent user
        const response = await rdsConnection.selectQuery(query, value);
        logger('got this back from credentials rds extraction query:', response);
        if (response.length == 0) throw new Error('Credentials not found')

        return response
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return {error: err.message};
    };
};
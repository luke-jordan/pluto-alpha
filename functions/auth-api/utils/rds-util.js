'use strict';

const logger = require('debug')('pluto:auth:rds-util-main')
const config = require('config');
const RdsConnection = require('rds-common');

const rdsConnection = new RdsConnection(config.get('db'));


module.exports.createNewUser = (systemWideUserId, salt, verifier) => {
    return {
        systemWideUserId: systemWideUserId,
        salt: salt,
        verifier: verifier,
        serverEphemeralSecret: null
    };
};


// consolidate below?
module.exports.insertNewUser = async (newUser) => {
    try {
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
        logger('running in updateUserSaltAndVerifier with args', systemWideUserId, salt, verifier);
        const query = `update ${config.get('tables.userTable')} set salt = $1, verifier = $2 where system_wide_user_id = $3 returning insertion_id, updated_time`;
        const values = [salt, verifier, systemWideUserId];

        const response = await rdsConnection.updateRecord(query, values);
        logger('credentials update returned:', response);

        return {
            databaseResponse: response
        };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        throw new Error(err.message);
    };
};


module.exports.updateServerEphemeralSecret = async (systemWideUserId, serverEphemeralSecret) => {
    try {
        logger('running in  updateServerEphemeralSecret with args', systemWideUserId, serverEphemeralSecret); // to be removed
        const query = `update ${config.get('tables.userTable')} set server_ephemeral_secret = $1 where system_wide_user_id = $2 returning insertion_id, update_time`;
        const values = [serverEphemeralSecret, systemWideUserId];

        const response = await rdsConnection.updateRecord(query, values);
        logger('credentials ephemeral update returned:', response);

        return response
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

        const response = await rdsConnection.selectQuery(query, value);
        logger('got this back from credentials rds extraction query:', response);

        return response
    } catch (err) {
        logger('FATAL_ERROR:', err);
        throw new Error(err.message);
    };
};
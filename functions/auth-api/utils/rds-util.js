'use strict';

const logger = require('debug')('pluto:auth-rds-utl:main')

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


module.exports.insertNewUser = async (newUser) => {
    const insertionQuery = `insert into ${config.get('tables.userTable')} (system_wide_user_id, salt, verifier, server_ephemeral_secret) values %L returning insertion_id, creation_time`;
    const insertionColumns = '${systemWideUserId}, ${salt}, ${verifier}, ${serverEphemeralSecret}';
    const insertionList = [newUser];

    const response = await rdsConnection.insertRecords(insertionQuery, insertionColumns, insertionList);

    return {
        databaseResponse: response.rows 
    };
};


module.exports.updateUserSaltAndVerifier = (systemWideUserId, salt, verifier) => {
    // This function updates the user credentials table with a new salt and verifier
};
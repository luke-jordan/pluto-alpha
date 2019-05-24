const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection();

const decamelize = require('decamelize');

const decamelizeObjectKeys = (object) => Object.keys(object).reduce((o, key) => ({ ...o, [decamelize(key)]: object[key] }), { });

module.exports.createNewUser = (systemWideUserId, salt, verifier) => {
    return decamelizeObjectKeys({
        systemWideUserId: systemWideUserId,
        salt: salt,
        verifier: verifier,
        serverEphemeralSecret: null,
        updatedTime: null
    });
};

module.exports.insertNewUser = (newUser) => {
    const insertionQuery = `insert into userTable (system_wide_user_id, salt, verifier, server_ephemeral_secret, created_at) values %L returning insertion_id`;
    const insertionColumns = '${system_wide_user_id}, ${salt}, ${verifier}, ${server_ephemeral_secret}, ${created_at}';
    const insertionList = [newUser];

    const response = rdsConnection.insertRecords(insertionQuery, insertionColumns, insertionList);
    
    return {
        databaseResponse: response 
    };
};
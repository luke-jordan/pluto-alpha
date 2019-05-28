const config = require('config');

const RdsConnection = require('rds-common');
const rdsConnection = new RdsConnection(config.get('db'));

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


module.exports.insertNewUser = async (newUser) => {
    const insertionQuery = `insert into userTable (system_wide_user_id, salt, verifier, server_ephemeral_secret, created_at) values %L returning insertion_id`;
    const insertionColumns = '${system_wide_user_id}, ${salt}, ${verifier}, ${server_ephemeral_secret}, ${created_at}';
    const insertionList = [newUser];

    const response = await rdsConnection.insertRecords(insertionQuery, insertionColumns, insertionList);
    
    return {
        databaseResponse: response 
    };
};


module.exports.updateUserPassword = (systemWideUserId, JsonWebToken, newPassword) => {
    // This function assumes user identity has already beeen verified.
    // The jwt passed in conatins the users permissions which will be checked before any
    // operations are executed. 
}
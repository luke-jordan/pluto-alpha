const uuid = require('uuid/v4');
const config = require('config');

module.exports.expectedNewUser = {
    systemWideUserId: uuid(),
    salt: '53ae324ef234i',
    verifier:'34eai33536io466o456',
    serverEphemeralSecret: '986ea45o34e'
};

module.exports.recievedNewUser = {
    systemWideUserId: exports.expectedNewUser.systemWideUserId,
    salt: exports.expectedNewUser.salt,
    verifier: exports.expectedNewUser.verifier,
    serverEphemeralSecret: exports.expectedNewUser.serverEphemeralSecret
};

module.exports.expectedInsertionQuery = `insert into ${config.get('tables.userTable')} (system_wide_user_id, salt, verifier, server_ephemeral_secret) values %L returning insertion_id, creation_time`;
module.exports.expectedInsertionColumns = '${systemWideUserId}, ${salt}, ${verifier}, ${serverEphemeralSecret}';
module.exports.expectedInsertionList = [exports.expectedNewUser];

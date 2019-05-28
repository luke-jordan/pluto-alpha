const uuid = require('uuid/v4')


module.exports.expectedNewUser = {
    system_wide_user_id: uuid(),
    salt: '53ae324ef234i',
    verifier:'34eai33536io466o456',
    server_ephemeral_secret: '986ea45o34e',
    created_at: Date()
};

module.exports.recievedNewUser = {
    systemWideUserId: exports.expectedNewUser.system_wide_user_id,
    salt: exports.expectedNewUser.salt,
    verifier: exports.expectedNewUser.verifier,
    serverEphemeralSecret: exports.expectedNewUser.server_ephemeral_secret,
    createdAt: exports.expectedNewUser.created_at
}

module.exports.expectedInsertionQuery = `insert into userTable (system_wide_user_id, salt, verifier, server_ephemeral_secret, creation_time, updated_time) values %L returning insertion_id, creation_time`;
module.exports.expectedInsertionColumns = '${systemWideUserId}, ${salt}, ${verifier}, ${serverEphemeralSecret}';
module.exports.expectedInsertionList = [expectedNewUser];

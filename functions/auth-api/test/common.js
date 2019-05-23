const uuid = require('uuid/v4')


const expectedNewUser = {
    system_wide_user_id: uuid(),
    salt: '53ae324ef234i',
    verifier:'34eai33536io466o456',
    server_ephemeral_secret: '986ea45o34e',
    created_at: Date()
};

const recievedNewUser = {
    systemWideUserId: expectedNewUser.system_wide_user_id,
    salt: expectedNewUser.salt,
    verifier: expectedNewUser.verifier,
    serverEphemeralSecret: expectedNewUser.server_ephemeral_secret,
    createdAt: expectedNewUser.created_at
}

module.exports.expectedInsertionQuery = `insert into userTable (system_wide_user_id, salt, verifier, server_ephemeral_secret, created_at) values %L`;
module.exports.expectedInsertionColumns = '${system_wide_user_id}, ${salt}, ${verifier}, ${server_ephemeral_secret}, ${created_at}';
module.exports.expectedInsertionList = [expectedNewUser];


module.exports = {
    expectedNewUser,
    recievedNewUser
}
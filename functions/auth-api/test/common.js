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

module.exports.getStubArgs = (requestedStub, systemWideUserId = null) => {
    switch(requestedStub) {
        case 'deriveClientSession':
            return ['mock client secret ephemeral', 'mock server public ephemeral', 'andpepper', systemWideUserId, 'mock client private key'];
        case 'deriveServerSession':
            return ['mock server secret ephemeral', 'mock client public ephemeral', 'andpepper', systemWideUserId, 'mock persisted verifier', 'mock client session proof'];
        case 'deriveSessionOnNonResponsiveServer':
            return ['mock client secret ephemeral', 'mock server public ephemeral', 'andpepper', 'mock system-wide user id to unavailable server', 'mock client private key'];
        case 'serverSessionProofAvailable':
            return {
                systemWideUserId: systemWideUserId,
                clientSessionProof: 'mock client session proof',
                clientPublicEphemeral: 'mock client public ephemeral'
            };
        case 'serverSessionProofUnavailble':
            return {
                systemWideUserId: 'mock system-wide user id to unavailable server',
                clientSessionProof: 'mock client session proof',
                clientPublicEphemeral: 'mock client public ephemeral'
            };
        case 'saltAndServerPublicEphemeralAvailable':
            return {
                systemWideUserId: systemWideUserId,
                clientPublicEphemeral: 'mock client public ephemeral'
            };
        case 'saltAndServerPublicEphemeralUnavailable':
            return  {
                systemWideUserId: 'mock system-wide user id to unavailable server 1',
                clientPublicEphemeral: 'mock client public ephemeral'
            };
        default:
            throw new Error('No arguments exist for requested stub \'' + requestedStub + '\'');
    };
};


module.exports.expectedInsertionQuery = `insert into ${config.get('tables.userTable')} (system_wide_user_id, salt, verifier, server_ephemeral_secret) values %L returning insertion_id, creation_time`;
module.exports.expectedInsertionColumns = '${systemWideUserId}, ${salt}, ${verifier}, ${serverEphemeralSecret}';
module.exports.expectedInsertionList = [exports.expectedNewUser];


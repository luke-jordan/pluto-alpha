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
        case 'validTokenToLambdaAuthorizer':
            return { 
                url: 'https://85d15dc6.ngrok.io/validate-token',
                method: 'GET',
                qs:
                { token: 'a_valid.auth.token',
                verifyOptions:
                    { issuer: 'Pluto Saving',
                    subject: 'a-system-wide-user-id',
                    audience: 'https://plutosaving.com' } },
                json: true 
            };
        case 'invalidTokenToLambdaAuthorizer':
            return {
                url: 'https://85d15dc6.ngrok.io/validate-token',
                method: 'GET',
                qs:
                { token: 'an_invalid.auth.token',
                verifyOptions:
                    { issuer: 'Pluto Saving',
                    subject: 'a-system-wide-user-id',
                    audience: 'https://plutosaving.com' } },
                json: true 
            };
        default:
            throw new Error('No arguments exist for requested stub \'' + requestedStub + '\'');
    };
};


module.exports.expectedAuthorizationResponseOnValidToken = {
    principalId: 'a-system-wide-user-id',
    context: { 
        systemWideUserId: 'a-system-wide-user-id',
        role: 'Default User Role',
        permissions: [ 'EditProfile', 'CreateWallet', 'CheckBalance' ] 
    },
    policyDocument: { 
        Version: '2012-10-17', 
        Statement: [{
            Action: 'execute-api:Invoke',
            Effect: 'Allow',
            resource: 'arn'
        }]
    }
};

module.exports.expectedRequestPromiseResponseOnValidToken = { 
    verified: true,
    decoded:{ 
        systemWideUserId: 'a-system-wide-user-id',
        role: 'Default User Role',
        permissions: [ 'EditProfile', 'CreateWallet', 'CheckBalance' ],
        iat: 1559638875,
        exp: 1560243675,
        aud: 'https://plutosaving.com',
        iss: 'Pluto Saving',
        sub: 'a-system-wide-user-id' 
    } 
};

module.exports.expectedRequestPromiseResponseOnInvalidToken = {
    verified: false
};

module.exports.expectedInsertionQuery = `insert into ${config.get('tables.userTable')} (system_wide_user_id, salt, verifier, server_ephemeral_secret) values %L returning insertion_id, creation_time`;
module.exports.expectedInsertionColumns = '${systemWideUserId}, ${salt}, ${verifier}, ${serverEphemeralSecret}';
module.exports.expectedInsertionList = [exports.expectedNewUser];


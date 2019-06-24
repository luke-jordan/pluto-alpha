const logger = require('debug')('pluto:auth:jwt-λ-test');
const config = require('config');
const sinon = require('sinon');
const uuid = require('uuid/v4');
const chai = require('chai');
const expect = chai.expect;
const proxyquire = require('proxyquire');

let signJwtStub = sinon.stub();
let verifyJwtStub = sinon.stub();
let decodeJwtStub = sinon.stub();
let getPublicOrPrivateKeyStub = sinon.stub();

const mockPrivateKey = '==erg4g35gt4ehrh=='; // todo: test extraction from s3
const mockPublicKey  = '==ui34hr8iu3hr2i==';

const mockSystemWideUserId = uuid();

const jwt = proxyquire('../utils/jwt', {
    'jsonwebtoken': {
        'sign'  : signJwtStub,
        'verify': verifyJwtStub,
        'decode': decodeJwtStub
    },
    './s3-util': {
        'getPublicOrPrivateKey': getPublicOrPrivateKeyStub
    }
});

const resetStubs = () => {
    signJwtStub.reset();
    verifyJwtStub.reset();
    decodeJwtStub.reset();
    getPublicOrPrivateKeyStub.reset();
};

const mockPayload = {
    systemWideUserId: mockSystemWideUserId,
    role: "Default User Role",
    permissions: [
        "EditProfile",
        "CreateWallet",
        "CheckBalance"
    ]
};

// The jwt decryption process requires the verification options to match the sign options used
// when the token was signed. We can therefore compile both into one object for testing, as
// opposed to having two objects with the exact same content.
const mockSignOrVerifyOptions = {
    issuer: 'Pluto Saving',
    subject: mockPayload.systemWideUserId,
    audience: 'https://plutosaving.com',
    expiresIn: config.get('jwt.expiresIn'),
    algorithm: config.get('jwt.algorithm')
};

const expectedVerificationResult = {
    systemWideUserId: mockSystemWideUserId,
    role: "Default User Role",
    permissions: [
        "EditProfile",
        "CreateWallet",
        "CheckBalance"
    ],
    iat: "time when the token was issued",
    exp: "time when token will expire",
    aud: "https://plutosaving.com",
    iss: "Pluto Saving",
    sub: mockPayload.systemWideUserId
};


describe('JWT module', () => {

    before(() => {
        resetStubs();
        signJwtStub.withArgs(mockPayload, mockPrivateKey, mockSignOrVerifyOptions).returns('json.web.token');
        getPublicOrPrivateKeyStub
            .withArgs('jwt-private.key')
            .returns(mockPrivateKey);
        getPublicOrPrivateKeyStub
            .withArgs('jwt-public.key')
            .returns(mockPublicKey);
        decodeJwtStub
            .withArgs('json.web.token')
            .returns({
                header: { 
                    alg: config.get('jwt.algorithm'), 
                    typ: 'JWT' 
                },
                payload: expectedVerificationResult,
                signature:
                    'LE34Q8dSxbT6iIeCC...' 
                }
            )
        }
    );
    
    it('should generate a jwt token', async () => {
        const expectedGenerationResult = 'json.web.token';

        const result = await jwt.generateJsonWebToken(mockPayload, mockSignOrVerifyOptions);
        logger('jwt generation result:', result);
        logger('signJwtStub call details:', signJwtStub.getCall(0).args);
        
        expect(result).to.deep.equal(expectedGenerationResult);
        expect(signJwtStub).to.have.been.calledOnceWithExactly(mockPayload, mockPrivateKey, mockSignOrVerifyOptions);
    });

    it('should verify jwt token', () => {
        const expectedJwtArgs = JSON.parse(JSON.stringify(mockSignOrVerifyOptions));
        expectedJwtArgs.expiresIn = config.get('jwt.expiresIn');
        expectedJwtArgs.algorithm = [ config.get('jwt.algorithm') ];
        verifyJwtStub.withArgs('json.web.token', mockPublicKey, expectedJwtArgs).returns(expectedVerificationResult);
        
        const result = jwt.verifyJsonWebToken('json.web.token', mockSignOrVerifyOptions);

        expect(result).to.deep.equal(expectedVerificationResult);
        expect(verifyJwtStub).to.have.been.calledOnceWithExactly('json.web.token', mockPublicKey, expectedJwtArgs);
    });

    it('should return false if given invalid token', () => {
        verifyJwtStub.resetHistory();
        verifyJwtStub.withArgs('bad.web.token', mockPublicKey, sinon.match.any).throws('Invalid token');
        
        const expectedFalseVerificationResult = false;

        const result = jwt.verifyJsonWebToken('bad.web.token', mockSignOrVerifyOptions);
        logger('result of verification of a bad jwt token', result)

        expect(result).to.be.false;
        expect(result).to.deep.equal(expectedFalseVerificationResult);
        expect(verifyJwtStub).to.have.been.calledOnceWithExactly('bad.web.token', mockPublicKey, sinon.match.any);
    })

    it('should decode jwt token', () => {
        const expectedDecodedResult = {
            header: { 
                alg: config.get('jwt.algorithm'), 
                typ: 'JWT' 
            },
            payload: expectedVerificationResult,
            signature:
                'LE34Q8dSxbT6iIeCC...' 
        };

        const result = jwt.decodeJsonWebToken('json.web.token');
        logger('result from jwt decode:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedDecodedResult);
        expect(decodeJwtStub).to.have.been.calledOnceWithExactly('json.web.token');
    });

    it('should throw an error on malformed verification options', async () => {
        const expectedResponse = {error: `Invalid verifyOptions: ${mockSignOrVerifyOptions}`}

        const badVerifyOptions = {};

        const result = await jwt.verifyJsonWebToken('json.web.token', badVerifyOptions);
        logger('result from jwt verification with bad veriication options:', result)
      
        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResponse);
        expect(getPublicOrPrivateKeyStub).to.have.not.been.called;
        expect(verifyJwtStub).to.have.not.been.called;
    });

    it('should throw an error on malformed sign options', async () => {
        const expectedResponse = {error: `Invalid signOptions: ${mockSignOrVerifyOptions}`}

        const badSignOptions = {};

        const result = await jwt.generateJsonWebToken(mockPayload, badSignOptions);
        logger('result from from jwt generation request with bad sign options:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResponse);
        expect(getPublicOrPrivateKeyStub).to.have.not.been.called;
        expect(signJwtStub).to.have.not.been.called;
    });
});
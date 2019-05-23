const logger = require('debug')('pluto:auth:test');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
const proxyquire = require('proxyquire');

let signJwtStub = sinon.stub();
let verifyJwtStub = sinon.stub();
let decodeJwtStub = sinon.stub();

let readFileSyncStub = sinon.stub();
const mockPrivateKey = '==erg4g35gt4ehrh=='; // test extraction from s3?
const mockPublicKey  = '==ui34hr8iu3hr2i==';
readFileSyncStub.withArgs('./public.key', 'utf8').returns(mockPublicKey);
readFileSyncStub.withArgs('./private.key', 'utf8').returns(mockPrivateKey);

const jwt = proxyquire('../jwt', {
    'jsonwebtoken': {
        'sign'  : signJwtStub,
        'verify': verifyJwtStub,
        'decode': decodeJwtStub
    },
    'fs': {
        'readFileSync': readFileSyncStub
    }
});

const resetStubs = () => {
    signJwtStub.reset();
    verifyJwtStub.reset();
    decodeJwtStub.reset();
    readFileSyncStub.reset();
};

const mockPayload = {
    systemWideUserId: 'a system-wide user id',
    Role: "Default User Role",
    Permissions: [
        "EditProfile",
        "CreateWallet",
        "CheckBalance"
    ]
};

const mockSignOptions = {
    issuer: 'Pluto Savings',
    subject: mockPayload.systemWideUserId,
    audience: 'https://plutosavings.com'
};

const mockVerifyOptions = {
    issuer: 'Pluto Savings',
    subject: mockPayload.systemWideUserId,
    audience: 'https://plutosavings.com' 
};

const expectedVerificationResult = {
    systemWideUserId: 'a system-wide user id',
    role: "Default User Role",
    permissions: [
        "EditProfile",
        "CreateWallet",
        "CheckBalance"
    ],
    iat: "time when the token was issued",
    exp: "time when token will expire",
    aud: "https://plutosavings.com",
    iss: "Pluto Savings",
    sub: "a system-wide user id"
};


describe('JWT module', () => {

    before(() => {
        resetStubs();
        signJwtStub.withArgs(mockPayload, mockPrivateKey, mockSignOptions).returns('json.web.token');
        decodeJwtStub.withArgs('json.web.token')
            .returns({
                header: { alg: 'RS256', typ: 'JWT' },
                payload: expectedVerificationResult,
                signature:
                    'LE34Q8dSxbT6iIeCC...' 
                }
            )
        }
    );
    
    it('should generate a jwt token', () => {
        const expectedGenerationResult = 'json.web.token';

        const result = jwt.generateJsonWebToken(mockPayload, mockSignOptions);
        logger('jwt generation result:', result);
        
        expect(result).to.deep.equal(expectedGenerationResult);
        expect(signJwtStub).to.have.been.calledOnceWithExactly(mockPayload, mockPrivateKey, mockSignOptions);
    });

    it('should verify jwt token', () => {
        const expectedJwtArgs = JSON.parse(JSON.stringify(mockVerifyOptions));
        expectedJwtArgs.expiresIn = '180d';
        expectedJwtArgs.algorithm = [ 'RS256' ];
        verifyJwtStub.withArgs('json.web.token', mockPublicKey, expectedJwtArgs).returns(expectedVerificationResult);
        
        const result = jwt.verifyJsonWebToken('json.web.token', mockVerifyOptions);

        expect(result).to.deep.equal(expectedVerificationResult);
        expect(verifyJwtStub).to.have.been.calledOnceWithExactly('json.web.token', mockPublicKey, expectedJwtArgs);
    });

    it('should return false if given invalid token', () => {
        verifyJwtStub.resetHistory();
        verifyJwtStub.withArgs('bad.web.token', mockPublicKey, sinon.match.any).throws('Invalid token');
        
        const expectedFalseVerificationResult = false;

        const result = jwt.verifyJsonWebToken('bad.web.token', mockVerifyOptions);
        logger('result of verification of a bad jwt token', result)

        expect(result).to.be.false;
        expect(result).to.deep.equal(expectedFalseVerificationResult);
        expect(verifyJwtStub).to.have.been.calledOnceWithExactly('bad.web.token', mockPublicKey, sinon.match.any);
    })

    it('should decode jwt token', () => {
        const expectedDecodedResult = {
            header: { alg: 'RS256', typ: 'JWT' },
            payload: expectedVerificationResult,
            signature:
                'LE34Q8dSxbT6iIeCC...' 
        };

        const result = jwt.decodeJsonWebToken('json.web.token');
        logger('result from jwt decode:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedDecodedResult);
        expect(decodeJwtStub).to.have.been.calledOnceWithExactly('json.web.token');
    })
});
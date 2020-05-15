'use strict';

// const logger = require('debug')('jupiter:friends:test');
const config = require('config');
const uuid = require('uuid/v4');

const moment = require('moment');

const proxyquire = require('proxyquire').noCallThru();

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const helper = require('./test-helper');

const lamdbaInvokeStub = sinon.stub();
const fetchProfileStub = sinon.stub();
const ignoreRequestStub = sinon.stub();
const connectUserStub = sinon.stub();
const fetchAllRequestsStub = sinon.stub();
const fetchSingleRequestStub = sinon.stub();
const countMutualFriendsStub = sinon.stub();

const publishUserEventStub = sinon.stub();

const testLogId = uuid();
const testInitiatedUserId = uuid();
const testTargetUserId = uuid();
const testRequestId = uuid();

const testCreationTime = moment().format();

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

// eslint-disable-next-line
class MockRedis { constructor() { } }; // forcing no call through

const handler = proxyquire('../friend-request-handler', {
    './persistence/read.friends': {
        'fetchFriendRequestsForUser': fetchAllRequestsStub,
        'fetchFriendshipRequestById': fetchSingleRequestStub,
        'countMutualFriends': countMutualFriendsStub,
        'fetchUserProfile': fetchProfileStub,
        '@noCallThru': true
    },
    './persistence/write.friends': {
        'ignoreFriendshipRequest': ignoreRequestStub,
        'connectUserToFriendRequest': connectUserStub,
        '@noCallThru': true
    },
    'publish-common': {
        'publishUserEvent': publishUserEventStub,
        '@noCallThru': true
    },
    'ioredis': MockRedis,
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    }
});

const resetStubs = () => helper.resetStubs(fetchProfileStub, connectUserStub, countMutualFriendsStub, publishUserEventStub,
    fetchAllRequestsStub, ignoreRequestStub, lamdbaInvokeStub);

describe('*** UNIT TEST TARGET USER CONNECTION ***', async () => {
    const testRequestCode = 'BEAR CELL';
    const testUpdatedTime = moment().format();

    beforeEach(() => {
        resetStubs();
    });

    it('Connects target user to friend request', async () => {
        const testEvent = helper.wrapEvent({ requestCode: testRequestCode }, testTargetUserId, 'ORDINARY_USER');

        connectUserStub.withArgs(testTargetUserId, testRequestCode).resolves([{ requestId: testRequestId, updatedTime: testUpdatedTime }]);

        const connectionResult = await handler.connectFriendshipRequest(testEvent);

        expect(connectionResult).to.exist;
        expect(connectionResult).to.deep.equal(helper.wrapResponse({
            result: 'SUCCESS',
            updateLog: {
                updateResult: [{
                    requestId: testRequestId,
                    updatedTime: testUpdatedTime
                }]
            }
        }));
    });

    it('Rejects unauthorized requests', async () => {
        const connectionResult = await handler.addFriendshipRequest({ requestCode: testRequestCode });
        expect(connectionResult).to.exist;
        expect(connectionResult).to.deep.equal({ statusCode: 403 });
        expect(connectUserStub).to.have.not.been.called;
    });

    it('Returns not found if no code', async () => {
        connectUserStub.withArgs(testTargetUserId, testRequestCode).resolves([]);
        const testEvent = helper.wrapEvent({ requestCode: testRequestCode }, testTargetUserId, 'ORDINARY_USER');
        const connectionResult = await handler.connectFriendshipRequest(testEvent);
        expect(connectionResult).to.exist;
        expect(connectionResult).to.deep.equal(helper.wrapResponse({ result: 'NOT_FOUND' }, 404));
    });

});

describe('*** UNIT TEST FRIEND REQUEST EXTRACTION ***', () => {
    const testUpdatedTime = moment().format();

    const mockFriendRequest = {
        requestId: testRequestId,
        creationTime: testCreationTime,
        updatedTime: testUpdatedTime,
        requestStatus: 'PENDING',
        initiatedUserId: testInitiatedUserId,
        targetUserId: testTargetUserId,
        requestedShareItems: ['ACTIVITY_LEVEL', 'ACTIVITY_COUNT', 'SAVE_VALUES', 'BALANCE'],
        targetContactDetails: {
            contactType: 'PHONE',
            contactMethod: '27894534503'
        },
        requestType: 'CREATE',
        requestCode: 'DARK SCIENCE'
    };

    const mockProfile = {
        systemWideUserId: testInitiatedUserId,
        personalName: 'Qin Shi',
        familyName: 'Huang',
        phoneNumber: '02130940334',
        calledName: 'Ying Zheng',
        emailAddress: 'yingzheng@qin.com'
    };

    const expectedFriendRequest = { 
        type: 'RECEIVED',
        requestId: testRequestId,
        requestedShareItems: ['ACTIVITY_LEVEL', 'ACTIVITY_COUNT', 'SAVE_VALUES', 'BALANCE'],
        creationTime: testCreationTime,
        personalName: 'Qin Shi',
        familyName: 'Huang',
        calledName: 'Ying Zheng',
        numberOfMutualFriends: 12,
        requestCode: 'DARK SCIENCE'
    };

    beforeEach(() => {
        resetStubs();
    });

    it('Fetches pending friend requests for user', async () => {
        const testEvent = helper.wrapParamsWithPath({ }, 'list', testTargetUserId);
        fetchAllRequestsStub.withArgs(testTargetUserId).resolves([mockFriendRequest, mockFriendRequest]);
        fetchProfileStub.withArgs({ systemWideUserId: testInitiatedUserId }).resolves(mockProfile);
        countMutualFriendsStub.withArgs(testTargetUserId, [testInitiatedUserId]).resolves([{ [testInitiatedUserId]: 12 }]);
        const fetchResult = await handler.directRequestManagement(testEvent);
        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal(helper.wrapResponse([expectedFriendRequest, expectedFriendRequest]));
    });

    it('Rejects unauthorized requests', async () => {
        const fetchResult = await handler.findFriendRequestsForUser({ httpMethod: 'POST', body: JSON.stringify({ }) });
        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal({ statusCode: 403 });
        expect(fetchAllRequestsStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        const testEvent = helper.wrapEvent({}, testTargetUserId, 'ORDINARY_USER');
        fetchAllRequestsStub.withArgs(testTargetUserId).throws(new Error('Error!'));
        const fetchResult = await handler.findFriendRequestsForUser(testEvent);
        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal(helper.wrapResponse({ message: 'Error!' }, 500));
    });

});

describe('*** UNIT TEST IGNORE FRIEND REQUEST ***', () => {
    const testUpdatedTime = moment().format();

    beforeEach(() => {
        resetStubs();
    });

    it('Ignores a friend request properly', async () => {
        const testEvent = helper.wrapParamsWithPath({ requestId: testRequestId }, 'ignore', testTargetUserId);

        fetchSingleRequestStub.resolves({ targetUserId: testTargetUserId });
        ignoreRequestStub.withArgs(testRequestId, testTargetUserId).resolves({ updatedTime: testUpdatedTime, logId: testLogId });

        const resultOfIgnore = await handler.directRequestManagement(testEvent);

        expect(resultOfIgnore).to.exist;
        expect(resultOfIgnore).to.deep.equal(helper.wrapResponse({
            result: 'SUCCESS',
            updateLog: {
                resultOfIgnore: {
                    updatedTime: testUpdatedTime,
                    logId: testLogId
                }
            }
        }));
    });

    it('Rejects unauthorized requests', async () => {
        const resultOfIgnore = await handler.ignoreFriendshipRequest({ initiatedUserId: testInitiatedUserId });
        expect(resultOfIgnore).to.exist;
        expect(resultOfIgnore).to.deep.equal({ statusCode: 403 });
        expect(ignoreRequestStub).to.have.not.been.called;
    });

    it('Rejects attempts by other users to call', async () => {
        const testEvent = helper.wrapParamsWithPath({ requestId: testRequestId }, 'ignore', uuid());
        fetchSingleRequestStub.resolves({ targetUserId: testTargetUserId });
        const resultOfIgnore = await handler.directRequestManagement(testEvent);
        expect(resultOfIgnore).to.deep.equal({ statusCode: 403 });
        expect(ignoreRequestStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        fetchSingleRequestStub.withArgs(testRequestId).throws(new Error('Error!'));
        const testEvent = helper.wrapEvent({ requestId: testRequestId }, testTargetUserId, 'ORDINARY_USER');
        const resultOfIgnore = await handler.ignoreFriendshipRequest(testEvent);
        expect(resultOfIgnore).to.exist;
        expect(resultOfIgnore).to.deep.equal(helper.wrapResponse({ message: 'Error!' }, 500));
    });

});


describe('*** FRIENDSHIP UTIL FUNCTIONS ***', () => {

    const testSystemId = uuid();

    const testProfile = {
        systemWideUserId: testSystemId,
        personalName: 'Nurhaci',
        familyName: 'Gioro',
        phoneNumber: '16349324310',
        calledName: 'Tien-ming',
        emailAddress: 'taizu@manchu.com',
        referralCode: 'LETMEIN',
        countryCode: 'ZAF'
    };

    beforeEach(() => resetStubs());

    it('Determines if a contact method is aligned to a user', async () => {
        const lambdaArgs = helper.wrapLambdaInvoc(config.get('lambdas.lookupByContactDetails'), false, { phoneOrEmail: 'user@email.com', countryCode: 'ZAF' });
        const testEvent = helper.wrapParamsWithPath({ phoneOrEmail: 'user@email.com' }, 'seek', testSystemId);

        lamdbaInvokeStub.returns({ promise: () => ({ Payload: JSON.stringify({ statusCode: 200, body: JSON.stringify({ systemWideUserId: testSystemId })})})});
        fetchProfileStub.withArgs({ systemWideUserId: testSystemId }).resolves(testProfile);

        const result = await handler.directRequestManagement(testEvent);

        expect(result).to.exist;
        expect(result.statusCode).to.equal(200);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal({ systemWideUserId: testSystemId, targetUserName: 'Tien-ming Gioro' });
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(lambdaArgs);
        expect(fetchProfileStub).to.have.been.calledOnceWithExactly({ systemWideUserId: testSystemId });
    });

    it('Handles badly formatted email addresses', async () => {
        const expectedEmail = 'user@email.com';
        const inputEmail = 'user@EMAIL.com ';
        const lambdaArgs = helper.wrapLambdaInvoc(config.get('lambdas.lookupByContactDetails'), false, { phoneOrEmail: expectedEmail, countryCode: 'ZAF' });
        const testEvent = helper.wrapParamsWithPath({ phoneOrEmail: inputEmail }, 'seek', testSystemId);

        lamdbaInvokeStub.returns({ promise: () => ({ Payload: JSON.stringify({ statusCode: 200, body: JSON.stringify({ systemWideUserId: testSystemId })})})});
        fetchProfileStub.withArgs({ systemWideUserId: testSystemId }).resolves(testProfile);

        const result = await handler.directRequestManagement(testEvent);

        expect(result).to.exist;
        expect(result.statusCode).to.equal(200);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(lambdaArgs);
    });

    it('Also transforms phone numbers appropriately', async () => {
        const inputPhone = '081 307 4085';
        const expectedPhone = '27813074085';
        
        const lambdaArgs = helper.wrapLambdaInvoc(config.get('lambdas.lookupByContactDetails'), false, { phoneOrEmail: expectedPhone, countryCode: 'ZAF' });
        const testEvent = helper.wrapParamsWithPath({ phoneOrEmail: inputPhone }, 'seek', testSystemId);

        lamdbaInvokeStub.returns({ promise: () => ({ Payload: JSON.stringify({ statusCode: 200, body: JSON.stringify({ systemWideUserId: testSystemId })})})});
        fetchProfileStub.withArgs({ systemWideUserId: testSystemId }).resolves(testProfile);

        const result = await handler.directRequestManagement(testEvent);

        expect(result).to.exist;
        expect(result.statusCode).to.equal(200);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(lambdaArgs);
    });

    it('Obtains referral code', async () => {
        const testReferralPayload = { referralCode: 'LETMEIN', countryCode: 'ZAF', includeFloatDefaults: true };
        const testReferralDetails = { referralCode: 'LETMEIN', context: { boostAmountOffered: 'BIGCHEESE' } };    
        
        const lambdaArgs = helper.wrapLambdaInvoc(config.get('lambdas.referralDetails'), false, testReferralPayload);
        const testEvent = helper.wrapParamsWithPath({ }, 'referral', testSystemId);

        fetchProfileStub.withArgs({ systemWideUserId: testSystemId }).resolves(testProfile);
        const wrappedReferralResponse = { Payload: JSON.stringify({ body: JSON.stringify({ codeDetails: testReferralDetails }) }) };
        lamdbaInvokeStub.returns({ promise: () => wrappedReferralResponse });

        const rawResult = await handler.directRequestManagement(testEvent);
        const referralCode = helper.standardOkayChecks(rawResult);
        expect(referralCode).to.deep.equal(testReferralDetails);
        expect(fetchProfileStub).to.have.been.calledOnceWithExactly({ systemWideUserId: testSystemId });
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(lambdaArgs);
    });

});

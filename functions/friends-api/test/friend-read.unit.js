'use strict';

// const logger = require('debug')('jupiter:friends:test');
const config = require('config');
const uuid = require('uuid/v4');

const moment = require('moment');
// const format = require('string-format');

const proxyquire = require('proxyquire');
const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const helper = require('./test-helper');

const sendSmsStub = sinon.stub();
const redisGetStub = sinon.stub();
const sendEmailStub = sinon.stub();
const fetchUserStub = sinon.stub();
const getFriendsStub = sinon.stub();
const randomWordStub = sinon.stub();
const connectUserStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();
const fetchRequestStub = sinon.stub();
const fetchAccountStub = sinon.stub();
const fetchProfileStub = sinon.stub();
const ignoreRequestStub = sinon.stub();
const fetchAllRequestsStub = sinon.stub();
const fetchActiveCodesStub = sinon.stub();
const insertFriendshipStub = sinon.stub();
const insertFriendRequestStub = sinon.stub();
const deactivateFriendshipStub = sinon.stub();

const testSystemId = uuid();
const testInitiatedUserId = uuid();
const testTargetUserId = uuid();
const testRequestId = uuid();

class MockRedis {
    constructor () { 
        this.mget = redisGetStub;
    }
}

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const handler = proxyquire('../friend-read-handler', {
    './persistence/read.friends': {
        'fetchFriendRequestsForUser': fetchAllRequestsStub,
        'fetchUserByContactDetail': fetchUserStub,
        'fetchActiveRequestCodes': fetchActiveCodesStub,
        'fetchFriendshipRequestById': fetchRequestStub,
        'fetchAccountIdForUser': fetchAccountStub,
        'fetchActiveSavingFriendsForUser': getFriendsStub,
        'fetchUserProfile': fetchProfileStub
    },
    './persistence/write.friends': {
        'connectUserToFriendRequest': connectUserStub,
        'ignoreFriendshipRequest': ignoreRequestStub,
        'insertFriendRequest': insertFriendRequestStub,
        'insertFriendship': insertFriendshipStub,
        'deactivateFriendship': deactivateFriendshipStub
    },
    'publish-common': {
        'sendSystemEmail': sendEmailStub,
        'sendSms': sendSmsStub,
        '@noCallThru': true
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'ioredis': MockRedis,
    'random-words': randomWordStub
});

const resetStubs = () => helper.resetStubs(fetchUserStub, getFriendsStub, fetchProfileStub, insertFriendRequestStub, insertFriendshipStub,
    deactivateFriendshipStub, fetchActiveCodesStub, fetchRequestStub, randomWordStub, sendEmailStub, sendSmsStub, connectUserStub,
    fetchAllRequestsStub, ignoreRequestStub, fetchAccountStub, lamdbaInvokeStub, redisGetStub);

describe('*** UNIT TEST FRIEND PROFILE EXTRACTION ***', () => {
    const testActivityDate = moment().format();

    const mockProfile = (systemWideUserId) => ({
        systemWideUserId,
        personalName: 'Lie',
        familyName: 'Yukou',
        phoneNumber: '17923835934',
        calledName: 'Liezi',
        emailAddress: 'liezi@tao.com'
    });

    const mockFriendship = (userId, shareItems) => ({
        initiatedUserId: testSystemId,
        acceptedUserId: userId,
        shareItems
    });

    const expectedSavingsHeat = 23.71;

    const [firstAccId, secondAccId, thirdAccId] = [uuid(), uuid(), uuid()];

    const mockResponseFromLambda = {
        details: [
            {
                accountId: secondAccId,
                savingsHeat: `${expectedSavingsHeat}`,
                USER_SAVING_EVENT: {
                    lastActivityDate: testActivityDate,
                    lastActivityAmount: { amount: '2000', currency: 'ZAR', unit: 'HUNDREDTH_CENT' }
                }
            },
            {
                accountId: thirdAccId,
                savingsHeat: `${expectedSavingsHeat}`,
                BOOST_REDEMPTION: {
                    lastActivityDate: testActivityDate,
                    lastActivityAmount: { amount: '500', currency: 'ZAR', unit: 'HUNDREDTH_CENT' }
                }
            }
        ]
    };

    const mockResponseFromCache = (accountId) => ({
        accountId,
        savingsHeat: `${expectedSavingsHeat}`,
        WITHDRAWAL: {
            lastActivityDate: testActivityDate,
            lastActivityAmount: { amount: '100', currency: 'ZAR', unit: 'HUNDREDTH_CENT' }
        }
    });

    beforeEach(() => {
        resetStubs();
    });

    it('Fetches user friends', async () => {
        const shareItems = ['LAST_ACTIVITY_AMOUNT'];
        const [firstUserId, secondUserId, thirdUserId] = [uuid(), uuid(), uuid()];
        const includeLastActivityOfType = config.get('share.userActivities');
        const lambdaArgs = helper.wrapLambdaInvoc(config.get('lambdas.calcSavingsHeat'), false, { accountIds: [secondAccId, thirdAccId], includeLastActivityOfType });
        const testEvent = helper.wrapEvent({}, testSystemId, 'ORDINARY_USER');

        fetchProfileStub.withArgs({ systemWideUserId: firstUserId }).resolves(mockProfile(firstUserId));
        fetchProfileStub.withArgs({ systemWideUserId: secondUserId }).resolves(mockProfile(secondUserId));
        fetchProfileStub.withArgs({ systemWideUserId: thirdUserId }).resolves(mockProfile(thirdUserId));
        fetchAccountStub.withArgs(firstUserId).resolves({ [firstUserId]: firstAccId });
        fetchAccountStub.withArgs(secondUserId).resolves({ [secondUserId]: secondAccId });
        fetchAccountStub.withArgs(thirdUserId).resolves({ [thirdUserId]: thirdAccId });
        lamdbaInvokeStub.withArgs(lambdaArgs).returns({ promise: () => helper.mockLambdaResponse(mockResponseFromLambda) });
        getFriendsStub.withArgs(testSystemId).resolves([
            mockFriendship(firstUserId, shareItems),
            mockFriendship(secondUserId, shareItems),
            mockFriendship(thirdUserId, shareItems)
        ]);
        redisGetStub.withArgs(firstAccId, secondAccId, thirdAccId).resolves([
            JSON.stringify({ accountId: firstAccId, savingsHeat: `${expectedSavingsHeat}` }),
            null,
            null
        ]);

        const fetchResult = await handler.obtainFriends(testEvent);

        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal(helper.wrapResponse([
            {
                ...mockProfile(firstUserId),
                savingsHeat: {
                    accountId: firstAccId,
                    savingsHeat: `${expectedSavingsHeat}`
                }
            },
            {
                ...mockProfile(secondUserId),
                savingsHeat: {
                    accountId: secondAccId,
                    savingsHeat: `${expectedSavingsHeat}`,
                    USER_SAVING_EVENT: {
                        lastActivityAmount: { amount: '2000', currency: 'ZAR', unit: 'HUNDREDTH_CENT' }
                    }
                }  
            },
            {
                ...mockProfile(thirdUserId),
                savingsHeat: {
                    accountId: thirdAccId,
                    savingsHeat: `${expectedSavingsHeat}`,
                    BOOST_REDEMPTION: {
                        lastActivityAmount: { amount: '500', currency: 'ZAR', unit: 'HUNDREDTH_CENT' }
                    }
                }
            }
        ]));
    });

    it('Fetches admin friends too', async () => {
        const shareItems = ['LAST_ACTIVITY_DATE', 'LAST_ACTIVITY_AMOUNT'];
        const [firstUserId, secondUserId, thirdUserId] = [uuid(), uuid(), uuid()];
        const testEvent = helper.wrapEvent({}, testSystemId, 'SYSTEM_ADMIN');
       
        fetchProfileStub.withArgs({ systemWideUserId: firstUserId }).resolves(mockProfile(firstUserId));
        fetchProfileStub.withArgs({ systemWideUserId: secondUserId }).resolves(mockProfile(secondUserId));
        fetchProfileStub.withArgs({ systemWideUserId: thirdUserId }).resolves(mockProfile(thirdUserId));
        fetchAccountStub.withArgs(firstUserId).resolves({ [firstUserId]: firstAccId });
        fetchAccountStub.withArgs(secondUserId).resolves({ [secondUserId]: secondAccId });
        fetchAccountStub.withArgs(thirdUserId).resolves({ [thirdUserId]: thirdAccId });
        redisGetStub.withArgs(firstAccId, secondAccId, thirdAccId).resolves([
            JSON.stringify(mockResponseFromCache(firstAccId)),
            JSON.stringify(mockResponseFromCache(secondAccId)),
            JSON.stringify(mockResponseFromCache(thirdAccId))
        ]);
        getFriendsStub.withArgs(testSystemId).resolves([
            mockFriendship(firstUserId, shareItems),
            mockFriendship(secondUserId, shareItems),
            mockFriendship(thirdUserId, shareItems)
        ]);

        const fetchResult = await handler.obtainFriends(testEvent);

        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal(helper.wrapResponse([
            {
                ...mockProfile(firstUserId),
                savingsHeat: {
                    accountId: firstAccId,
                    savingsHeat: `${expectedSavingsHeat}`,
                    WITHDRAWAL: {
                        lastActivityDate: testActivityDate,
                        lastActivityAmount: { amount: '100', currency: 'ZAR', unit: 'HUNDREDTH_CENT' }
                    }
                }
            },
            {
                ...mockProfile(secondUserId),
                savingsHeat: {
                    accountId: secondAccId,
                    savingsHeat: `${expectedSavingsHeat}`,
                    WITHDRAWAL: {
                        lastActivityDate: testActivityDate,
                        lastActivityAmount: { amount: '100', currency: 'ZAR', unit: 'HUNDREDTH_CENT' }
                    }
                }  
            },
            {
                ...mockProfile(thirdUserId),
                savingsHeat: {
                    accountId: thirdAccId,
                    savingsHeat: `${expectedSavingsHeat}`,
                    WITHDRAWAL: {
                        lastActivityDate: testActivityDate,
                        lastActivityAmount: { amount: '100', currency: 'ZAR', unit: 'HUNDREDTH_CENT' }
                    }
                }
            }
        ]));
    });

    it('Fetches friends for admin provided user', async () => {
        const shareItems = ['LAST_ACTIVITY_DATE', 'LAST_ACTIVITY_AMOUNT'];
        const [firstUserId, secondUserId, thirdUserId] = [uuid(), uuid(), uuid()];
        const testEvent = helper.wrapEvent({ systemWideUserId: testInitiatedUserId }, testSystemId, 'SYSTEM_ADMIN');

        fetchProfileStub.withArgs({ systemWideUserId: firstUserId }).resolves(mockProfile(firstUserId));
        fetchProfileStub.withArgs({ systemWideUserId: secondUserId }).resolves(mockProfile(secondUserId));
        fetchProfileStub.withArgs({ systemWideUserId: thirdUserId }).resolves(mockProfile(thirdUserId));
        fetchAccountStub.withArgs(firstUserId).resolves({ [firstUserId]: firstAccId });
        fetchAccountStub.withArgs(secondUserId).resolves({ [secondUserId]: secondAccId });
        fetchAccountStub.withArgs(thirdUserId).resolves({ [thirdUserId]: thirdAccId });
        redisGetStub.withArgs(firstAccId, secondAccId, thirdAccId).resolves([
            JSON.stringify(mockResponseFromCache(firstAccId)),
            JSON.stringify(mockResponseFromCache(secondAccId)),
            JSON.stringify(mockResponseFromCache(thirdAccId))
        ]);
        getFriendsStub.withArgs(testInitiatedUserId).resolves([
            { initiatedUserId: testInitiatedUserId, acceptedUserId: firstUserId, shareItems },
            { initiatedUserId: secondUserId, acceptedUserId: testInitiatedUserId, shareItems },
            { initiatedUserId: testInitiatedUserId, acceptedUserId: thirdUserId, shareItems }
        ]);

        const fetchResult = await handler.obtainFriends(testEvent);
        
        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal(helper.wrapResponse([
            {
                ...mockProfile(firstUserId),
                savingsHeat: mockResponseFromCache(firstAccId)
            },
            {
                ...mockProfile(secondUserId),
                savingsHeat: mockResponseFromCache(secondAccId)
  
            },
            {
                ...mockProfile(thirdUserId),
                savingsHeat: mockResponseFromCache(thirdAccId)
            }
        ]));
    });

    it('Rejects unauthorized requests', async () => {
        const fetchResult = await handler.obtainFriends({ systemWideUserId: testInitiatedUserId });
        expect(fetchResult).to.exist;
        expect(fetchResult).to.deep.equal({ statusCode: 403 });
        expect(getFriendsStub).to.have.not.been.called;
        expect(fetchProfileStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        getFriendsStub.withArgs(testSystemId).throws(new Error('Error'));
        const testEvent = helper.wrapEvent({}, testSystemId, 'ORDINARY_USER');
        const fetchResult = await handler.obtainFriends(testEvent);
        expect(fetchResult).to.deep.equal(helper.wrapResponse({ message: 'Error' }, 500));
        expect(fetchProfileStub).to.have.not.been.called;
    });

});

describe('*** UNIT TEST FRIEND REQUEST EXTRACTION ***', () => {
    const testCreationTime = moment().format();
    const testUpdatedTime = moment().format();

    const mockFriendRequest = {
        requestId: testRequestId,
        creationTime: testCreationTime,
        updatedTime: testUpdatedTime,
        requestStatus: 'PENDING',
        customerMessage: 'Hey Jane. Lets save some lettuce, take over the world.',
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

    const expectedFriendRequest = { ...mockFriendRequest, initiatedUserName: 'Ying Zheng' };

    beforeEach(() => {
        resetStubs();
    });

    it('Fetches pending friend requests for user', async () => {
        const testEvent = helper.wrapEvent({ }, testTargetUserId, 'ORDINARY_USER');
        fetchAllRequestsStub.withArgs(testTargetUserId).resolves([mockFriendRequest, mockFriendRequest]);
        fetchProfileStub.withArgs({ systemWideUserId: testInitiatedUserId }).resolves(mockProfile);
        const fetchResult = await handler.findFriendRequestsForUser(testEvent);
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

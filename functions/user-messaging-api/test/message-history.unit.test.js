'use strict';

// const logger = require('debug')('jupiter:message:picker-test');
const uuid = require('uuid/v4');
const moment = require('moment');

const testHelper = require('./message.test.helper');

const proxyquire = require('proxyquire').noCallThru();

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));

const expect = chai.expect;

const getUserMessagesStub = sinon.stub();

const resetStubs = () => testHelper.resetStubs(getUserMessagesStub);

const testUserId = uuid();
const testBoostId = uuid();

const testExpiryMoment = moment().add(6, 'hours');

const handler = proxyquire('../message-picking-handler', {
    './persistence/rds.usermessages': {
        'fetchUserHistoricalMessages': getUserMessagesStub
    },
    '@noCallThru': true
});

describe('*** UNIT TEST MESSAGE HISTORY ***', () => {

    const testMsgId = uuid();
    const testSuccessMsgId = uuid();
    const testCreationTime = moment().subtract(10, 'minutes');

    const firstMsgFromRds = {
        messageId: testMsgId,
        messageTitle: 'Boost available!',
        messageBody: 'Hello! Jupiter is now live. To celebrate, if you add $10, you get $10 boost',
        creationTime: testCreationTime.format(),
        startTime: moment().subtract(10, 'minutes').format(),
        endTime: testExpiryMoment.format(),
        messagePriority: 20,
        display: { type: 'CARD', titleType: 'EMPHASIS', iconType: 'BOOST_ROCKET' },
        actionContext: { actionToTake: 'ADD_CASH', boostId: testBoostId },
        followsPriorMessage: false,
        hasFollowingMessage: true,
        messageSequence: { msgOnSuccess: testSuccessMsgId }
    };

    const secondMsgFromRds = {
        messageId: testSuccessMsgId,
        messageTitle: 'Congratulations!',
        messageBody: 'You earned a boost! Jupiter rewards you for saving, not spending',
        lastDisplayedBody: 'Welcome to Jupiter',
        creationTime: testCreationTime.format(),
        startTime: moment().subtract(10, 'minutes').format(),
        endTime: testExpiryMoment.format(),
        messagePriority: 10,
        display: { type: 'CARD', iconType: 'SMILEY_FACE' },
        actionContext: { triggerBalanceFetch: true, boostId: testBoostId },
        followsPriorMessage: true,
        hasFollowingMessage: false
    };

    beforeEach(() => {
        resetStubs();
    });

    it('Fetches last displayed message', async () => {
        getUserMessagesStub.resolves([firstMsgFromRds, secondMsgFromRds]);

        const expectedResult = [
            { ...firstMsgFromRds, displayedBody: firstMsgFromRds.messageBody },
            { ...secondMsgFromRds, displayedBody: secondMsgFromRds.lastDisplayedBody }
        ];

        const requestContext = { authorizer: { systemWideUserId: testUserId }};
        const queryStringParameters = { systemWideUserId: testUserId, displayTypes: 'CARD' };
        
        const fetchResult = await handler.getUserHistoricalMessages({ queryStringParameters, requestContext });

        expect(fetchResult).to.exist;
        testHelper.standardOkayChecks(fetchResult, expectedResult);
        expect(getUserMessagesStub).to.have.been.calledOnceWithExactly(testUserId, ['CARD'], true);
    });

    it('Handles thrown errors', async () => {
        getUserMessagesStub.throws(new Error('Error'));

        const requestContext = { authorizer: { systemWideUserId: testUserId }};
        const queryStringParameters = { systemWideUserId: testUserId, displayTypes: 'CARD' };
        
        const fetchResult = await handler.getUserHistoricalMessages({ queryStringParameters, requestContext });

        expect(fetchResult).to.exist;
        testHelper.standardOkayChecks(fetchResult, 'Error', 500);
    });

});

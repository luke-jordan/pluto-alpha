'use strict';

const logger = require('debug')('jupiter:message:picker-test');
const config = require('config');
const uuid = require('uuid/v4');
const moment = require('moment');

const testHelper = require('./message.test.helper');

const proxyquire = require('proxyquire').noCallThru();

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));

const expect = chai.expect;

const getMessagesStub = sinon.stub();
const getAccountFigureStub = sinon.stub();
const fetchDynamoRowStub = sinon.stub();
const resetStubs = () => testHelper.resetStubs(getMessagesStub, getAccountFigureStub, fetchDynamoRowStub);

const profileTable = config.get('tables.dynamoProfileTable');

const testUserId = uuid();
const testBoostId = uuid();

const testOpenMoment = moment('2019-07-01');
const testExpiryMoment = moment().add(6, 'hours');

const handler = proxyquire('../message-picking-handler', {
    './persistence/rds.msgpicker': {
        'getNextMessage': getMessagesStub, 
        'getUserAccountFigure': getAccountFigureStub,
        '@noCallThru': true
    },
    'dynamo-common': {
        'fetchSingleRow': fetchDynamoRowStub
    },
    '@noCallThru': true
});

describe('**** UNIT TESTING MESSAGE ASSEMBLY **** Simple assembly', () => {

    const relevantProfileCols = ['system_wide_user_id', 'personal_name', 'family_name', 'creation_time_epoch_millis', 'default_currency'];

    const minimalMsgFromTemplate = (template) => ({
        destinationUserId: testUserId,
        followsPriorMsg: false,
        messagePriority: 10,
        endTime: testExpiryMoment,
        messageBody: template
    });

    before(() => {
        fetchDynamoRowStub.withArgs(profileTable, { systemWideUserId: testUserId }, relevantProfileCols).resolves({ 
            systemWideUserId: testUserId, 
            personalName: 'Luke', 
            familyName: 'Jordan', 
            creationTimeEpochMillis: testOpenMoment.valueOf(), 
            defaultCurrency: 'USD'
        });
        getAccountFigureStub.withArgs({ systemWideUserId: testUserId, operation: 'interest::WHOLE_CENT::USD::0' }).
            resolves({ currency: 'USD', unit: 'WHOLE_CENT', amount: 10000 });
        getAccountFigureStub.withArgs({ systemWideUserId: testUserId, operation: 'balance::WHOLE_CENT::USD' }).
            resolves({ currency: 'USD', unit: 'WHOLE_CENT', amount: 800000 })
    });

    it('Fills in message templates properly', async () => {
        const expectedMessage = 'Hello Luke Jordan. Did you know you have earned $100 in interest since you opened your account in July 2019?';
        getMessagesStub.withArgs(testUserId).resolves([minimalMsgFromTemplate(
            'Hello #{user_full_name}. Did you know you have earned #{total_interest} in interest since you opened your account in #{opened_date}?' 
        )]);

        const filledMessage = await handler.fetchAndFillInNextMessage(testUserId);
        logger('Filled message: ', filledMessage);
        expect(filledMessage).to.exist;
        expect(filledMessage[0].body).to.equal(expectedMessage);
    });

    it('Fills in account balances properly', async () => {
        const expectedMessage = 'Hello Luke. Your balance this week after earning more interest and boosts is $8,000.';
        getMessagesStub.withArgs(testUserId).resolves([minimalMsgFromTemplate(
            'Hello #{user_first_name}. Your balance this week after earning more interest and boosts is #{current_balance}.'
        )]);

        const filledMessage = await handler.fetchAndFillInNextMessage(testUserId);
        expect(filledMessage).to.exist;
        expect(filledMessage[0].body).to.equal(expectedMessage);
    });

    it('Dry run triggers without touching RDS etc', async () => {
        const authContext= { authorizer: { systemWideUserId: testUserId }};
        const testEvent = { queryStringParameters: { gameDryRun: true }, requestContext: authContext };
        const dryRunMessages = await handler.getNextMessageForUser(testEvent);
        expect(dryRunMessages).to.exist;
    });

    it('Returns unauthorized if no authorization', async () => {
        const unauthorizedResponse = await handler.getNextMessageForUser({});
        expect(unauthorizedResponse).to.deep.equal({ statusCode: 403 });
    });

    it('Catches errors properly', async () => {
        const authContext= { authorizer: { systemWideUserId: 'this-is-a-bad-user' }};
        getMessagesStub.withArgs('this-is-a-bad-user').rejects(new Error('Bad user caused error!'));
        const testEvent = { requestContext: authContext };
        const errorEvent = await handler.getNextMessageForUser(testEvent);
        expect(errorEvent).to.exist;
        expect(errorEvent).to.deep.equal({ statusCode: 500, body: JSON.stringify('Bad user caused error!') });
    });

});

describe('**** UNIT TESTING MESSAGE ASSEMBLY *** Boost based, complex assembly', () => {

    const testMsgId = uuid();
    const testSuccessMsgId = uuid();

    const firstMsgFromRds = {
        messageId: testMsgId,
        messageTitle: 'Boost available!',
        messageBody: 'Hello! Jupiter is now live. To celebrate, if you add $10, you get $10 boost',
        startTime: moment().subtract(10, 'minutes'),
        endTime: testExpiryMoment,
        messagePriority: 20,
        displayType: 'CARD',
        displayInstructions: { titleType: 'EMPHASIS', iconType: 'BOOST_ROCKET' },
        actionContext: { actionToTake: 'ADD_CASH', boostId: testBoostId },
        followsPriorMsg: false,
        hasFollowingMsg: true,
        followingMessages: { msgOnSuccess: testSuccessMsgId }
    };

    const secondMsgFromRds = {
        messageId: testSuccessMsgId,
        messageTitle: 'Congratulations!',
        messageBody: 'You earned a boost! Jupiter rewards you for saving, not spending',
        startTime: moment().subtract(10, 'minutes'),
        endTime: testExpiryMoment,
        messagePriority: 10,
        displayType: 'MODAL',
        displayInstructions: { iconType: 'SMILEY_FACE' },
        actionContext: { triggerBalanceFetch: true, boostId: testBoostId },
        followsPriorMsg: true,
        hasFollowingMsg: false
    };

    const anotherHighPriorityMsg = {
        messageId: uuid(),
        messageTitle: 'Congratulations on something else!',
        messageBody: 'You earned a boost! But you should not see this yet',
        startTime: moment().subtract(1, 'minutes'),
        endTime: testExpiryMoment,
        messagePriority: 20,
        displayType: 'MODAL',
        displayInstructions: { iconType: 'SMILEY_FACE' },
        actionContext: { triggerBalanceFetch: true, boostId: testBoostId },
        followsPriorMsg: false,
        hasFollowingMsg: false
    };

    const expectedFirstMessage = {
        messageId: testMsgId,
        title: 'Boost available!',
        body: 'Hello! Jupiter is now live. To celebrate, if you add $10, you get $10 boost',
        priority: 20,
        actionToTake: 'ADD_CASH',
        display: {
            type: 'CARD',
            titleType: 'EMPHASIS',
            iconType: 'BOOST_ROCKET'
        },
        actionContext: {
            boostId: testBoostId,
            msgOnSuccess: testSuccessMsgId,
            sequenceExpiryTimeMillis: testExpiryMoment.valueOf()
        },
        hasFollowingMsg: true
    };

    const expectedSecondMsg = {
        messageId: testSuccessMsgId,
        title: 'Congratulations!',
        body: 'You earned a boost! Jupiter rewards you for saving, not spending',
        priority: 10,
        triggerBalanceFetch: true,
        display: {
            type: 'MODAL',
            iconType: 'SMILEY_FACE'
        },
        actionContext: {
            boostId: testBoostId
        },
        hasFollowingMsg: false
    };

    beforeEach(() => resetStubs());

    it('Fetches and assembles a set of two simple boost messages correctly', async () => {
        getMessagesStub.withArgs(testUserId).resolves([firstMsgFromRds, secondMsgFromRds]);
        
        const fetchResult = await handler.getNextMessageForUser(testHelper.wrapEvent({ }, testUserId, 'ORDINARY_USER'));
        expect(fetchResult).to.exist;
        const bodyOfFetch = testHelper.standardOkayChecks(fetchResult);
        expect(bodyOfFetch).to.have.property('messagesToDisplay');
        expect(bodyOfFetch.messagesToDisplay).to.be.an('array');
        expect(bodyOfFetch.messagesToDisplay[0]).to.deep.equal(expectedFirstMessage);
        expect(bodyOfFetch.messagesToDisplay[1]).to.deep.equal(expectedSecondMsg);
    });

    it('Within flow message parameter works', async () => {
        getMessagesStub.withArgs(testUserId).resolves([firstMsgFromRds, secondMsgFromRds]);
        const requestContext = { authorizer: { systemWideUserId: testUserId }};
        const queryStringParameters = { anchorMessageId: testMsgId };
        
        const fetchResult = await handler.getNextMessageForUser({ queryStringParameters, requestContext });
        expect(fetchResult).to.exist;
        const bodyOfFetch = testHelper.standardOkayChecks(fetchResult);
        expect(bodyOfFetch).to.deep.equal({ messagesToDisplay: [expectedFirstMessage, expectedSecondMsg] });
    });

    it('Sorts same priority messages by creation time properly', async () => {
        getMessagesStub.withArgs(testUserId).resolves([firstMsgFromRds, secondMsgFromRds, anotherHighPriorityMsg]);
        
        const fetchResult = await handler.getNextMessageForUser(testHelper.wrapEvent({ }, testUserId, 'ORDINARY_USER'));
        expect(fetchResult).to.exist;
        const bodyOfFetch = testHelper.standardOkayChecks(fetchResult);
        expect(bodyOfFetch).to.deep.equal({ messagesToDisplay: [expectedFirstMessage, expectedSecondMsg] });
    });


});

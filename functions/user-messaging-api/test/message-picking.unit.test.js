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
const updateMessageStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();

const fetchDynamoRowStub = sinon.stub();

const resetStubs = () => testHelper.resetStubs(getMessagesStub, getAccountFigureStub, updateMessageStub, fetchDynamoRowStub, lamdbaInvokeStub);

const profileTable = config.get('tables.dynamoProfileTable');

const testUserId = uuid();
const testBoostId = uuid();
const testMessageId = uuid();

const testOpenMoment = moment('2019-07-01');
const testExpiryMoment = moment().add(6, 'hours');

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const handler = proxyquire('../message-picking-handler', {
    './persistence/rds.msgpicker': {
        'getNextMessage': getMessagesStub, 
        'getUserAccountFigure': getAccountFigureStub,
        'updateUserMessage': updateMessageStub,
        '@noCallThru': true
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'dynamo-common': {
        'fetchSingleRow': fetchDynamoRowStub
    },
    '@noCallThru': true
});

describe('**** UNIT TESTING MESSAGE ASSEMBLY **** Simple assembly', () => {

    const relevantProfileCols = ['system_wide_user_id', 'personal_name', 'family_name', 'creation_time_epoch_millis', 'default_currency'];

    const minimalMsgFromTemplate = (template, priority, followsPriorMsg = false) => ({
        destinationUserId: testUserId,
        creationTime: testOpenMoment,
        followsPriorMessage: followsPriorMsg,
        messagePriority: priority,
        endTime: testExpiryMoment,
        messageBody: template
    });

    const assembleLambdaInvoke = (operation) => (
        testHelper.wrapLambdaInvoc('user_history_aggregate', false, { aggregates: [operation], systemWideUserId: testUserId })
    );

    beforeEach(() => {
        resetStubs();
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
            resolves({ currency: 'USD', unit: 'WHOLE_CENT', amount: 800000 });
    });

    it('Fills in message templates properly', async () => {
        logger('HUUUUH MAT: ', testUserId);
        const expectedMessage = 'Hello Luke Jordan. Did you know you have earned $100 in interest since you opened your account in July 2019?';
        getMessagesStub.withArgs(testUserId, ['CARD']).resolves([minimalMsgFromTemplate(
            'Hello #{user_full_name}. Did you know you have earned #{total_interest} in interest since you opened your account in #{opened_date}?' 
        )]);

        const queryResult = testHelper.mockLambdaResponse({ results: [{ amount: 1000000, unit: 'HUNDREDTH_CENT', currency: 'USD' }] });
        lamdbaInvokeStub.returns({ promise: () => queryResult});

        const filledMessage = await handler.fetchAndFillInNextMessage({ destinationUserId: testUserId });
        logger('Filled message: ', filledMessage);
        expect(filledMessage).to.exist;
        expect(filledMessage[0].body).to.equal(expectedMessage);

        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(assembleLambdaInvoke('interest::HUNDREDTH_CENT::USD::0'));
    });

    it('Fills in message templates properly, happy path 2', async () => {
        const expectedMessage = 'Hello Luke Jordan. You have just saved a whopping $100. Congratulations on this fearsome feat.';
        getMessagesStub.withArgs(testUserId, ['CARD']).resolves([minimalMsgFromTemplate(
            'Hello #{user_full_name}. You have just saved a whopping #{last_saved_amount}. Congratulations on this fearsome feat.'
        )]);

        const queryResult = testHelper.mockLambdaResponse({ results: [{ amount: 1000000, unit: 'HUNDREDTH_CENT', currency: 'USD' }] });
        lamdbaInvokeStub.returns({ promise: () => queryResult});

        const filledMessage = await handler.fetchAndFillInNextMessage({ destinationUserId: testUserId });
        logger('Filled message: ', filledMessage);
        expect(filledMessage).to.exist;
        expect(filledMessage[0].body).to.equal(expectedMessage);

        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(assembleLambdaInvoke('last_saved_amount::USD'));
    });

    it('Fills in account balances properly', async () => {
        logger('HUUUUH ABT: ', testUserId);
        const testDestinationUserId = uuid();
        const expectedMessage = 'Hello Luke. Your balance this week after earning more interest and boosts is $8,000.';
        getMessagesStub.withArgs(testDestinationUserId, ['CARD']).resolves([{
            destinationUserId: testDestinationUserId,
            creationTime: testOpenMoment,
            followsPriorMessage: false,
            messagePriority: 0,
            endTime: testExpiryMoment,
            messageBody: 'Hello #{user_first_name}. Your balance this week after earning more interest and boosts is #{current_balance}.'
        }]);

        const queryResult = testHelper.mockLambdaResponse({ results: [{ amount: 80000000, unit: 'HUNDREDTH_CENT', currency: 'USD' }] });
        lamdbaInvokeStub.returns({ promise: () => queryResult});
        fetchDynamoRowStub.withArgs(profileTable, { systemWideUserId: testDestinationUserId }, ['personal_name', 'family_name']).resolves({
            systemWideUserId: testUserId, 
            personalName: 'Luke', 
            familyName: 'Jordan'
        });

        fetchDynamoRowStub.withArgs(profileTable, { systemWideUserId: testDestinationUserId }, relevantProfileCols).resolves({ 
            systemWideUserId: testUserId, 
            personalName: 'Luke', 
            familyName: 'Jordan', 
            creationTimeEpochMillis: testOpenMoment.valueOf(), 
            defaultCurrency: 'USD'
        });

        const filledMessage = await handler.fetchAndFillInNextMessage({ destinationUserId: testDestinationUserId });
        expect(filledMessage).to.exist;
        expect(filledMessage[0].body).to.equal(expectedMessage);
        expect(fetchDynamoRowStub).to.have.been.calledTwice;
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(testHelper.wrapLambdaInvoc('user_history_aggregate', false, { aggregates: ['balance::HUNDREDTH_CENT::USD'], systemWideUserId: testDestinationUserId }));
    });

    it('Handles last capitalization properly', async () => {
        logger('HUUUUH LCT: ', testUserId);
        const expectedMessage = 'Hello Luke. This week you got paid $10.05 in interest';
        getMessagesStub.withArgs(testUserId, ['CARD']).resolves([minimalMsgFromTemplate(
            'Hello #{user_first_name}. This week you got paid #{last_capitalization} in interest'
        )]);

        const queryResult = testHelper.mockLambdaResponse({ results: [{ amount: 100500, unit: 'HUNDREDTH_CENT', currency: 'USD' }] });
        lamdbaInvokeStub.returns({ promise: () => queryResult});

        const filledMessage = await handler.fetchAndFillInNextMessage({ destinationUserId: testUserId });
        expect(filledMessage).to.exist;
        expect(filledMessage[0].body).to.equal(expectedMessage);

        // this gets the last capitalization event so by definition it doesn't need a unit to convert into
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(assembleLambdaInvoke('capitalization::USD'));
    });

    it('Handles currencies not supported by JS i18n', async () => {
        const expectedMessage = 'Hello Luke. Your balance this week after earning more interest and boosts is R8,000.';
        getMessagesStub.withArgs(testUserId, ['CARD']).resolves([minimalMsgFromTemplate(
            'Hello #{user_first_name}. Your balance this week after earning more interest and boosts is #{current_balance}.'
        )]);

        const queryResult = testHelper.mockLambdaResponse({ results: [{ amount: 800000, unit: 'WHOLE_CENT', currency: 'ZAR' }] });
        lamdbaInvokeStub.returns({ promise: () => queryResult});
    
        fetchDynamoRowStub.withArgs(profileTable, { systemWideUserId: testUserId }, relevantProfileCols).resolves({ 
            systemWideUserId: testUserId, 
            personalName: 'Luke', 
            familyName: 'Jordan', 
            creationTimeEpochMillis: testOpenMoment.valueOf(), 
            defaultCurrency: 'ZAR'
        });

        const filledMessage = await handler.fetchAndFillInNextMessage({ destinationUserId: testUserId });
        expect(filledMessage).to.exist;
        expect(filledMessage[0].body).to.equal(expectedMessage);

        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(assembleLambdaInvoke('balance::HUNDREDTH_CENT::ZAR'));
    });

    it('Sorts messages by priority properly', async () => {
        const expectedMessage = 'Hello Luke. Your balance this week after earning more interest and boosts is $8,000.';
        const temlpate = 'Hello #{user_first_name}. Your balance this week after earning more interest and boosts is #{current_balance}.';
        getMessagesStub.withArgs(testUserId, ['CARD']).resolves([minimalMsgFromTemplate(temlpate, 10), minimalMsgFromTemplate(temlpate, 5)]);

        const queryResult = testHelper.mockLambdaResponse({ results: [{ amount: 800000, unit: 'WHOLE_CENT', currency: 'USD' }] });
        lamdbaInvokeStub.returns({ promise: () => queryResult});

        const filledMessage = await handler.fetchAndFillInNextMessage({ destinationUserId: testUserId });
        logger('Filled message:', filledMessage);

        expect(filledMessage).to.exist;
        expect(filledMessage[0].body).to.equal(expectedMessage);
    });

    it('Message sequence returns empty array on missing anchor message', async () => {
        const temlpate = 'Hello #{user_first_name}. Your balance this week after earning more interest and boosts is #{current_balance}.';
        getMessagesStub.withArgs(testUserId).resolves([minimalMsgFromTemplate(temlpate, 10, true), minimalMsgFromTemplate(temlpate, 5, true)]);

        const filledMessage = await handler.fetchAndFillInNextMessage({ destinationUserId: testUserId });
        logger('Filled message:', filledMessage);

        expect(filledMessage).to.exist;
        expect(filledMessage).to.deep.equal([]);
    });

    it('Returns empty where no messages are found', async () => {
        getMessagesStub.withArgs(testUserId).resolves({});
        const filledMessage = await handler.fetchAndFillInNextMessage({ destinationUserId: testUserId });
        logger('Filled message: ', filledMessage);

        expect(filledMessage).to.exist;
        expect(filledMessage).to.deep.equal([]);
    });

    it('Returns unauthorized if no authorization', async () => {
        const unauthorizedResponse = await handler.getNextMessageForUser({});
        expect(unauthorizedResponse).to.deep.equal({ statusCode: 403 });
    });

    it('Catches errors properly', async () => {
        const authContext = { authorizer: { systemWideUserId: 'this-is-a-bad-user' }};
        getMessagesStub.withArgs('this-is-a-bad-user', ['CARD']).rejects(new Error('Bad user caused error!'));
        const testEvent = { requestContext: authContext };
        const errorEvent = await handler.getNextMessageForUser(testEvent);
        expect(errorEvent).to.exist;
        expect(errorEvent).to.deep.equal({ statusCode: 500, body: JSON.stringify('Bad user caused error!') });
    });

    it('Fills in account with name', async () => {
        const expectedMessage = 'Hello Luke. Your balance this week after earning more interest and boosts is $8,000.';
        getMessagesStub.withArgs(testUserId, ['CARD']).resolves([minimalMsgFromTemplate(
            'Hello #{user_first_name}. Your balance this week after earning more interest and boosts is #{current_balance}.'
        )]);
        const queryResult = testHelper.mockLambdaResponse({ results: [{ amount: 800000, unit: 'WHOLE_CENT', currency: 'USD' }] });
        lamdbaInvokeStub.returns({ promise: () => queryResult});
        fetchDynamoRowStub.withArgs(profileTable, { systemWideUserId: testUserId }, relevantProfileCols).resolves({ 
            systemWideUserId: testUserId, 
            personalName: 'Luke', 
            familyName: 'Jordan', 
            creationTimeEpochMillis: testOpenMoment.valueOf(), 
            defaultCurrency: 'USD'
        }).withArgs(profileTable, { systemWideUserId: testUserId }, ['personal_name', 'family_name']).resolves({ 
            personalName: 'Luke', 
            familyName: 'Jordan'
        });

        const filledMessage = await handler.fetchAndFillInNextMessage({ destinationUserId: testUserId });
        expect(filledMessage).to.exist;
        expect(filledMessage[0].body).to.equal(expectedMessage);

        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(assembleLambdaInvoke('balance::HUNDREDTH_CENT::USD'));
    });

    it('Handles messages within flow (non-anchor)', async () => {
        const expectedMessage = 'Hello Luke Jordan. Did you know you have made $100 in earnings since you opened your account in July 2019?';
        getMessagesStub.withArgs(testUserId, ['CARD']).resolves([minimalMsgFromTemplate(
            'Hello #{user_full_name}. Did you know you have made #{total_earnings} in earnings since you opened your account in #{opened_date}?' 
        )]);

        const queryResult = testHelper.mockLambdaResponse({ results: [{ amount: 1000000, unit: 'HUNDREDTH_CENT', currency: 'USD' }] });
        lamdbaInvokeStub.returns({ promise: () => queryResult});

        const filledMessage = await handler.fetchAndFillInNextMessage({ destinationUserId: testUserId, withinFlowFromMsgId: testMessageId });
        logger('Filled message: ', filledMessage);
        expect(filledMessage).to.exist;
        expect(filledMessage[0].body).to.equal(expectedMessage);

        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(assembleLambdaInvoke('total_earnings::HUNDREDTH_CENT::USD'));
    });
});

describe('**** UNIT TESTING MESSAGE ASSEMBLY *** Boost based, complex assembly', () => {

    const testMsgId = uuid();
    const testSuccessMsgId = uuid();
    const testCreationTime = moment().subtract(10, 'minutes');

    const firstMsgFromRds = {
        messageId: testMsgId,
        messageTitle: 'Boost available!',
        messageBody: 'Hello! Jupiter is now live. To celebrate, if you add $10, you get $10 boost',
        creationTime: testCreationTime,
        startTime: moment().subtract(10, 'minutes'),
        endTime: testExpiryMoment,
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
        creationTime: testCreationTime,
        startTime: moment().subtract(10, 'minutes'),
        endTime: testExpiryMoment,
        messagePriority: 10,
        display: { type: 'MODAL', iconType: 'SMILEY_FACE' },
        actionContext: { triggerBalanceFetch: true, boostId: testBoostId },
        followsPriorMessage: true,
        hasFollowingMessage: false
    };

    const anotherHighPriorityMsg = {
        messageId: uuid(),
        messageTitle: 'Congratulations on something else!',
        messageBody: 'You earned a boost! But you should not see this yet',
        creationTime: moment().subtract(1, 'minutes'),
        startTime: moment().subtract(1, 'minutes'),
        endTime: testExpiryMoment,
        messagePriority: 20,
        display: { type: 'MODAL', iconType: 'SMILEY_FACE' },
        actionContext: { triggerBalanceFetch: true, boostId: testBoostId },
        followsPriorMessage: false,
        hasFollowingMessage: false
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
            sequenceExpiryTimeMillis: testExpiryMoment.valueOf()
        },
        messageSequence: {
            msgOnSuccess: testSuccessMsgId
        },
        hasFollowingMessage: true,
        persistedTimeMillis: testCreationTime.valueOf()
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
        hasFollowingMessage: false,
        persistedTimeMillis: testCreationTime.valueOf()
    };

    beforeEach(() => resetStubs());

    it('Fetches and assembles a set of two simple boost messages correctly', async () => {
        const mockEvent = testHelper.wrapEvent({ }, testUserId, 'ORDINARY_USER');

        const mockInvocation = {
            FunctionName: config.get('lambdas.updateMessageStatus'),
            InvocationType: 'Event',
            Payload: JSON.stringify({
                requestContext: mockEvent.requestContext,
                body: JSON.stringify({ messageId: firstMsgFromRds.messageId, userAction: 'FETCHED' })
            }) 
        };

        getMessagesStub.withArgs(testUserId, ['CARD']).resolves([firstMsgFromRds, secondMsgFromRds]);
        lamdbaInvokeStub.withArgs(mockInvocation).returns({ promise: () => ({ result: 'SUCCESS' })});
        
        const fetchResult = await handler.getNextMessageForUser(testHelper.wrapEvent({ }, testUserId, 'ORDINARY_USER'));
        expect(fetchResult).to.exist;
        const bodyOfFetch = testHelper.standardOkayChecks(fetchResult);
        expect(bodyOfFetch).to.have.property('messagesToDisplay');
        expect(bodyOfFetch.messagesToDisplay).to.be.an('array');
        expect(bodyOfFetch.messagesToDisplay[0]).to.deep.equal(expectedFirstMessage);
        expect(bodyOfFetch.messagesToDisplay[1]).to.deep.equal(expectedSecondMsg);
        expect(getMessagesStub).to.have.been.calledOnceWithExactly(testUserId, ['CARD']);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(mockInvocation);
    });

    it('Within flow message parameter works', async () => {
        const requestContext = { authorizer: { systemWideUserId: testUserId }};
        const queryStringParameters = { anchorMessageId: testMsgId };

        const mockInvocation = {
            FunctionName: config.get('lambdas.updateMessageStatus'),
            InvocationType: 'Event',
            Payload: JSON.stringify({
                requestContext,
                body: JSON.stringify({ messageId: firstMsgFromRds.messageId, userAction: 'FETCHED' })
            }) 
        };

        getMessagesStub.withArgs(testUserId, ['CARD']).resolves([firstMsgFromRds, secondMsgFromRds]);
        lamdbaInvokeStub.withArgs(mockInvocation).returns({ promise: () => ({ result: 'SUCCESS' })});
        
        const fetchResult = await handler.getNextMessageForUser({ queryStringParameters, requestContext });
        logger('Result of assembly:', fetchResult);
        logger('lis args:', lamdbaInvokeStub.getCall(0).args);
        expect(fetchResult).to.exist;
        const bodyOfFetch = testHelper.standardOkayChecks(fetchResult);
        expect(bodyOfFetch).to.deep.equal({ messagesToDisplay: [expectedFirstMessage, expectedSecondMsg] });
        expect(getMessagesStub).to.have.been.calledOnceWithExactly(testUserId, ['CARD']);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(mockInvocation);
    });

    it('Sorts same priority messages by creation time properly', async () => {
        const mockEvent = testHelper.wrapEvent({ }, testUserId, 'ORDINARY_USER');

        const mockInvocation = {
            FunctionName: config.get('lambdas.updateMessageStatus'),
            InvocationType: 'Event',
            Payload: JSON.stringify({
                requestContext: mockEvent.requestContext,
                body: JSON.stringify({ messageId: firstMsgFromRds.messageId, userAction: 'FETCHED' })
            }) 
        };

        getMessagesStub.withArgs(testUserId, ['CARD']).resolves([firstMsgFromRds, secondMsgFromRds, anotherHighPriorityMsg]);
        lamdbaInvokeStub.withArgs(mockInvocation).returns({ promise: () => ({ result: 'SUCCESS' })});
        
        const fetchResult = await handler.getNextMessageForUser(testHelper.wrapEvent({ }, testUserId, 'ORDINARY_USER'));
        expect(fetchResult).to.exist;
        const bodyOfFetch = testHelper.standardOkayChecks(fetchResult);
        expect(bodyOfFetch).to.deep.equal({ messagesToDisplay: [expectedFirstMessage, expectedSecondMsg] });
        expect(getMessagesStub).to.have.been.calledOnceWithExactly(testUserId, ['CARD']);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(mockInvocation);
    });

});

describe('*** UNIT TESTING MESSAGE PROCESSING *** Update message acknowledged status', () => {

    const testMsgId = uuid();
    const testUpdatedTime = moment();

    beforeEach(() => resetStubs());

    it('Handles user dismissing a message', async () => {
        updateMessageStub.withArgs(testMsgId, { processedStatus: 'DISMISSED' }).resolves({ updatedTime: testUpdatedTime });

        const event = { messageId: testMsgId, userAction: 'DISMISSED' };
        const updateResult = await handler.updateUserMessage(testHelper.wrapEvent(event, testUserId, 'ORDINARY_USER'));
        logger('Result of update: ', updateResult);

        expect(updateResult).to.exist;
        expect(updateResult).to.deep.equal({
            statusCode: 200, body: JSON.stringify({ result: 'SUCCESS', processedTimeMillis: testUpdatedTime.valueOf() })
        });
    });

    it('Handles user fetching a message', async () => {
        updateMessageStub.withArgs(testMsgId, { processedStatus: 'FETCHED' }).resolves({ updatedTime: testUpdatedTime });

        const event = { messageId: testMsgId, userAction: 'FETCHED' };
        const updateResult = await handler.updateUserMessage(testHelper.wrapEvent(event, testUserId, 'ORDINARY_USER'));
        logger('Result of update: ', updateResult);

        expect(updateResult).to.exist;
        expect(updateResult).to.deep.equal({ statusCode: 200 });
    });

    it('Gives an appropriate error on unknown user action', async () => {
        const badEvent = { messageId: testMsgId, userAction: 'BADVALUE' };
        const errorResult = await handler.updateUserMessage(testHelper.wrapEvent(badEvent, testUserId, 'ORDINARY_USER'));

        expect(errorResult).to.exist;
        expect(errorResult).to.deep.equal({ statusCode: 400, body: 'UNKNOWN_ACTION' });
        expect(updateMessageStub).to.not.have.been.called;
    });

    it('Swallows persistence error properly', async () => {
        updateMessageStub.rejects(new Error('Error! Something nasty in persistence'));
        const weirdEvent = { messageId: testMsgId, userAction: 'DISMISSED' };
        const errorResult = await handler.updateUserMessage(testHelper.wrapEvent(weirdEvent, testUserId, 'ORDINARY_USER'));

        expect(errorResult).to.deep.equal({ statusCode: 500, body: JSON.stringify('Error! Something nasty in persistence')});
    });

    it('Fails on missing authorization', async () => {
        const event = { messageId: testMsgId, userAction: 'FETCHED' };
        const updateResult = await handler.updateUserMessage(event);
        logger('Result of update: ', updateResult);

        expect(updateResult).to.exist;
        expect(updateResult).to.deep.equal({ statusCode: 403 });
    });

    it('Fails on missing message id', async () => {
        const event = { userAction: 'FETCHED' };
        const updateResult = await handler.updateUserMessage(testHelper.wrapEvent(event, testUserId, 'ORDINARY_USER'));
        logger('Result of update: ', updateResult);

        expect(updateResult).to.exist;
        expect(updateResult).to.deep.equal({ statusCode: 400 });
    });
});

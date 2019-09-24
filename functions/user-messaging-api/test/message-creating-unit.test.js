'use strict';

const logger = require('debug')('jupiter:user-notifications:user-message-handler-test');
const uuid = require('uuid/v4');
const config = require('config');
const moment = require('moment');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;
const proxyquire = require('proxyquire').noCallThru();

const testHelper = require('./message.test.helper');

const getMessageInstructionStub = sinon.stub();
const getUserIdsStub = sinon.stub();
const insertUserMessagesStub = sinon.stub();
const getInstructionsByTypeStub = sinon.stub();
const filterUserIdsForRecurrenceStub = sinon.stub();
const getPushTokenStub = sinon.stub();
const deletePushTokenStub = sinon.stub();
const insertPushTokenStub = sinon.stub();
const updateInstructionStateStub = sinon.stub();
const updateMessageInstructionStub = sinon.stub();
const momentStub = sinon.stub();

const handler = proxyquire('../message-creating-handler', {
    './persistence/rds.notifications': {
        'getMessageInstruction': getMessageInstructionStub,
        'getUserIds': getUserIdsStub,
        'insertUserMessages': insertUserMessagesStub,
        'getInstructionsByType': getInstructionsByTypeStub,
        'filterUserIdsForRecurrence': filterUserIdsForRecurrenceStub,
        'getPushToken': getPushTokenStub,
        'deletePushToken': deletePushTokenStub,
        'insertPushToken': insertPushTokenStub,
        'updateInstructionState': updateInstructionStateStub,
        'updateMessageInstruction': updateMessageInstructionStub,
        '@noCallThru': true
    },
    'moment': momentStub
});

const resetStubs = () => testHelper.resetStubs(getMessageInstructionStub, getUserIdsStub, insertUserMessagesStub,
    getInstructionsByTypeStub, getPushTokenStub, deletePushTokenStub, insertPushTokenStub, momentStub,
    updateMessageInstructionStub, updateInstructionStateStub, filterUserIdsForRecurrenceStub);

const createMockUserIds = (quantity) => Array(quantity).fill().map(() => uuid());

const simpleCardMsgTemplate = require('./templates/simpleTemplate');
const simpleMsgVariant = require('./templates/variantTemplate');
const referralMsgVariant = require('./templates/referralTemplate');
const recurringMsgTemplate = require('./templates/recurringTemplate')

describe('*** UNIT TESTING USER MESSAGE INSERTION ***', () => {

    const mockInstructionId = uuid();
    const mockUserId = uuid();
    const mockClientId = uuid();
    const mockBoostId = uuid();
    
    const testTime = moment();
    const mockCreationTime = '2049-06-22T07:38:30.016Z';
    const mockUpdatedTime = '2049-06-22T08:00:21.016Z';

    const mockTemplate = {
        template: {
            DEFAULT: simpleCardMsgTemplate
        }
    };

    const mockInstruction = {
        instructionId: mockInstructionId,
        presentationType: 'ONCE_OFF',
        active: true,
        audienceType: 'ALL_USERS',
        templates: mockTemplate,
        selectionInstruction: `whole_universe from #{{"client_id":"${mockClientId}"}}`,
        recurrenceInstruction: null,
        startTime: '2050-09-01T11:47:41.596Z',
        endTime: '2061-01-09T11:47:41.596Z',
        lastProcessedTime: moment().format(),
        messagePriority: 100
    };

    // not including message ID else have either spurious fails or a lot of unnecessary complexity
    const mockUserMessage = (userId, msgTemplate = mockTemplate.template['DEFAULT'], variant = 'DEFAULT') => ({
        destinationUserId: userId,
        processedStatus: 'READY_FOR_SENDING',
        startTime: '2050-09-01T11:47:41.596Z',
        endTime: '2061-01-09T11:47:41.596Z', 
        messageTitle: msgTemplate.title,
        messageBody: msgTemplate.body,
        messageVariant: variant,
        display: msgTemplate.display,
        instructionId: mockInstructionId,
        messagePriority: 100,
        presentationType: 'ONCE_OFF',
        followsPriorMessage: false,
        hasFollowingMessage: false,
        actionContext: {
            actionToTake: msgTemplate.actionToTake, ...msgTemplate.actionContext
        }
    }); 

    const resetInstruction = () => {
        mockInstruction.audienceType = 'ALL_USERS';
        mockInstruction.selectionInstruction = `whole_universe from #{{"client_id":"${mockClientId}"}}`;
        mockInstruction.templates = mockTemplate;
    };
    
    const expectedInsertionRows = (quantity, start = 1) => 
        Array(quantity).fill().map((_, i) => ({ insertionId: start + i, creationTime: mockCreationTime }));

    const commonAssertions = (result, presentationType, numberOfMessages) => {
        expect(result).to.exist;
        expect(result).to.have.property('instructionId', mockInstructionId);
        expect(result).to.have.property('instructionType', presentationType);
        expect(result).to.have.property('numberMessagesCreated', numberOfMessages);
        expect(result).to.have.property('creationTimeMillis', mockCreationTime);
        expect(result).to.have.property('instructionUpdateTime', mockUpdatedTime);
    };

    beforeEach(() => {
        resetStubs();
        resetInstruction();
        momentStub.returns(testTime);
    });

    it('Should insert notification messages for all users in current universe', async () => {
        const testNumberUsers = 1000;

        const testUserIds = createMockUserIds(testNumberUsers);
        
        getMessageInstructionStub.withArgs(mockInstructionId).resolves(mockInstruction);
        getUserIdsStub.withArgs(mockInstruction.selectionInstruction).resolves(testUserIds);
        insertUserMessagesStub.resolves(expectedInsertionRows(testNumberUsers));
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_CREATED').resolves({ updatedTime: mockUpdatedTime });

        const result = await handler.createUserMessages({ instructions: [{ instructionId: mockInstructionId }]});
        logger('Result of user messages insertion:', result);

        commonAssertions(result[0], 'ONCE_OFF', testNumberUsers);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;
        expect(updateInstructionStateStub).to.have.been.calledOnceWithExactly(mockInstructionId, 'MESSAGES_CREATED');

        const testUserMsgs = testUserIds.map((userId) => mockUserMessage(userId));
        const insertUserMsgArgs = insertUserMessagesStub.getCall(0).args[0];

        expect(insertUserMsgArgs).to.be.an('array').of.length(testNumberUsers);
        
        const userIdToTest = testUserIds[Math.floor(Math.random() * testNumberUsers)];
        logger('Testing for user ID: ', userIdToTest);

        const testMessage = insertUserMsgArgs[0];
        expect(testMessage).to.have.property('messageId');
        Reflect.deleteProperty(testMessage, 'messageId');
        expect(testMessage).to.deep.equal(testUserMsgs[0]);
    });

    it('should use other templates over default where provided', async () => {
        const testNumberUsers = 1000;
        const testUserIds = createMockUserIds(testNumberUsers);

        mockInstruction.templates = {
            template: {
                DEFAULT: simpleCardMsgTemplate,
                VARIANT: simpleMsgVariant
            }
        };

        getMessageInstructionStub.resolves(mockInstruction);
        getUserIdsStub.resolves(testUserIds);
        insertUserMessagesStub.resolves(expectedInsertionRows(testNumberUsers));
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_CREATED').resolves({ updatedTime: mockUpdatedTime });
        
        const result = await handler.createUserMessages({ instructions: [{ instructionId: mockInstructionId }]});
        logger('Result of user messages insertion:', result);

        commonAssertions(result[0], 'ONCE_OFF', testNumberUsers);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;
        expect(updateInstructionStateStub).to.have.been.calledOnceWithExactly(mockInstructionId, 'MESSAGES_CREATED');

        const insertUserMsgArgs = insertUserMessagesStub.getCall(0).args[0];

        const testDefaultMsg = mockUserMessage(testUserIds[0]);
        const testVariantMsg = mockUserMessage(testUserIds[1], simpleMsgVariant, 'VARIANT');
        
        const defaultTester = (msg) => Object.keys(testDefaultMsg).filter((key) => key !== 'destinationUserId')
            .reduce((soFar, key) => soFar && JSON.stringify(msg[key]) === JSON.stringify(testDefaultMsg[key]), true);
        const variantTester = (msg) => Object.keys(testVariantMsg).filter((key) => key !== 'destinationUserId')
            .reduce((soFar, key) => soFar && JSON.stringify(msg[key]) === JSON.stringify(testVariantMsg[key]), true);
        logger('Tester works? : ', defaultTester(insertUserMsgArgs[0]));
        logger('And other tests? : ', variantTester(insertUserMsgArgs[0]));
        
        expect(insertUserMsgArgs).to.be.an('array').of.length(testNumberUsers);
        const defaultCount = insertUserMsgArgs.map((msg) => defaultTester(msg) ? 1 : 0).reduce((sum, cum) => sum + cum, 0);
        const variantCount = insertUserMsgArgs.map((msg) => variantTester(msg) ? 1 : 0).reduce((sum, cum) => sum + cum, 0);
        logger('Default count: ', defaultCount, ' and variant count: ', variantCount);
        
        // we might want to range these in future, but for now, make sure not all default
        expect(defaultCount + variantCount).to.equal(testNumberUsers);
        expect(defaultCount).to.be.lessThan(testNumberUsers);
        expect(variantCount).to.be.greaterThan(0);
    });

    it('Should insert sequences properly', async () => {
        const testNumberUsers = 10;
        const testUserIds = createMockUserIds(testNumberUsers);

        mockInstruction.templates = {
            sequence: [
                { DEFAULT: simpleCardMsgTemplate, identifier: 'openingMsg' },
                { DEFAULT: simpleMsgVariant, identifier: 'unlockedMsg' }
            ]
        };

        const expectedNumberMessages = testNumberUsers * mockInstruction.templates.sequence.length;
        logger('Expecting ', expectedNumberMessages, ' messages');

        getMessageInstructionStub.resolves(mockInstruction);
        getUserIdsStub.resolves(testUserIds);
        insertUserMessagesStub.resolves(expectedInsertionRows(expectedNumberMessages));
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_CREATED').resolves({ updatedTime: mockUpdatedTime });

        const result = await handler.createUserMessages({ instructions: [{ instructionId: mockInstructionId }]});
        logger('Result of insertion:', result);

        commonAssertions(result[0], 'ONCE_OFF', expectedNumberMessages);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;
        expect(updateInstructionStateStub).to.have.been.calledOnceWithExactly(mockInstructionId, 'MESSAGES_CREATED');
        
        // and todo : also check for inserting message sequence dict
        const insertUserMsgArgs = insertUserMessagesStub.getCall(0).args[0];
        expect(insertUserMsgArgs).to.be.an('array').of.length(expectedNumberMessages);
        const expectedOpeningMsg = mockUserMessage(testUserIds[0]);
        expectedOpeningMsg.hasFollowingMessage = true;
        const expectedSecondMsg = mockUserMessage(testUserIds[0], mockInstruction.templates.sequence[1].DEFAULT);  // still 'DEFAULT' in its position
        expectedSecondMsg.followsPriorMessage = true;

        const firstMsgToPers = insertUserMsgArgs[0];
        const secondMsgToPers = insertUserMsgArgs[1];

        expect(firstMsgToPers).to.have.property('messageId');
        expect(secondMsgToPers).to.have.property('messageId');

        const expectedMsgSequence = {
            'openingMsg': firstMsgToPers.messageId,
            'unlockedMsg': secondMsgToPers.messageId
        };

        expect(firstMsgToPers).to.have.property('messageSequence');
        expect(firstMsgToPers.messageSequence).to.deep.equal(expectedMsgSequence);
        expect(secondMsgToPers).to.have.property('messageSequence');
        expect(secondMsgToPers.messageSequence).to.deep.equal(expectedMsgSequence);

        expectedOpeningMsg.messageId = firstMsgToPers.messageId;
        expectedOpeningMsg.messageSequence=  firstMsgToPers.messageSequence;
        expectedSecondMsg.messageId = secondMsgToPers.messageId;
        expectedSecondMsg.messageSequence = secondMsgToPers.messageSequence;

        expect(insertUserMsgArgs[0]).to.deep.equal(expectedOpeningMsg);
        expect(insertUserMsgArgs[1]).to.deep.equal(expectedSecondMsg);
    });

    it('should insert boost notification message from boost api', async () => {

        const testReferringUser = uuid();
        const testReferredUser = uuid();

        const mockBoostInstruction = {
            instructionId: mockInstructionId,
            presentationType: 'EVENT_DRIVEN',
            active: true,
            audienceType: 'INDIVIDUAL',
            templates: { 
                template: {
                    DEFAULT: referralMsgVariant
                }
            },
            selectionInstruction: `whole_universe from #{{"specific_users":["${testReferringUser}","${testReferredUser}"]}}`,
            recurrenceInstruction: null,
            responseAction: 'VIEW_HISTORY',
            responseContext: JSON.stringify({ boostId: mockBoostId }),
            startTime: '2050-09-01T11:47:41.596Z',
            endTime: '2061-01-09T11:47:41.596Z',
            lastProcessedTime: moment().format(),
            messagePriority: 0
        };

        getMessageInstructionStub.resolves(mockBoostInstruction);
        getUserIdsStub/*.withArgs(mockBoostInstruction.selectionInstruction)*/.resolves(createMockUserIds(1));
        insertUserMessagesStub.resolves(expectedInsertionRows(1));
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_CREATED').resolves({ updatedTime: mockUpdatedTime });

        const mockEvent = {
            instructions: [{
                instructionId: mockInstructionId,
                destinationUserId: mockUserId,
                parameters: { boostAmount: '$10', boostAmountOther: '$20' },
                triggerBalanceFetch: true
            }]
        };

        const result = await handler.createUserMessages(mockEvent);
        logger('result of boost message insertion:', result);
        // logger('Got:', getUserIdsStub.getCall(0).args);
        // logger('Expected:', mockBoostInstruction.selectionInstruction);
        
        commonAssertions(result[0], 'EVENT_DRIVEN', 1);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        // expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockBoostInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;
        expect(updateInstructionStateStub).to.have.been.calledOnceWithExactly(mockInstructionId, 'MESSAGES_CREATED');

        const insertUserMsgArgs = insertUserMessagesStub.getCall(0).args[0];
        expect(insertUserMsgArgs).to.be.an('array').of.length(1);

        const messageBody = insertUserMsgArgs[0].messageBody;
        const expectedMsgBody = 'Busani Ndlovu has signed up to Jupiter using your referral code, earning you a $10 boost to your savings. He also earned $20';
        logger('Message body: ', messageBody);
        expect(messageBody).to.be.equal(expectedMsgBody);
    });

    it('should normalize event in body', async () => {
        const testNumberUsers = 1;
        const testUserIds = createMockUserIds(testNumberUsers);
        
        getMessageInstructionStub.withArgs(mockInstructionId).resolves(mockInstruction);
        getUserIdsStub.withArgs(mockInstruction.selectionInstruction).resolves(testUserIds);
        insertUserMessagesStub.resolves(expectedInsertionRows(testNumberUsers));
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_CREATED').resolves({ updatedTime: mockUpdatedTime });
        
        const mockEvent = { body: JSON.stringify({ instructions: [{ instructionId: mockInstructionId }]})};

        const result = await handler.createUserMessages(mockEvent);
        logger('Result of user messages insertion:', result);

        commonAssertions(result[0], 'ONCE_OFF', testNumberUsers);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;
        expect(updateInstructionStateStub).to.have.been.calledOnceWithExactly(mockInstructionId, 'MESSAGES_CREATED');
    });

    it('Handles insertions where no user ids are found', async () => {
        // and selection instruction should default to null where not provided
        mockInstruction.selectionInstruction = null;
        getMessageInstructionStub.withArgs(mockInstructionId).resolves(mockInstruction);
        getUserIdsStub.withArgs(mockInstruction.selectionInstruction).returns([]);

        const expectedResult = [{
            instructionId: mockInstructionId,
            insertionResponse: []
        }];
        
        const mockEvent = { instructions: [{ instructionId: mockInstructionId }]};

        const result = await handler.createUserMessages(mockEvent);
        logger('Result of instruction with no users:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.not.have.been.called;
        expect(updateInstructionStateStub).to.have.not.been.called;
    });

    it('should insert user message on individual user', async () => {
        mockInstruction.audienceType = 'INDIVIDUAL';
        mockInstruction.selectionInstruction = `whole_universe from #{'{"specific_users":["${mockUserId}"]}'}`;
        
        getMessageInstructionStub.resolves(mockInstruction);
        getUserIdsStub.resolves(createMockUserIds(1));
        insertUserMessagesStub.resolves(expectedInsertionRows(1));
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_CREATED').resolves({ updatedTime: mockUpdatedTime });
        
        const result = await handler.createUserMessages({ instructions: [{ instructionId: mockInstructionId }]});
        logger('Result of single user insertion:', result);
        
        commonAssertions(result[0], 'ONCE_OFF', 1);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;
        expect(updateInstructionStateStub).to.have.been.calledOnceWithExactly(mockInstructionId, 'MESSAGES_CREATED');
    });

    it('should insert user messages on a group of users', async () => {
        const numberSampledUsers = 7500;

        mockInstruction.audienceType = 'GROUP';
        mockInstruction.selectionInstruction = `random_sample #{0.75} from #{'{"client_id":"${mockClientId}"}'}`;
        
        getMessageInstructionStub.withArgs(mockInstructionId).resolves(mockInstruction);
        getUserIdsStub.withArgs(mockInstruction.selectionInstruction).resolves(createMockUserIds(numberSampledUsers));
        insertUserMessagesStub.resolves(expectedInsertionRows(numberSampledUsers));
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_CREATED').resolves({ updatedTime: mockUpdatedTime });

        const result = await handler.createUserMessages({ instructions: [{ instructionId: mockInstructionId }]});
        logger('Result of group insertion (random sample):', result);

        commonAssertions(result[0], 'ONCE_OFF', numberSampledUsers);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;
        expect(updateInstructionStateStub).to.have.been.calledOnceWithExactly(mockInstructionId, 'MESSAGES_CREATED');
        const insertedMessages = insertUserMessagesStub.getCall(0).args[0];
        expect(insertedMessages).to.be.an('array').of.length(numberSampledUsers);
    });

    it('Handles extra parameters', async () => {
        const instruction = { ...mockInstruction };
        instruction.audienceType = 'INDIVIDUAL';
        instruction.selectionInstruction = `whole_universe from #{'{"specific_users":["${mockUserId}"]}'}`;
        
        getMessageInstructionStub.resolves(instruction);
        getUserIdsStub.resolves(createMockUserIds(1));
        insertUserMessagesStub.resolves(expectedInsertionRows(1));
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_CREATED').resolves({ updatedTime: mockUpdatedTime });
        
        const mockEvent = { instructions: [{ instructionId: mockInstructionId, parameters: { processedStatus: 'READY_FOR_SENDING' }}]};

        const result = await handler.createUserMessages(mockEvent);
        logger('Result of single user insertion:', result);
        
        commonAssertions(result[0], 'ONCE_OFF', 1);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(instruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;
        expect(updateInstructionStateStub).to.have.been.calledOnceWithExactly(mockInstructionId, 'MESSAGES_CREATED');
    });

    it('Handles defaultStatus included in instruction', async () => {
        const instruction = { ...mockInstruction };
        instruction.audienceType = 'INDIVIDUAL';
        instruction.selectionInstruction = `whole_universe from #{'{"specific_users":["${mockUserId}"]}'}`;
        instruction.defaultStatus = 'CREATED';

        getMessageInstructionStub.resolves(instruction);
        getUserIdsStub.resolves(createMockUserIds(1));
        insertUserMessagesStub.resolves(expectedInsertionRows(1));
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_CREATED').resolves({ updatedTime: mockUpdatedTime });
        
        const mockEvent = { instructions: [{ instructionId: mockInstructionId }]};

        const result = await handler.createUserMessages(mockEvent);
        logger('Result of single user insertion:', result);
        
        commonAssertions(result[0], 'ONCE_OFF', 1);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(instruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.been.calledOnce;
        expect(updateInstructionStateStub).to.have.been.calledOnceWithExactly(mockInstructionId, 'MESSAGES_CREATED');
    });

    it('Fails on instruction extraction failure', async () => {
        getMessageInstructionStub.withArgs(mockInstructionId).rejects(new Error('Error extracting message instruction'));

        const result = await handler.createUserMessages({ instructions: [{ instructionId: mockInstructionId }]});
        logger('Result of failing intruction extraction:', result);

        expect(result).to.exist;
        expect(result).to.have.property('message', 'Error extracting message instruction');
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.not.been.called;
        expect(insertUserMessagesStub).to.have.not.been.called;
        expect(updateInstructionStateStub).to.have.not.been.called;
    });

    it('Fails on missing instruction', async () => {
        const result = await handler.createUserMessages({ instructionId: mockInstructionId });
        expect(result).to.exist;
        expect(result).to.deep.equal({ statusCode: 202, message: 'No instructions provided' });
    });
});

describe('*** UNIT TESTING PENDING INSTRUCTIONS HANDLER ***', () => {

    const mockInstructionId = uuid();
    const mockClientId = uuid();

    const testTime = moment();
    const mockCreationTime = '2049-06-22T07:38:30.016Z';
    const mockUpdatedTime = '2049-06-22T08:00:21.016Z';

    const expectedInsertionRows = (quantity, start = 1) => 
        Array(quantity).fill().map((_, i) => ({ insertionId: start + i, creationTime: mockCreationTime }));

    const mockInstruction = {
        instructionId: mockInstructionId,
        presentationType: 'RECURRING',
        active: true,
        audienceType: 'ALL_USERS',
        templates: { template: { DEFAULT: recurringMsgTemplate }},
        selectionInstruction: `whole_universe from #{{"client_id":"${mockClientId}"}}`,
        recurrenceInstruction: null,
        responseAction: 'VIEW_HISTORY',
        responseContext: null,
        startTime: '2050-09-01T11:47:41.596Z',
        endTime: '2061-01-09T11:47:41.596Z',
        lastProcessedTime: moment().format(),
        messagePriority: 0
    };

    beforeEach(() => {
        resetStubs();
        momentStub.returns(testTime);
    });

    it('Sends pending instructions', async () => {
        getInstructionsByTypeStub.resolves([mockInstruction, mockInstruction]);
        getMessageInstructionStub.resolves(mockInstruction);
        filterUserIdsForRecurrenceStub.resolves(createMockUserIds(10));
        getUserIdsStub.resolves(createMockUserIds(10));
        insertUserMessagesStub.resolves(expectedInsertionRows(10));
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_CREATED').resolves({ updatedTime: mockUpdatedTime });
        updateMessageInstructionStub.withArgs(mockInstructionId, 'last_processed_time', testTime.format()).resolves({ updatedTime: mockUpdatedTime });

        const result = await handler.createFromPendingInstructions();
        logger('Result of pending intruction handling:', result);

        expect(result).to.exist;
        expect(result).to.have.property('messagesProcessed', 4);
        expect(result).to.have.property('processResults');
        result.processResults.forEach(processResult => {
            const standardizedResult = Array.isArray(processResult) ? processResult[0] : processResult;
            expect(standardizedResult).to.have.property('instructionId', mockInstructionId);
            expect(standardizedResult).to.have.property('instructionType', 'RECURRING');
            expect(standardizedResult).to.have.property('numberMessagesCreated', 10);
            expect(standardizedResult).to.have.property('creationTimeMillis', mockCreationTime);
            expect(standardizedResult).to.have.property('instructionUpdateTime', mockUpdatedTime);
        });
        expect(getInstructionsByTypeStub).to.have.been.calledWith('ONCE_OFF', [], ['CREATED', 'READY_FOR_GENERATING']);
        expect(getInstructionsByTypeStub).to.have.been.calledWith('RECURRING');
        expect(filterUserIdsForRecurrenceStub).to.have.been.calledTwice;
        expect(getUserIdsStub).to.have.been.called;
        expect(insertUserMessagesStub).to.have.been.called;
        expect(updateInstructionStateStub).to.have.been.called;
        expect(updateMessageInstructionStub).to.have.been.called;
    });

    it('Handles empty recurring messages', async () => {
        getInstructionsByTypeStub.resolves([mockInstruction, mockInstruction]);
        getMessageInstructionStub.resolves(mockInstruction);
        getUserIdsStub.resolves([]);
    
        const result = await handler.createFromPendingInstructions();
        logger('Result of pending intruction handling:', result);
    });

    it('Fails on invalid template', async () => {
        const mockInstruction = {
            instructionId: mockInstructionId,
            selectionInstruction: `whole_universe from #{{"client_id":"${mockClientId}"}}`,
            templates: '{ template: { DEFAULT: recurringMsgTemplate }}'
        };

        getInstructionsByTypeStub.resolves([mockInstruction, mockInstruction]);
        getMessageInstructionStub.resolves(mockInstruction);
        filterUserIdsForRecurrenceStub.resolves(createMockUserIds(10));
        getUserIdsStub.resolves(createMockUserIds(10));

        const result = await handler.createFromPendingInstructions();
        logger('Result on malformed template:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal({ result: 'ERROR', message: 'Malformed template instruction: ' });
        expect(getInstructionsByTypeStub).to.have.been.calledWith('ONCE_OFF', [], ['CREATED', 'READY_FOR_GENERATING']);
        expect(filterUserIdsForRecurrenceStub).to.have.been.calledTwice;
        expect(getUserIdsStub).to.have.been.calledWith(mockInstruction.selectionInstruction);
        expect(insertUserMessagesStub).to.have.not.been.called;
        expect(updateInstructionStateStub).to.have.not.been.called;
        expect(updateMessageInstructionStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        getInstructionsByTypeStub.rejects(new Error('ProcessError'));
        
        const result = await handler.createFromPendingInstructions();
        logger('Result on error:', result);

        expect(result).to.exist;
        expect(result).to.have.property('result', 'ERROR');
        expect(result).to.have.property('message', 'ProcessError');
        expect(getInstructionsByTypeStub).to.have.been.calledOnceWithExactly('ONCE_OFF', [], ['CREATED', 'READY_FOR_GENERATING']);
        expect(filterUserIdsForRecurrenceStub).to.have.not.been.called;
        expect(getUserIdsStub).to.have.not.been.called;
        expect(insertUserMessagesStub).to.have.not.been.called;
        expect(updateInstructionStateStub).to.have.not.been.called;
        expect(updateMessageInstructionStub).to.have.not.been.called;
    });

});

describe.skip('*** UNIT TESTING NEW USER MESSAGE SYNC ***', () => {
    const mockCreationTime = '2049-06-22T07:38:30.016Z';
    const mockInstructionId = uuid();
    const mockClientId = uuid();
    const mockUserId = uuid();
    const mockUserIdOnError = uuid();

    const mockInstruction = {
        instructionId: mockInstructionId,
        presentationType: 'RECURRING',
        active: true,
        audienceType: 'ALL_USERS',
        templates: { template: { DEFAULT: recurringMsgTemplate }},
        selectionInstruction: `whole_universe from #{{"client_id":"${mockClientId}"}}`,
        recurrenceInstruction: null,
        responseAction: 'VIEW_HISTORY',
        responseContext: null,
        startTime: '2050-09-01T11:47:41.596Z',
        endTime: '2061-01-09T11:47:41.596Z',
        lastProcessedTime: moment().format(),
        messagePriority: 0
    };

    const commonAssertions = (statusCode, result, expectedResult) => {
        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(statusCode);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
    };

    beforeEach(() => {
        resetStubs();
    });

    it('should populate a new users messages with recurring messages targeted at all users', async () => {
        getInstructionsByTypeStub.withArgs('RECURRING', ['ALL_USERS']).resolves([mockInstruction, mockInstruction, mockInstruction]);
        getUserIdsStub.resolves([mockUserId]);
        const expectedResult = { 
            message: [
                { insertionId: 1, creationTime: mockCreationTime },
                { insertionId: 2, creationTime: mockCreationTime },
                { insertionId: 3, creationTime: mockCreationTime }
            ]
        };
        
        const mockEvent = {
            systemWideUserId: mockUserId
        };

        const result = await handler.syncUserMessages(mockEvent);
        logger('Result of user messages sync:', result);

        commonAssertions(200, result, expectedResult);
        expect(getInstructionsByTypeStub).to.have.been.calledOnceWithExactly('ALL_USERS', 'RECURRING');
        expect(insertUserMessagesStub).to.have.been.calledOnce;
    });

    it('should return an error on process failure', async () => {
        getInstructionsByTypeStub.withArgs('ALL_USERS', 'RECURRING').throws(new Error('Error extracting instructions'));
        const expectedResult = { message: 'Error extracting instructions' };

        const mockEvent = {
            systemWideUserId: mockUserIdOnError
        };

        const result = await handler.syncUserMessages(mockEvent);
        logger('Result of user messages sync on error:', result);

        commonAssertions(500, result, expectedResult);
        expect(getInstructionsByTypeStub).to.have.been.calledOnceWithExactly('ALL_USERS', 'RECURRING');
        expect(getUserIdsStub).to.have.not.been.called;
        expect(insertUserMessagesStub).to.have.not.been.called;
    });
});


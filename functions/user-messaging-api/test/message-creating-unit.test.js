'use strict';

const logger = require('debug')('jupiter:user-notifications:user-message-handler-test');
const uuid = require('uuid/v4');
const moment = require('moment');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;
const proxyquire = require('proxyquire').noCallThru();

const testHelper = require('./message.test.helper');

const getMessageInstructionStub = sinon.stub();
const publishEventStub = sinon.stub();
const getUserIdsStub = sinon.stub();
const insertUserMessagesStub = sinon.stub();
const updateInstructionStateStub = sinon.stub();
const deactivateInstructionStub = sinon.stub();

const publishMultiLogStub = sinon.stub();

const momentStub = sinon.stub();
const uuidStub = sinon.stub();

const handler = proxyquire('../message-creating-handler', {
    './persistence/rds.usermessages': {
        'getMessageInstruction': getMessageInstructionStub,
        'getUserIdsForAudience': getUserIdsStub,
        'insertUserMessages': insertUserMessagesStub,
        'updateInstructionState': updateInstructionStateStub,
        'deactivateInstruction': deactivateInstructionStub,
        '@noCallThru': true
    },
    'publish-common': {
        'publishMultiUserEvent': publishMultiLogStub,
        'publishUserEvent': publishEventStub,
        '@noCallThru': true
    },
    'moment': momentStub,
    'uuid/v4': uuidStub
});

const resetStubs = () => testHelper.resetStubs(getMessageInstructionStub, deactivateInstructionStub, getUserIdsStub, insertUserMessagesStub, momentStub, updateInstructionStateStub);

const createMockUserIds = (quantity) => Array(quantity).fill().map(() => uuid());

const simpleCardMsgTemplate = require('./templates/simpleTemplate');
const simpleMsgVariant = require('./templates/variantTemplate');
const referralMsgVariant = require('./templates/referralTemplate');

const mockAudienceId = uuid();
const mockMsgId = uuid();

describe('*** UNIT TESTING USER MESSAGE INSERTION ***', () => {

    const mockInstructionId = uuid();
    const mockUserId = uuid();
    const mockBoostId = uuid();
    const testUserId = uuid();

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
        creatingUserId: testUserId,
        presentationType: 'ONCE_OFF',
        active: true,
        audienceType: 'ALL_USERS',
        templates: mockTemplate,
        audienceId: mockAudienceId,
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
        startTime: testTime.format(),
        endTime: '2061-01-09T11:47:41.596Z', 
        messageTitle: msgTemplate.title,
        messageBody: msgTemplate.body,
        messageVariant: variant,
        display: msgTemplate.display,
        instructionId: mockInstructionId,
        messagePriority: 100,
        followsPriorMessage: false,
        hasFollowingMessage: false,
        actionContext: {
            actionToTake: msgTemplate.actionToTake, ...msgTemplate.actionContext
        }
    }); 

    const resetInstruction = () => {
        mockInstruction.audienceType = 'ALL_USERS';
        mockInstruction.audienceId = mockAudienceId;
        mockInstruction.templates = mockTemplate;
    };
    
    const expectedInsertionRows = (quantity, start = 1) => Array(quantity).fill().map((_, i) => ({ insertionId: start + i, creationTime: mockCreationTime }));

    const commonAssertions = (result, presentationType, numberOfMessages) => {
        expect(result).to.exist;
        expect(result).to.have.property('instructionId', mockInstructionId);
        expect(result).to.have.property('instructionType', presentationType);
        expect(result).to.have.property('numberMessagesCreated', numberOfMessages);
        expect(result).to.have.property('creationTimeMillis', mockCreationTime);
        expect(result).to.have.property('instructionUpdateTime', mockUpdatedTime);
    };

    const standardStubExpectations = () => {
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockAudienceId);
        expect(insertUserMessagesStub).to.have.been.calledOnce;
        expect(updateInstructionStateStub).to.have.been.calledOnceWithExactly(mockInstructionId, 'MESSAGES_GENERATED');
    };

    beforeEach(() => {
        resetStubs();
        resetInstruction();
        momentStub.returns(testTime.clone());
        uuidStub.returns(mockMsgId);
    });

    it('Should insert notification messages for all users in current universe', async () => {
        const testNumberUsers = 5;

        const testUserIds = createMockUserIds(testNumberUsers);
        
        getMessageInstructionStub.withArgs(mockInstructionId).resolves(mockInstruction);
        getUserIdsStub.withArgs(mockAudienceId).resolves(testUserIds);
        insertUserMessagesStub.resolves(expectedInsertionRows(testNumberUsers));
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_GENERATED').resolves({ updatedTime: mockUpdatedTime });

        const result = await handler.createUserMessages({ instructions: [{ instructionId: mockInstructionId }]});
        logger('Result of user messages insertion:', result);

        commonAssertions(result[0], 'ONCE_OFF', testNumberUsers);
        standardStubExpectations();

        const testUserMsgs = testUserIds.map((userId) => mockUserMessage(userId));
        const insertUserMsgArgs = insertUserMessagesStub.getCall(0).args[0];

        expect(insertUserMsgArgs).to.be.an('array').of.length(testNumberUsers);
        
        const userIdToTest = testUserIds[Math.floor(Math.random() * testNumberUsers)];
        logger('Testing for user ID: ', userIdToTest);

        const testMessage = insertUserMsgArgs[0];
        expect(testMessage).to.have.property('messageId');
        Reflect.deleteProperty(testMessage, 'messageId');
        expect(testMessage).to.deep.equal(testUserMsgs[0]);

        expect(publishMultiLogStub).to.have.been.calledOnce;
        expect(publishMultiLogStub).to.have.been.calledWith(testUserIds, 'MESSAGE_CREATED', sinon.match.any);
    });

    it('Deactivates and expires message on instruction failure', async () => {
        const badInstruction = { ...mockInstruction };
        badInstruction.templates = [];

        const testNumberUsers = 5;
        const testUserIds = createMockUserIds(testNumberUsers);

        const expectedResult = [
            {
                instructionId: mockInstructionId,
                insertionResponse: { updatedTime: mockUpdatedTime }
            }
        ];
        
        getMessageInstructionStub.withArgs(mockInstructionId).resolves(badInstruction);
        getUserIdsStub.withArgs(mockAudienceId).resolves(testUserIds);
        updateInstructionStateStub.withArgs(mockInstructionId, 'EXPIRED').resolves({ updatedTime: mockUpdatedTime });
        deactivateInstructionStub.withArgs(mockInstructionId).resolves({ updatedTime: mockUpdatedTime });
        publishEventStub.resolves({ result: 'SUCCESS' });

        const result = await handler.createUserMessages({ instructions: [{ instructionId: mockInstructionId }]});
        logger('Result of user instruction deactivation:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);

        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockAudienceId);
        expect(updateInstructionStateStub).to.have.been.calledOnceWithExactly(mockInstructionId, 'EXPIRED');
        expect(deactivateInstructionStub).to.have.been.calledWith(mockInstructionId);
        publishEventStub(testUserId, 'MESSAGE_INSTRUCTION_FAILED', sinon.match.any);
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
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_GENERATED').resolves({ updatedTime: mockUpdatedTime });
        
        const result = await handler.createUserMessages({ instructions: [{ instructionId: mockInstructionId }]});
        logger('Result of user messages insertion:', result);

        commonAssertions(result[0], 'ONCE_OFF', testNumberUsers);
        standardStubExpectations();

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
        const defaultCount = insertUserMsgArgs.map((msg) => (defaultTester(msg) ? 1 : 0)).reduce((sum, cum) => sum + cum, 0);
        const variantCount = insertUserMsgArgs.map((msg) => (variantTester(msg) ? 1 : 0)).reduce((sum, cum) => sum + cum, 0);
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
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_GENERATED').resolves({ updatedTime: mockUpdatedTime });

        const result = await handler.createUserMessages({ instructions: [{ instructionId: mockInstructionId }]});
        logger('Result of insertion:', result);

        commonAssertions(result[0], 'ONCE_OFF', expectedNumberMessages);
        standardStubExpectations();
        
        // and todo : also check for inserting message sequence dict
        const insertUserMsgArgs = insertUserMessagesStub.getCall(0).args[0];
        expect(insertUserMsgArgs).to.be.an('array').of.length(expectedNumberMessages);
        const expectedOpeningMsg = mockUserMessage(testUserIds[0]);
        expectedOpeningMsg.hasFollowingMessage = true;
        const expectedSecondMsg = mockUserMessage(testUserIds[0], mockInstruction.templates.sequence[1].DEFAULT); // still 'DEFAULT' in its position
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
        expectedOpeningMsg.messageSequence = firstMsgToPers.messageSequence;
        expectedSecondMsg.messageId = secondMsgToPers.messageId;
        expectedSecondMsg.messageSequence = secondMsgToPers.messageSequence;

        expect(insertUserMsgArgs[0]).to.deep.equal(expectedOpeningMsg);
        expect(insertUserMsgArgs[1]).to.deep.equal(expectedSecondMsg);
    });

    it('should insert boost notification message from boost api', async () => {

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
            audienceId: mockAudienceId,
            recurrenceInstruction: null,
            responseAction: 'VIEW_HISTORY',
            responseContext: JSON.stringify({ boostId: mockBoostId }),
            startTime: '2050-09-01T11:47:41.596Z',
            endTime: '2061-01-09T11:47:41.596Z',
            lastProcessedTime: moment().format(),
            messagePriority: 0
        };

        getMessageInstructionStub.resolves(mockBoostInstruction);
        insertUserMessagesStub.resolves(expectedInsertionRows(1));
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_GENERATED').resolves({ updatedTime: mockUpdatedTime });

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
        
        commonAssertions(result[0], 'EVENT_DRIVEN', 1);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.not.have.been.called;
        expect(insertUserMessagesStub).to.have.been.calledOnce;
        expect(updateInstructionStateStub).to.have.been.calledOnceWithExactly(mockInstructionId, 'MESSAGES_GENERATED');

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
        getUserIdsStub.withArgs(mockAudienceId).resolves(testUserIds);
        insertUserMessagesStub.resolves(expectedInsertionRows(testNumberUsers));
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_GENERATED').resolves({ updatedTime: mockUpdatedTime });
        
        const mockEvent = { body: JSON.stringify({ instructions: [{ instructionId: mockInstructionId }]})};

        const result = await handler.createUserMessages(mockEvent);
        logger('Result of user messages insertion:', result);

        commonAssertions(result[0], 'ONCE_OFF', testNumberUsers);
        standardStubExpectations();
    });

    it('Handles insertions where no user ids are found', async () => {
        getMessageInstructionStub.resolves(mockInstruction);
        getUserIdsStub.withArgs(mockAudienceId).returns([]);

        const expectedResult = [{
            instructionId: mockInstructionId,
            insertionResponse: []
        }];
        
        const mockEvent = { instructions: [{ instructionId: mockInstructionId }]};

        const result = await handler.createUserMessages(mockEvent);
        logger('Result of instruction with no users:', result);

        expect(result).to.deep.equal(expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly(mockAudienceId);
        expect(insertUserMessagesStub).to.have.not.been.called;
        expect(updateInstructionStateStub).to.have.not.been.called;
    });

    it('should insert user message on individual user', async () => {
        getUserIdsStub.resolves(createMockUserIds(1));
        getMessageInstructionStub.resolves(mockInstruction);
        insertUserMessagesStub.resolves(expectedInsertionRows(1));
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_GENERATED').resolves({ updatedTime: mockUpdatedTime });
        
        const result = await handler.createUserMessages({ instructions: [{ instructionId: mockInstructionId }]});
        logger('Result of single user insertion:', result);
        
        commonAssertions(result[0], 'ONCE_OFF', 1);
        standardStubExpectations();
    });

    it('should insert user messages on a group of users', async () => {
        const numberSampledUsers = 7500;
        getUserIdsStub.withArgs(mockAudienceId).resolves(createMockUserIds(numberSampledUsers));
        getMessageInstructionStub.withArgs(mockInstructionId).resolves(mockInstruction);
        insertUserMessagesStub.resolves(expectedInsertionRows(numberSampledUsers));
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_GENERATED').resolves({ updatedTime: mockUpdatedTime });

        const result = await handler.createUserMessages({ instructions: [{ instructionId: mockInstructionId }]});
        logger('Result of group insertion (random sample):', result);

        commonAssertions(result[0], 'ONCE_OFF', numberSampledUsers);
        standardStubExpectations();

        const insertedMessages = insertUserMessagesStub.getCall(0).args[0];
        expect(insertedMessages).to.be.an('array').of.length(numberSampledUsers);
    });

    it('Handles extra parameter, including processed status', async () => {
        const instruction = { ...mockInstruction };
        
        getMessageInstructionStub.resolves(instruction);
        getUserIdsStub.resolves(createMockUserIds(1));
        insertUserMessagesStub.resolves(expectedInsertionRows(1));
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_GENERATED').resolves({ updatedTime: mockUpdatedTime });
        
        const mockEvent = { instructions: [{ instructionId: mockInstructionId, parameters: { processedStatus: 'READY_FOR_SENDING' }}]};

        const result = await handler.createUserMessages(mockEvent);
        logger('Result of single user insertion:', result);
        
        commonAssertions(result[0], 'ONCE_OFF', 1);
        standardStubExpectations();
    });

    it('Handles destination user ID and start time', async () => {
        const instructionFromRds = { ...mockInstruction };
                
        const scheduledTime = moment().add(1, 'day');
        
        getMessageInstructionStub.resolves(instructionFromRds);
        getUserIdsStub.resolves(createMockUserIds(1));
        momentStub.withArgs(scheduledTime.valueOf()).returns(scheduledTime.clone());
        insertUserMessagesStub.resolves(expectedInsertionRows(1));
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_GENERATED').resolves({ updatedTime: mockUpdatedTime });
        
        const mockPayload = {
            instructionId: mockInstructionId,
            destinationUserId: mockUserId,
            scheduledTimeEpochMillis: scheduledTime.valueOf()
        };

        const expectedMsg = mockUserMessage(mockUserId);
        expectedMsg.messageId = mockMsgId;
        expectedMsg.startTime = scheduledTime.format();

        const mockEvent = { instructions: [mockPayload] };

        const result = await handler.createUserMessages(mockEvent);
        logger('Result of single user insertion:', result);
        
        commonAssertions(result[0], 'ONCE_OFF', 1);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.not.have.been.called; // maybe in time we will cross check if user id is in audience
        
        const calledMsg = insertUserMessagesStub.getCall(0).args[0][0];
        expect(calledMsg).to.deep.equal(expectedMsg);
        
        expect(insertUserMessagesStub).to.have.been.calledOnceWithExactly([expectedMsg], sinon.match.array);
        expect(updateInstructionStateStub).to.have.been.calledOnceWithExactly(mockInstructionId, 'MESSAGES_GENERATED');
    });

    it('Handles defaultStatus included in instruction', async () => {
        const instruction = { ...mockInstruction };
        instruction.defaultStatus = 'CREATED';

        getMessageInstructionStub.resolves(instruction);
        getUserIdsStub.resolves(createMockUserIds(1));
        insertUserMessagesStub.resolves(expectedInsertionRows(1));
        updateInstructionStateStub.withArgs(mockInstructionId, 'MESSAGES_GENERATED').resolves({ updatedTime: mockUpdatedTime });
        
        const mockEvent = { instructions: [{ instructionId: mockInstructionId }]};

        const result = await handler.createUserMessages(mockEvent);
        logger('Result of single user insertion:', result);
        
        commonAssertions(result[0], 'ONCE_OFF', 1);
        standardStubExpectations();
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


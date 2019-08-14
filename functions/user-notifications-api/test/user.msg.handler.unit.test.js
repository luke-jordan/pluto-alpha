'use strict';

const logger = require('debug')('jupiter:user-notifications:user-message-handler-test');
const uuid = require('uuid/v4');
const config = require('config');
const moment = require('moment');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;
const proxyquire = require('proxyquire');


const getMessageInstructionStub = sinon.stub();
const updateMessageInstructionStub = sinon.stub();
const getUserIdsStub = sinon.stub();
const insertUserMessagesStub = sinon.stub();
const momentStub = sinon.stub();

const handler = proxyquire('../user-message-handler', {
    './persistence/rds.notifications': {
        'getMessageInstruction': getMessageInstructionStub,
        'updateMessageInstruction': updateMessageInstructionStub,
        'getUserIds': getUserIdsStub,
        'insertUserMessages': insertUserMessagesStub
    },
    'moment': momentStub
});

const resetStubs = () => {
    getMessageInstructionStub.reset();
    updateMessageInstructionStub.reset();
    getUserIdsStub.reset();
    insertUserMessagesStub.reset();
    momentStub.reset();
}


describe('*** UNIT TESTING USER MESSAGE INSERTION ***', () => {

    const mockUserId = uuid();
    const mockInstructionId = uuid();
    const mockInstructionIdOnIndividual = uuid();
    const mockInstructionIdOnGroup = uuid();
    const mockInstructionIdOnError = uuid();
    const mockBoostId = uuid();
    const testTime = moment();
    const mockCreationTime = '2049-06-22T07:38:30.016Z';
    const mockUpdateTime = '2059-06-22T07:38:30.016Z';
    const mockInsertionId = 111;

    const mockInstruction = {
        instructionId: mockInstructionId,
        presentationType: 'ONCE_OFF',
        active: true,
        audienceType: 'ALL_USERS',
        templates: {
            default: config.get('instruction.templates.default'),
            otherTemplates: null
        },
        selectionInstruction: { selectionType: 'whole_universe', proportionUsers: 1.0 },
        recurrenceInstruction: null,
        responseAction: 'VIEW_HISTORY',
        responseContext: { boostId: mockBoostId },
        startTime: '2050-09-01T11:47:41.596Z',
        endTime: '2061-01-09T11:47:41.596Z',
        lastProcessedTime: moment().format(),
        messagePriority: 0
    };

    const resetInstruction = () => {
        mockInstruction.audienceType = 'ALL_USERS';
        mockInstruction.selectionInstruction = { selectionType: 'whole_universe', proportionUsers: 1.0 };
    };

    const createMockUserIds = (quantity) => {
        const mockUserIds = [];
        for (let i = 0; i < quantity; i++) {
            mockUserIds.push(uuid());
        };
        logger('created userIds of length:', mockUserIds.length);
        return mockUserIds;
    };

    const expectedInsertionResult = {
        messageInsertionResult: [{
            insertion_id: mockInsertionId,
            creation_time: mockCreationTime
        }],
        instructionUpdateResult: [{
            insertion_id: mockInsertionId,
            update_time: mockUpdateTime
        }]
    }

    beforeEach(() => {
        resetStubs();
        resetInstruction();
        momentStub.returns({ format: () => testTime.format() });
    });

    it('should insert notification messages for all users in current universe', async () => {
        getMessageInstructionStub.withArgs(mockInstructionId).returns(mockInstruction);
        getUserIdsStub.withArgs().returns(createMockUserIds(1000));
        insertUserMessagesStub.returns([ { insertion_id: mockInsertionId, creation_time: mockCreationTime } ]);
        updateMessageInstructionStub.withArgs(mockInstructionId, 'last_processed_time', testTime.format()).returns([ { insertion_id: mockInsertionId, update_time: mockUpdateTime } ]);
        const expectedResult = expectedInsertionResult;
        const mockEvent = {
            instructionId: mockInstructionId
        };

        const result = await handler.populateUserMessages(mockEvent);
        logger('Result of user messages insertion:', result);

        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(200);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly();
        expect(insertUserMessagesStub).to.have.been.calledOnce;
        expect(updateMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId, 'last_processed_time', testTime.format());
    });

    it('should user other template where provided', async () => {
        mockInstruction.templates.otherTemplates = 'The world ends at sunrise.';
        getMessageInstructionStub.withArgs(mockInstructionId).returns(mockInstruction);
        getUserIdsStub.withArgs().returns(createMockUserIds(1000));
        insertUserMessagesStub.returns([ { insertion_id: mockInsertionId, creation_time: mockCreationTime } ]);
        updateMessageInstructionStub.withArgs(mockInstructionId, 'last_processed_time', testTime.format()).returns([ { insertion_id: mockInsertionId, update_time: mockUpdateTime } ]);
        const expectedResult = expectedInsertionResult;
        const mockEvent = {
            instructionId: mockInstructionId
        };

        const result = await handler.populateUserMessages(mockEvent);
        logger('Result of user messages insertion:', result);

        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(200);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly();
        expect(insertUserMessagesStub).to.have.been.calledOnce;
        expect(updateMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionId, 'last_processed_time', testTime.format());
    });

    it('should insert user message on individual user', async () => {
        mockInstruction.audienceType = 'INDIVIDUAL';
        mockInstruction.selectionInstruction = { userId: mockUserId };
        getMessageInstructionStub.withArgs(mockInstructionIdOnIndividual).returns(mockInstruction);
        insertUserMessagesStub.returns([ { insertion_id: mockInsertionId, creation_time: mockCreationTime } ]);
        updateMessageInstructionStub.withArgs(mockInstructionIdOnIndividual, 'last_processed_time', testTime.format()).returns([ { insertion_id: mockInsertionId, update_time: mockUpdateTime } ]);
        const expectedResult = expectedInsertionResult;
        const mockEvent = {
            instructionId: mockInstructionIdOnIndividual
        };

        const result = await handler.populateUserMessages(mockEvent);
        logger('Result of user messages insertion:', result);

        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(200);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionIdOnIndividual);
        expect(getUserIdsStub).to.have.not.been.called;
        expect(insertUserMessagesStub).to.have.been.calledOnce;
        expect(updateMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionIdOnIndividual, 'last_processed_time', testTime.format());
    });

    it('should insert user messages on a group of users', async () => {
        mockInstruction.audienceType = 'GROUP';
        mockInstruction.selectionInstruction = { selectionType: 'whole_universe', proportionUsers: 0.75 };
        getMessageInstructionStub.withArgs(mockInstructionIdOnGroup).returns(mockInstruction);
        getUserIdsStub.withArgs().returns(createMockUserIds(750));
        insertUserMessagesStub.returns([ { insertion_id: mockInsertionId, creation_time: mockCreationTime } ]);
        updateMessageInstructionStub.withArgs(mockInstructionIdOnGroup, 'last_processed_time', testTime.format()).returns([ { insertion_id: mockInsertionId, update_time: mockUpdateTime } ]);
        const expectedResult = expectedInsertionResult;
        const mockEvent = {
            instructionId: mockInstructionIdOnGroup
        };

        const result = await handler.populateUserMessages(mockEvent);
        logger('Result of user messages insertion:', result);

        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(200);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionIdOnGroup);
        expect(getUserIdsStub).to.have.been.calledOnceWithExactly('whole_universe', 0.75);
        expect(insertUserMessagesStub).to.have.been.calledOnce;
        expect(updateMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionIdOnGroup, 'last_processed_time', testTime.format());
    });

    it('should throw an error on invalid audience type (edge case)', async () => {
        mockInstruction.audienceType = 'MILITIA';
        getMessageInstructionStub.withArgs(mockInstructionIdOnError).returns(mockInstruction);
        const expectedResult = { message: `Unsupperted message audience type: ${mockInstruction.audienceType}`};
        const mockEvent = {
            instructionId: mockInstructionIdOnError
        };

        const result = await handler.populateUserMessages(mockEvent);
        logger('Result of user messages insertion:', result);

        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(500);
        expect(result).to.have.property('body');
        const parsedResult = JSON.parse(result.body);
        expect(parsedResult).to.deep.equal(expectedResult);
        expect(getMessageInstructionStub).to.have.been.calledOnceWithExactly(mockInstructionIdOnError);
        expect(getUserIdsStub).to.have.not.been.called;
        expect(insertUserMessagesStub).to.have.not.been.called;
        expect(updateMessageInstructionStub).to.have.not.been.called;
    });
});
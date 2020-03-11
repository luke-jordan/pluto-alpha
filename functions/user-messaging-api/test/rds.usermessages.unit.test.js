'use strict';

const logger = require('debug')('jupiter:user-msg-picker:rds-test');
const uuid = require('uuid/v4');
const config = require('config');
const moment = require('moment');

const helper = require('./message.test.helper');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;
const proxyquire = require('proxyquire').noCallThru();

const userMessageTable = config.get('tables.userMessagesTable');

const testMsgId = uuid();
const testFollowingMsgId = uuid();
const testBoostId = uuid();
const testUserId = uuid();

const selectQueryStub = sinon.stub();
const updateRecordStub = sinon.stub();
const multiTableStub = sinon.stub();
const multiUpdateInsertStub = sinon.stub();

const momentStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = selectQueryStub;
        this.updateRecord = updateRecordStub;
        this.largeMultiTableInsert = multiTableStub;
        this.multiTableUpdateAndInsert = multiUpdateInsertStub;
        this.updateRecordObject = updateRecordStub;
    }
}

const persistence = proxyquire('../persistence/rds.usermessages', {
    'rds-common': MockRdsConnection,
    'moment': momentStub, 
    '@noCallThru': true
});

const resetStubs = () => helper.resetStubs(updateRecordStub, selectQueryStub, multiUpdateInsertStub, momentStub);

describe('*** UNIT TESTING MESSAGE INSERTION RDS ***', () => {

    beforeEach(() => resetStubs());

    it('should insert user messages', async () => {
        const mockAccountId = uuid();
        const mockInstructionId = uuid();
        const mockCreationTime = moment().format();
        const row = {
            destinationUserId: mockAccountId,
            instructionId: mockInstructionId,
            message: 'Welcome to Jupiter Savings.',
            presentationInstruction: null
        };
        const mockRows = [row, row, row];
        const rowObjectKeys = Object.keys(row);
        const mockInsertionArgs = {
            query: `insert into ${config.get('tables.userMessagesTable')} (${helper.extractQueryClause(rowObjectKeys)}) values %L returning message_id, creation_time`,
            columnTemplate: helper.extractColumnTemplate(rowObjectKeys),
            rows: mockRows
        };
        const insertionResult = [
            { 'insertion_id': 99, 'creation_time': mockCreationTime },
            { 'insertion_id': 100, 'creation_time': mockCreationTime }, { 'insertion_id': 101, 'creation_time': mockCreationTime }
        ];
        multiTableStub.withArgs([mockInsertionArgs]).resolves([insertionResult]);

        const expectedResult = [
            { 'insertionId': 99, 'creationTime': mockCreationTime },
            { 'insertionId': 100, 'creationTime': mockCreationTime }, { 'insertionId': 101, 'creationTime': mockCreationTime }
        ];

        const result = await persistence.insertUserMessages(mockRows, rowObjectKeys);
        logger('Result of bulk user message insertion:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(multiTableStub).to.have.been.calledOnceWithExactly([mockInsertionArgs]);
    });

    it('should get user ids from audience ID', async () => {
        const mockUserId = uuid();
        const mockAudienceId = uuid();

        const expectedQuery = `select account_id, owner_user_id from account_data.core_account_ledger where account_id in ` +
            `(select account_id from ${config.get('tables.audienceJoinTable')} where audience_id = $1 and active = $2)`;
        selectQueryStub.withArgs(expectedQuery, [mockAudienceId, true]).
            resolves([{ 'account_id': uuid(), 'owner_user_id': mockUserId }]);

        const expectedResult = [mockUserId];

        const result = await persistence.getUserIdsForAudience(mockAudienceId);
        logger('got this back from user id extraction:', result);
        
        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(expectedQuery, [mockAudienceId, true]);
    });

});

describe('*** UNIT TESTING MESSAGE PICKING RDS ****', () => {

    const testStartTime = moment().subtract(10, 'minutes');
    const testExpiryMoment = moment().add(6, 'hours');
    const testUpdatedTime = moment();

    beforeEach(() => {
        resetStubs();
        // sometimes the moment-sinon combination is a bit tiresome
        momentStub.withArgs(testStartTime.format()).returns(moment(testStartTime.format()));
        momentStub.withArgs(testExpiryMoment.format()).returns(moment(testExpiryMoment.format()));
        momentStub.withArgs(testUpdatedTime.format()).returns(moment(testUpdatedTime.format()));
    });

    const msgRawFromRds = {
        'message_id': testMsgId,
        'creation_time': testStartTime.format(),
        'destination_user_id': testUserId,
        'instruction_id': uuid(),
        'message_title': 'Boost available!',
        'message_body': 'Hello! Jupiter is now live. To celebrate, if you add $10, you get $10 boost',
        'start_time': testStartTime.format(),
        'end_time': testExpiryMoment.format(),
        'message_priority': 20,
        'updated_time': moment().subtract(1, 'minutes').format(),
        'processed_status': 'READY_FOR_SENDING',
        'display_type': 'CARD',
        'display_instructions': { titleType: 'EMPHASIS', iconType: 'BOOST_ROCKET' },
        'action_context': { actionToTake: 'ADD_CASH', boostId: testBoostId },
        'follows_prior_msg': false,
        'has_following_msg': true,
        'following_messages': { msgOnSuccess: testFollowingMsgId },
        'deliveries_max': 5,
        'deliveries_done': 1,
        'flags': []
    };

    const expectedTransformedMsg = {
        messageId: testMsgId,
        destinationUserId: testUserId,
        messageTitle: 'Boost available!',
        messageBody: 'Hello! Jupiter is now live. To celebrate, if you add $10, you get $10 boost',
        creationTime: moment(testStartTime.format()),
        startTime: moment(testStartTime.format()),
        endTime: moment(testExpiryMoment.format()),
        messagePriority: 20,
        displayType: 'CARD',
        displayInstructions: { titleType: 'EMPHASIS', iconType: 'BOOST_ROCKET' },
        actionContext: { actionToTake: 'ADD_CASH', boostId: testBoostId },
        followsPriorMsg: false,
        hasFollowingMsg: true,
        followingMessages: { msgOnSuccess: testFollowingMsgId }
    };

    it('Finds messages for user correctly and transforms them', async () => {
        const expectedQuery = `select * from ${userMessageTable} where destination_user_id = $1 and ` + 
            `processed_status = $2 and end_time > current_timestamp and start_time < current_timestamp and ` + 
            `deliveries_done < deliveries_max and display ->> 'type' in ($3)`;
        
            selectQueryStub.resolves([msgRawFromRds]);

        const resultOfFetch = await persistence.getNextMessage(testUserId, ['CARD']);
        logger('Result of fetch: ', resultOfFetch);

        expect(resultOfFetch).to.deep.equal([expectedTransformedMsg]);
        expect(selectQueryStub).to.have.been.calledWith(expectedQuery, [testUserId, 'READY_FOR_SENDING', 'CARD']);
    });

    it('Finds pending push messages', async () => {
        const expectedQuery = [
            `select * from ${userMessageTable} where processed_status = $1 and end_time > current_timestamp and ` +
                `start_time < current_timestamp and deliveries_done < deliveries_max and display ->> 'type' = $2`,
            ['READY_FOR_SENDING', 'PUSH']
        ];
        selectQueryStub.resolves([msgRawFromRds, msgRawFromRds]);

        const result = await persistence.getPendingOutboundMessages('PUSH');
        logger('Result of pending messages extraction:', result);
    
        expect(result).to.exist;
        expect(result).to.deep.equal([expectedTransformedMsg, expectedTransformedMsg]);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(...expectedQuery);
    });

    it('Updates message processed status correctly', async () => {
        const expectedUpdateDef = { 
            table: userMessageTable,
            key: { messageId: testMsgId }, 
            value: { processedStatus: 'DISMISSED' }, 
            returnClause: 'message_id, updated_time' 
        };
        multiUpdateInsertStub.resolves([{ 'message_id': testMsgId, 'updated_time': testUpdatedTime.format() }]);
        
        const resultOfUpdateQ = await persistence.updateUserMessage(testMsgId, { processedStatus: 'DISMISSED' });
        logger('Result of query: ', resultOfUpdateQ);
        
        expect(resultOfUpdateQ).to.exist;
        expect(resultOfUpdateQ).to.deep.equal({ messageId: testMsgId, updatedTime: moment(testUpdatedTime.format()) });
        expect(multiUpdateInsertStub).to.have.been.calledOnceWith([expectedUpdateDef], []);
    });

    it('Gets message instruction', async () => {
        const testInstructionId = uuid();

        const selectQuery = `select * from ${userMessageTable} where destination_user_id = $1 and instruction_id = $2`;

        selectQueryStub.resolves([msgRawFromRds]);

        const messageIntruction = await persistence.getInstructionMessage(testUserId, testInstructionId);
        logger('Result of instruction extraction:', messageIntruction);

        expect(messageIntruction).to.exist;
        expect(messageIntruction).to.deep.equal([expectedTransformedMsg]);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(selectQuery, [testUserId, testInstructionId]);
    });

    it('Handles batch status updates', async () => {
        const mockMessageId = uuid();
        const mockMessageIds = [mockMessageId, mockMessageId];

        const expectedQuery = [
            `update ${userMessageTable} set processed_status = $1 where message_id in ($2, $3)`,
            ['DISMISSED', mockMessageId, mockMessageId]
        ];

        updateRecordStub.withArgs(...expectedQuery).resolves([]);

        const resultOfUpdate = await persistence.bulkUpdateStatus(mockMessageIds, 'DISMISSED');
        logger('Result of batch update:', resultOfUpdate);
    
        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal([]);
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(...expectedQuery);
    });

});

describe('*** UNIT TEST BASIC INSTRUCTION OPERATIONS NEEDED BY USER MESSAGES ***', () => {

    const mockUserId = uuid();
    const mockInstructionId = uuid();
    const mockMinIntervalDays = 5;
    const mockMaxInQueue = 5;

    const mockDurationClause = moment().subtract(mockMinIntervalDays, 'days');

    beforeEach(() => {
        resetStubs();
        momentStub.returns({ subtract: () => mockDurationClause, format: () => mockDurationClause.format() });
    });

    it('should get message instruction', async () => {
        const expectedQuery = `select * from ${config.get('tables.messageInstructionTable')} where instruction_id = $1`;
        
        selectQueryStub.withArgs(expectedQuery, [mockInstructionId]).returns([{ 'instruction_id': mockInstructionId }]);
        const expectedResult = { instructionId: mockInstructionId };

        const result = await persistence.getMessageInstruction(mockInstructionId);
        logger('Result of instruction extraction from db:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(expectedQuery, [mockInstructionId]);
    });

    it('should get message instructions that match specified audience and presentation type', async () => {
        const mockInstruction = { instructionId: mockInstructionId, presentationType: 'RECURRING' }; // and the rest
        const mockSelectArgs = [
            `select * from ${config.get('tables.messageInstructionTable')} where presentation_type = $1 and active = true and end_time > current_timestamp and audience_type in ($2) and processed_status in ($3)`,
            ['ALL_USERS', 'RECURRING', 'READY_TO_SEND']
        ];
        selectQueryStub.withArgs(...mockSelectArgs).returns([mockInstruction, mockInstruction, mockInstruction]);
        const expectedResult = [mockInstruction, mockInstruction, mockInstruction];

        const result = await persistence.getInstructionsByType('ALL_USERS', ['RECURRING'], ['READY_TO_SEND']);
        logger('Result of instruction extraction from db:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(...mockSelectArgs);
    });

    it('Updates instruction state', async () => {
        const mockCurrentTime = moment().format();
        const mockUpdateRecordArgs = {
            table: config.get('tables.messageInstructionTable'),
            key: { instructionId: mockInstructionId },
            value: { processedStatus: 'READY_TO_SEND', lastProcessedTime: mockCurrentTime },
            returnClause: 'updated_time'
        };

        momentStub.returns({ format: () => mockCurrentTime });
        updateRecordStub.withArgs(mockUpdateRecordArgs).returns([{ 'update_time': '2049-06-22T07:38:30.016Z' }]);

        // sync with new imlementation
        const resultOfUpdate = await persistence.updateInstructionState(mockInstructionId, 'READY_TO_SEND');
        logger('Result of message instruction update:', resultOfUpdate);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal([{ updateTime: '2049-06-22T07:38:30.016Z' }]);
        expect(momentStub).to.have.been.calledOnce;
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(mockUpdateRecordArgs);
    });

    it('Deactivates message instruction', async () => {
        const mockCurrentTime = moment().format();
        const mockUpdateRecordArgs = {
            table: config.get('tables.messageInstructionTable'),
            key: { instructionId: mockInstructionId },
            value: { active: false, lastProcessedTime: mockCurrentTime },
            returnClause: 'updated_time'
        };

        momentStub.returns({ format: () => mockCurrentTime });
        updateRecordStub.withArgs(mockUpdateRecordArgs).returns([{ 'update_time': '2049-06-22T07:38:30.016Z' }]);

        const resultOfUpdate = await persistence.deactivateInstruction(mockInstructionId);
        logger('Result of message instruction update:', resultOfUpdate);

        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal([{ updateTime: '2049-06-22T07:38:30.016Z' }]);
        expect(momentStub).to.have.been.calledOnce;
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(mockUpdateRecordArgs);
    });

    it('Finds user ids that are not disqualified by recurrence parameters', async () => {
        const mockUnfilteredId = uuid();
        const minIntervalSelectArgs = [
            `select distinct(destination_user_id) from ${config.get('tables.userMessagesTable')} where instruction_id = $1 and creation_time > $2`,
            [mockInstructionId, mockDurationClause.format()]
        ];

        const queueSizeSelectArgs = [
            `select destination_user_id from ${config.get('tables.userMessagesTable')} where processed_status = $1 and end_time > current_timestamp group by destination_user_id having count(*) > $2`,
            ['READY_FOR_SENDING', mockMaxInQueue]
        ];

        selectQueryStub.withArgs(...minIntervalSelectArgs).resolves([{ 'destination_user_id': mockUserId }, { 'destination_user_id': mockUserId }]);
        selectQueryStub.withArgs(...queueSizeSelectArgs).resolves([{ 'destination_user_id': mockUserId }, { 'destination_user_id': mockUserId }]);

        const mockEvent = [[mockUserId, mockUnfilteredId], { instructionId: mockInstructionId, recurrenceParameters: { minIntervalDays: mockMinIntervalDays, maxInQueue: mockMaxInQueue } }];

        const resultOfFilter = await persistence.filterUserIdsForRecurrence(...mockEvent);
        logger('Result of filter:', resultOfFilter);

        expect(resultOfFilter).to.exist;
        expect(resultOfFilter).to.deep.equal([mockUnfilteredId]);
        expect(selectQueryStub).to.have.been.calledWith(...minIntervalSelectArgs);
        expect(selectQueryStub).to.have.been.calledWith(...queueSizeSelectArgs);
    });

});

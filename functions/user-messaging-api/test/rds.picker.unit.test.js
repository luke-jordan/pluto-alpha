'use strict';

const logger = require('debug')('jupiter:user-msg-picker:rds-test');
const uuid = require('uuid/v4');
const config = require('config');
const moment = require('moment');

const testHelper = require('./message.test.helper');

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

const updateRecordStub = sinon.stub();
const selectQueryStub = sinon.stub();
const multiUpdateInsertStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = selectQueryStub;
        this.updateRecord = updateRecordStub;
        this.multiTableUpdateAndInsert = multiUpdateInsertStub;
    }
}

const persistence = proxyquire('../persistence/rds.msgpicker', {
    'rds-common': MockRdsConnection,
    '@noCallThru': true
});

const resetStubs = () => testHelper.resetStubs(updateRecordStub, selectQueryStub, multiUpdateInsertStub);

describe('*** UNIT TESTING MESSAGE PICKING RDS ****', () => {

    beforeEach(() => resetStubs());

    const testStartTime = moment().subtract(10, 'minutes');
    const testExpiryMoment = moment().add(6, 'hours');

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
            `processed_status = $2 and end_time > current_timestamp and deliveries_done < deliveries_max and display ->> 'type' != $3`;
        selectQueryStub.resolves([msgRawFromRds]);

        const resultOfFetch = await persistence.getNextMessage(testUserId, true);
        logger('Result of fetch: ', resultOfFetch);

        expect(resultOfFetch).to.deep.equal([expectedTransformedMsg]);
        expect(selectQueryStub).to.have.been.calledWith(expectedQuery, [testUserId, 'READY_FOR_SENDING', 'PUSH']);
    });

    it('Finds pending push messages', async () => {
        const expectedQuery = [
            `select * from ${userMessageTable} where processed_status = $1 and end_time > current_timestamp and deliveries_done < deliveries_max and display ->> 'type' = $2`,
            ['READY_FOR_SENDING', 'PUSH']
        ];
        selectQueryStub.withArgs(...expectedQuery).resolves([msgRawFromRds, msgRawFromRds]);

        const result = await persistence.getPendingPushMessages();
        logger('Result of pending messages extraction:', result);
    
        expect(result).to.exist;
        expect(result).to.deep.equal([expectedTransformedMsg, expectedTransformedMsg]);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(...expectedQuery);
    });

    it('Updates message processed status correctly', async () => {
        const updatedTime = moment();
        const expectedUpdateDef = { 
            table: userMessageTable,
            key: { messageId: testMsgId }, 
            value: { processedStatus: 'DISMISSED' }, 
            returnClause: 'message_id, updated_time' 
        };
        multiUpdateInsertStub.resolves([{ 'message_id': testMsgId, 'updated_time': updatedTime.format() }]);
        
        const resultOfUpdateQ = await persistence.updateUserMessage(testMsgId, { processedStatus: 'DISMISSED' });
        logger('Result of query: ', resultOfUpdateQ);
        
        expect(resultOfUpdateQ).to.exist;
        expect(resultOfUpdateQ).to.deep.equal({ messageId: testMsgId, updatedTime: moment(updatedTime.format()) });
        expect(multiUpdateInsertStub).to.have.been.calledOnceWith([expectedUpdateDef], []);
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

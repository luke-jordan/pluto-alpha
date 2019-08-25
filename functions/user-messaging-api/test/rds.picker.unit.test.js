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
const userAccountTable = config.get('tables.accountLedger');

const testMsgId = uuid();
const testFollowingMsgId = uuid();
const testBoostId = uuid();
const testUserId = uuid();

// todo : alter update record in RDS module to use same pattern as multi
const updateRecordStub = sinon.stub();
const selectQueryStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = selectQueryStub;
        this.multiTableUpdateAndInsert = updateRecordStub;
    }
}

const persistence = proxyquire('../persistence/rds.msgpicker', {
    'rds-common': MockRdsConnection,
    '@noCallThru': true
});

const resetStubs = () => testHelper.resetStubs(updateRecordStub, selectQueryStub);

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
            `processed_status = $2 and end_time > current_timestamp and deliveries_done < deliveries_max`;
        selectQueryStub.resolves([msgRawFromRds]);

        const resultOfFetch = await persistence.getNextMessage(testUserId);
        logger('Result of fetch: ', resultOfFetch);

        expect(resultOfFetch).to.deep.equal([expectedTransformedMsg]);
        expect(selectQueryStub).to.have.been.calledWith(expectedQuery, [testUserId, 'READY_FOR_SENDING']);
    });

    it('Retrieves user balance correctly', async () => {
        const expectedBalanceQuery = `select sum(amount), unit from ${userAccountTable} where owner_user_id = $1 and ` +
            `currency = $2 and settlement_status = $3 and transaction_type in ($4) group by unit`;
        const expectedBalanceTypes = [`'USER_SAVING_EVENT'`, `'ACCRUAL'`, `'CAPITALIZATION'`, `'WITHDRAWAL'`];
        const expectedBalanceValues = [testUserId, 'USD', 'SETTLED', expectedBalanceTypes.join(',')];

        selectQueryStub.resolves([{ amount: 100, unit: 'WHOLE_CURRENCY' }, { amount: 10000, unit: 'WHOLE_CENT' }, { amount: 1000000, unit: 'HUNDREDTH_CENT' }]);
        
        const resultOfSum = await persistence.getUserAccountFigure({ systemWideUserId: testUserId, operation: 'balance::WHOLE_CENT::USD' });
        logger('Result of sum: ', resultOfSum);

        expect(resultOfSum).to.deep.equal({ amount: 30000, unit: 'WHOLE_CENT', currency: 'USD' });
        expect(selectQueryStub).to.have.been.calledWith(expectedBalanceQuery, expectedBalanceValues);
    });

    it('Retrieves and sums user interest correctly', async () => {
        const expectedInterestQuery = `select sum(amount), unit from ${userAccountTable} where owner_user_id = $1 and ` +
            `currency = $2 and settlement_status = $3 and transaction_type in ($4) and creation_time > $5 group by unit`;
        const expectedTxTypes = [`'ACCRUAL'`, `'CAPITALIZATION'`];
        const expectedValues = [testUserId, 'USD', 'SETTLED', expectedTxTypes.join(','), moment(0).format()];

        selectQueryStub.resolves([{ amount: 10, unit: 'WHOLE_CURRENCY' }, { amount: 100000, unit: 'HUNDREDTH_CENT' }]);
        const resultOfInterest = await persistence.getUserAccountFigure({ systemWideUserId: testUserId, operation: 'interest::WHOLE_CURRENCY::USD::0'});
        logger('Result of interest calc: ', resultOfInterest);

        expect(resultOfInterest).to.deep.equal({ amount: 20, unit: 'WHOLE_CURRENCY', currency: 'USD' });
        expect(selectQueryStub).to.have.been.calledWith(expectedInterestQuery, expectedValues);
    });

    it('Gracefully handles unknown parameter', async () => {
        const resultOfBadQuery = await persistence.getUserAccountFigure({ systemWideUserId: testUserId, operation: 'some_weird_thing' });
        logger('Result of bad query: ', resultOfBadQuery);
        expect(resultOfBadQuery).to.be.undefined;
    });


    it('Updates message processed status correctly', async () => {
        const updatedTime = moment();
        const expectedUpdateDef = { 
            key: { messageId: testMsgId }, 
            value: { processedStatus: 'DISMISSED' }, 
            returnClause: 'message_id, updated_time' 
        };
        updateRecordStub.resolves([{ 'message_id': testMsgId, 'updated_time': updatedTime.format() }]);
        
        const resultOfUpdateQ = await persistence.updateUserMessage(testMsgId, { processedStatus: 'DISMISSED' });
        logger('Result of query: ', resultOfUpdateQ);
        
        expect(resultOfUpdateQ).to.exist;
        expect(resultOfUpdateQ).to.deep.equal({ messageId: testMsgId, updatedTime: moment(updatedTime.format()) });
        expect(updateRecordStub).to.have.been.calledOnceWith([expectedUpdateDef], []);
    });


});
'use strict';

const uuid = require('uuid/v4');
const moment = require('moment');

const chai = require('chai');
const expect = chai.expect;

chai.use(require('sinon-chai'));

const tester = require('../condition-tester');

describe('*** TESTING CONDITIONS ****', () => {

    it('Checks event trigger properly', () => {
        const condition = 'event_occurs #{USER_CREATED_ACCOUNT}';
        const event = { eventType: 'USER_CREATED_ACCOUNT' };

        const result = tester.testConditionsForStatus(event, [condition]);
        expect(result).to.be.true;
    });

    it('Does a tournament check properly', () => {
        const condition = 'number_taps_in_first_N #{1::10000}';

        const mockUserResponseList = [
            { accountId: 'account-id-1', logContext: { numberTaps: 20, timeTakenMillis: 10000 } },
            { accountId: 'account-id-2', logContext: { numberTaps: 10, timeTakenMillis: 10000 } },
            { accountId: 'account-id-3', logContext: { numberTaps: 40, timeTakenMillis: 10000 } }
        ];

        const eventContext = { accountScoreList: mockUserResponseList };

        const eventId1 = { eventType: 'BOOST_EXPIRED', accountId: 'account-id-1', eventContext };
        const result1 = tester.testConditionsForStatus(eventId1, [condition]);

        const eventId3 = { eventType: 'BOOST_EXPIRED', accountId: 'account-id-3', eventContext };
        const result2 = tester.testConditionsForStatus(eventId3, [condition]);

        expect(result1).to.be.false;
        expect(result2).to.be.true;
    });

    it('Checks for first save correctly', () => {
        const sampleEvent = {
            accountId: uuid(),
            eventType: 'SAVING_PAYMENT_SUCCESSFUL',
            eventContext: {
                transactionId: uuid(),
                savedAmount: '5000000::HUNDREDTH_CENT::USD',
                firstSave: true,
                saveCount: 1
            }
        };

        const result1 = tester.testConditionsForStatus(sampleEvent, ['first_save_above #{0::HUNDREDTH_CENT::USD}']);
        expect(result1).to.be.true;
    });

    it('Fails spoof first save attempts', () => {
        const condition = ['first_save_above #{1::HUNDREDTH_CENT::USD}'];

        const eventType = 'SAVING_PAYMENT_SUCCESSFUL';
        const sampleContext1 = { savedAmount: '10::HUNDREDTH_CENT::ZAR', saveCount: 2, firstSave: true };
        expect(tester.testConditionsForStatus({ eventType, eventContext: sampleContext1 }, condition)).to.be.false;

        const sampleContext2 = { savedAmount: '0::HUNDREDTH_CENT::ZAR', saveCount: 1, firstSave: true };
        expect(tester.testConditionsForStatus({ eventType, eventContext: sampleContext2 }, condition)).to.be.false;        
    });

    it('Returns false on save if tagged with another boost, regardless', () => {
        const condition = ['save_event_greater_than #{200000::HUNDREDTH_CENT::USD}'];

        const eventContext = { transactionTags: ['BOOST::some-boost'] };
        const eventParameters = { eventType: 'SAVING_PAYMENT_SUCCESSFUL', boostId: 'different-boost', eventContext };

        expect(tester.testConditionsForStatus(eventParameters, condition)).to.be.false;
    });
    
});

describe('** FRIEND CONDITION ***', () => {

    const mockFriend = (createdDaysAgo, userInitiated = false) => ({ 
        relationshipId: uuid(), 
        creationTimeMillis: moment().subtract(createdDaysAgo, 'days').valueOf(),
        userInitiated
    });

    it('Checks friend numbers correctly, pass condition', () => {
        const startMoment = moment().subtract(3, 'days');
        const condition = [`friends_added_since #{3::${startMoment.valueOf()}}`];

        const sampleEvent = {
            userId: uuid(),
            eventType: 'FRIEND_REQUEST_INITIATED_ACCEPTED',
            eventContext: {
                friendshipList: [mockFriend(1, true), mockFriend(2, false), mockFriend(0, true)]
            }
        };

        const result = tester.testConditionsForStatus(sampleEvent, condition);
        expect(result).to.be.true;
    });

    it('Checks friend numbers correctly, fail condition', () => {
        const startMoment = moment().subtract(3, 'days');
        const condition = [`friends_added_since #{3::${startMoment.valueOf()}}`];

        const sampleEvent = {
            userId: uuid(),
            eventType: 'FRIEND_REQUEST_INITIATED_ACCEPTED',
            eventContext: { friendshipList: [mockFriend(1, false), mockFriend(2, true)] }
        };

        const result = tester.testConditionsForStatus(sampleEvent, condition);
        expect(result).to.be.false;
    });

    it('Check friend numbers correctly, fail on dates', () => {
        const startMoment = moment().subtract(1, 'days');
        const condition = [`friends_added_since #{3::${startMoment.valueOf()}}`];

        const sampleEvent = {
            userId: uuid(),
            eventType: 'FRIEND_REQUEST_INITIATED_ACCEPTED',
            eventContext: { friendshipList: [mockFriend(1), mockFriend(2), mockFriend(5)] }
        };

        const result = tester.testConditionsForStatus(sampleEvent, condition);
        expect(result).to.be.false;
    });

    it('Handle total initiated friends correctly', () => {
        const condition = [`total_number_friends #{5::INITIATED}`];

        const sampleEvent = {
            userId: uuid(),
            eventType: 'FRIEND_REQUEST_INITIATED_ACCEPTED',
            eventContext: { friendshipList: [mockFriend(1, true), mockFriend(2, true), mockFriend(5, true), mockFriend(20, true), mockFriend(35, true)] }
        };

        const result = tester.testConditionsForStatus(sampleEvent, condition);
        expect(result).to.be.true;
    });

    it('Fails total initiated friends correctly', () => {
        const condition = ['total_number_friends #{5::INITIATED}'];

        const sampleEvent = {
            userId: uuid(),
            eventType: 'FRIEND_REQUEST_INITIATED_ACCEPTED',
            eventContext: { friendshipList: [mockFriend(1, false), mockFriend(2, false), mockFriend(5, true), mockFriend(20, true), mockFriend(35, true)] }
        };

        const result = tester.testConditionsForStatus(sampleEvent, condition);
        expect(result).to.be.false;
    });

    it('Works on total friends (either) correctly', () => {
        const condition = ['total_number_friends #{5::EITHER}'];

        const sampleEvent = {
            userId: uuid(),
            eventType: 'FRIEND_REQUEST_TARGET_ACCEPTED',
            eventContext: { friendshipList: [mockFriend(1, false), mockFriend(2, false), mockFriend(5, true), mockFriend(20, true), mockFriend(35, true)] }
        };

        const result = tester.testConditionsForStatus(sampleEvent, condition);
        expect(result).to.be.true;
    });

});

describe('*** GAME CONDITIONS ***', () => {

    it('Handles percent destroyed (for image game) properly', () => {
        const condition = ['percent_destroyed_above #{50::10000}'];
        
        const sampleEvent = {
            userId: uuid(),
            eventType: 'USER_GAME_COMPLETION',
            eventContext: { percentDestroyed: 62, timeTakenMillis: 9000 }
        };

        const result = tester.testConditionsForStatus(sampleEvent, condition);
        expect(result).to.be.true;
    });

    it('Handles percent destroyed (for image game) properly', () => {
        const condition = ['percent_destroyed_above #{50::10000}'];
        
        const sampleEvent = {
            userId: uuid(),
            eventType: 'USER_GAME_COMPLETION',
            eventContext: { percentDestroyed: 32, timeTakenMillis: 9000 }
        };

        const result = tester.testConditionsForStatus(sampleEvent, condition);
        expect(result).to.be.false;
    });

    it('Does a tournament for percent destroyed properly', () => {
        const condition = 'percent_destroyed_in_first_N #{1::10000}';

        const mockUserResponseList = [
            { accountId: 'account-id-1', logContext: { percentDestroyed: 20, timeTakenMillis: 10000 } },
            { accountId: 'account-id-2', logContext: { percentDestroyed: 10, timeTakenMillis: 10000 } },
            { accountId: 'account-id-3', logContext: { percentDestroyed: 40, timeTakenMillis: 10000 } }
        ];

        const eventContext = { accountScoreList: mockUserResponseList };

        const eventId1 = { eventType: 'BOOST_EXPIRED', accountId: 'account-id-1', eventContext };
        const result1 = tester.testConditionsForStatus(eventId1, [condition]);

        const eventId3 = { eventType: 'BOOST_EXPIRED', accountId: 'account-id-3', eventContext };
        const result2 = tester.testConditionsForStatus(eventId3, [condition]);

        expect(result1).to.be.false;
        expect(result2).to.be.true;
    });

});

// todo allow it to be from message as well
describe('*** MATCHED BOOST CONDITION ***', () => {

    it('Handles correctly that a save was made from the boost', () => {
        const condition = 'save_tagged_with #{THIS_BOOST}';
        
        const boost = {
            boostId: 'some-boost',
            statusConditions: {
                UNLOCKED: [condition]
            }
        };

        const event = { eventType: 'SAVING_PAYMENT_SUCCESSFUL', eventContext: { transactionTags: ['BOOST::some-boost'] }};
        
        const result = tester.extractStatusChangesMet(event, boost);
        expect(result).to.deep.equal(['UNLOCKED']);
    });

    it('Ignores when a save was made from another boost', () => {
        const condition = 'save_tagged_with #{THIS_BOOST}';
        const eventParameters = { boostId: 'some-boost', eventContext: { transactionTags: ['BOOST::other-boost'] }};

        expect(tester.testConditionsForStatus(eventParameters, [condition])).to.be.false;
    });

});

describe('*** BALANCE MILESTONE CONDITION ***', () => {

    it('Handles correctly when balance crosses major-amount', () => {
        const condition = 'balance_crossed_major_digit #{100::WHOLE_CURRENCY::USD}'; // parameter is minimum

        const sampleEvent = {
            accountId: uuid(),
            eventType: 'SAVING_PAYMENT_SUCCESSFUL',
            eventContext: {
                transactionId: uuid(),
                savedAmount: '50::WHOLE_CURRENCY::USD',
                firstSave: false,
                saveCount: 5,

                preSaveBalance: '70::WHOLE_CURRENCY::USD',
                postSaveBalance: '120::WHOLE_CURRENCY::USD'
            }
        };

        expect(tester.testConditionsForStatus(sampleEvent, [condition])).to.be.true;
    });

    it('Handles correctly when balance crosses a target amount', () => {
        const condition = 'balance_crossed_abs_target #{1000::WHOLE_CURRENCY::EUR}'; // parameter is target (i.e., _any_ crossing will work)

        const sampleEvent = {
            accountId: uuid(),
            eventType: 'SAVING_PAYMENT_SUCCESSFUL',
            eventContext: {
                transactionId: uuid(),
                savedAmount: '200::WHOLE_CURRENCY::EUR',
                firstSave: false,
                saveCount: 5,

                preSaveBalance: '800::WHOLE_CURRENCY::EUR',
                postSaveBalance: '1000::WHOLE_CURRENCY::EUR'
            }
        };

        expect(tester.testConditionsForStatus(sampleEvent, [condition])).to.be.true;        
    });

    it('Still awards even if event contained another boost', () => {
        const condition = 'balance_crossed_abs_target #{600::WHOLE_CURRENCY::USD}'; // parameter is target (i.e., _any_ crossing will work)

        const sampleEvent = {
            accountId: uuid(),
            eventType: 'SAVING_PAYMENT_SUCCESSFUL',
            eventContext: {
                transactionId: uuid(),
                savedAmount: '5::WHOLE_CURRENCY::EUR',
                firstSave: false,
                saveCount: 5,

                preSaveBalance: '5950001::HUNDREDTH_CENT::EUR',
                postSaveBalance: '6000001::HUNDREDTH_CENT::EUR',

                transactionTags: ['BOOST::other-boost']
            }
        };

        expect(tester.testConditionsForStatus(sampleEvent, [condition])).to.be.true;
    });

    it('Does not award if balance was already above target amount', () => {
        const condition = 'balance_crossed_abs_target #{1000::WHOLE_CURRENCY::EUR}'; // parameter is target (i.e., _any_ crossing will work)

        const sampleEvent = {
            accountId: uuid(),
            eventType: 'SAVING_PAYMENT_SUCCESSFUL',
            eventContext: {
                transactionId: uuid(),
                savedAmount: '200::WHOLE_CURRENCY::EUR',
                firstSave: false,
                saveCount: 5,

                preSaveBalance: '1100::WHOLE_CURRENCY::EUR',
                postSaveBalance: '1300::WHOLE_CURRENCY::EUR'
            }
        };

        expect(tester.testConditionsForStatus(sampleEvent, [condition])).to.be.false;
    });

    it('Does not award if balance does not cross amount', () => {
        const condition = 'balance_crossed_abs_target #{1000::WHOLE_CURRENCY::EUR}'; // parameter is target (i.e., _any_ crossing will work)

        const sampleEvent = {
            accountId: uuid(),
            eventType: 'SAVING_PAYMENT_SUCCESSFUL',
            eventContext: {
                transactionId: uuid(),
                savedAmount: '200::WHOLE_CURRENCY::EUR',
                firstSave: false,
                saveCount: 5,

                preSaveBalance: '800::WHOLE_CURRENCY::EUR',
                postSaveBalance: '900::WHOLE_CURRENCY::EUR'
            }
        };

        expect(tester.testConditionsForStatus(sampleEvent, [condition])).to.be.false;
    });

    it('Handles correctly when balance hits major-amount', () => {
        const condition = 'balance_crossed_major_digit #{100::WHOLE_CURRENCY::ZAR}'; // parameter is minimum

        const sampleEvent = {
            accountId: uuid(),
            eventType: 'SAVING_PAYMENT_SUCCESSFUL',
            eventContext: {
                transactionId: uuid(),
                savedAmount: '500000::HUNDREDTH_CENT::ZAR',
                firstSave: false,
                saveCount: 5,

                preSaveBalance: '500000::HUNDREDTH_CENT::ZAR',
                postSaveBalance: '1000000::HUNDREDTH_CENT::ZAR'
            }
        };

        expect(tester.testConditionsForStatus(sampleEvent, [condition])).to.be.true;
    });

    it('Responds false if below minimum', async () => {
        const condition = 'balance_crossed_major_digit #{100::WHOLE_CURRENCY::USD}'; // parameter is minimum

        const sampleEvent = {
            accountId: uuid(),
            eventType: 'SAVING_PAYMENT_SUCCESSFUL',
            eventContext: {
                transactionId: uuid(),
                savedAmount: '5::WHOLE_CURRENCY::USD',
                firstSave: false,
                saveCount: 5,

                preSaveBalance: '70000::HUNDREDTH_CENT::USD',
                postSaveBalance: '120000::HUNDREDTH_CENT::USD'
            }
        };

        expect(tester.testConditionsForStatus(sampleEvent, [condition])).to.be.false;
    });

    it('Responds false if misses next bar', async () => {
        const condition = 'balance_crossed_major_digit #{100::WHOLE_CURRENCY::USD}'; // parameter is minimum

        const sampleEvent = {
            accountId: uuid(),
            eventType: 'SAVING_PAYMENT_SUCCESSFUL',
            eventContext: {
                transactionId: uuid(),
                savedAmount: '50::WHOLE_CURRENCY::USD',
                firstSave: false,
                saveCount: 5,

                preSaveBalance: '120::WHOLE_CURRENCY::USD',
                postSaveBalance: '170::WHOLE_CURRENCY::USD'
            }
        };

        expect(tester.testConditionsForStatus(sampleEvent, [condition])).to.be.false;

    });

});

describe('*** REFERRAL CONDITION ***', () => {
    
    it('Returns true when is correct user', () => {
        const mockReferredUserId = uuid();
        const condition = [`referral_code_used_by_user #{${mockReferredUserId}}`];
        
        const sampleEvent = {
            userId: uuid(),
            eventType: 'REFERRAL_CODE_USED',
            eventContext: { referredUserId: mockReferredUserId }
        };

        const result = tester.testConditionsForStatus(sampleEvent, condition);
        expect(result).to.be.true;
    });

    it('Returns false when different user', () => {
        const mockReferredUserId = uuid();
        const condition = [`referral_code_used_by_user #{${mockReferredUserId}}`];
        
        const sampleEvent = {
            userId: uuid(),
            eventType: 'REFERRAL_CODE_USED',
            eventContext: { referredUserId: 'some-other-user' }
        };

        const result = tester.testConditionsForStatus(sampleEvent, condition);
        expect(result).to.be.false;
    });

    it('Handles correctly when balance crosses major-amount by correct user', () => {
        const balanceCond = 'balance_crossed_major_digit #{100::WHOLE_CURRENCY::USD}'; // parameter is minimum
        const userCond = 'save_completed_by #{referred-user}';

        const sampleEvent = {
            userId: 'referred-user',
            accountId: uuid(),
            eventType: 'SAVING_PAYMENT_SUCCESSFUL',
            eventContext: {
                transactionId: uuid(),
                savedAmount: '50::WHOLE_CURRENCY::USD',
                firstSave: false,
                saveCount: 5,

                preSaveBalance: '70::WHOLE_CURRENCY::USD',
                postSaveBalance: '120::WHOLE_CURRENCY::USD'
            }
        };

        expect(tester.testConditionsForStatus(sampleEvent, [balanceCond, userCond])).to.be.true;

        const referringUserTest = { ...sampleEvent };
        referringUserTest.userId = 'referring-user';
        expect(tester.testConditionsForStatus(referringUserTest, [balanceCond, userCond])).to.be.false;
    });

    it('Withdrawal conditions', () => {
        const timeCond = `withdrawal_before #{${moment().add(1, 'days').valueOf()}}`;
        const userCond = `withdrawal_by #{referred-user}`;

        const sampleEvent = {
            userId: 'referred-user',
            eventType: 'ADMIN_SETTLED_WITHDRAWAL',
            eventContext: {
                timeInMillis: moment().valueOf()
            }
        };

        expect(tester.testConditionsForStatus(sampleEvent, [timeCond, userCond])).to.be.true;

        const referrerEvent = { ...sampleEvent, userId: 'referring-user' };
        expect(tester.testConditionsForStatus(referrerEvent, [timeCond, userCond])).to.be.false;
    });

});

describe('*** LOCKED SAVE CONDITION ***', () => {
    const testTxId = uuid();

    it('Returns true when lock on save expires', async () => {
        const lockExpiryTimeMillis = moment().subtract(12, 'hours').valueOf();
        const condition = [`lock_save_expires #{${testTxId}::${lockExpiryTimeMillis}}`];
        
        const sampleEvent = {
            userId: uuid(),
            eventType: 'LOCK_EXPIRED',
            eventContext: { transactionId: testTxId }
        };

        const result = tester.testConditionsForStatus(sampleEvent, condition);
        expect(result).to.be.true;
    });


    it('Returns false on bad tx id', async () => {
        const lockExpiryTimeMillis = moment().subtract(12, 'hours').valueOf();
        const condition = [`lock_save_expires #{${testTxId}::${lockExpiryTimeMillis}}`];
        
        const sampleEvent = {
            userId: uuid(),
            eventType: 'LOCK_EXPIRED',
            eventContext: { transactionId: uuid() }
        };

        const result = tester.testConditionsForStatus(sampleEvent, condition);
        expect(result).to.be.false;
    });

    it('Returns false where current time is before lock expiry time', async () => {
        const lockExpiryTimeMillis = moment().add(12, 'hours').valueOf();
        const condition = [`lock_save_expires #{${testTxId}::${lockExpiryTimeMillis}}`];
        
        const sampleEvent = {
            userId: uuid(),
            eventType: 'LOCK_EXPIRED',
            eventContext: { transactionId: testTxId }
        };

        const result = tester.testConditionsForStatus(sampleEvent, condition);
        expect(result).to.be.false;
    });
});

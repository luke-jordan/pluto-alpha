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

        const eventContext = { boostId: 'some-boost', tags: ['BOOST::some-boost'] };
    });

    it('Ignores when a save was made from another boost', () => {
        const condition = 'save_tagged_with #{THIS_BOOST}';

        const eventContext = { boostId: 'some-boost', tags: ['BOOST::some-boost'] };
    });

});
